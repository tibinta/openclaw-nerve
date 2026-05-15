import { useRef, useCallback, useState, useEffect } from 'react';
import type { GatewayMessage, GatewayEvent, GatewayResponse } from '@/types';

type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

interface PendingReq {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

interface UseWebSocketReturn {
  connectionState: ConnectionState;
  connect: (url: string, token: string) => Promise<void>;
  disconnect: () => void;
  rpc: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  onEvent: React.MutableRefObject<((msg: GatewayEvent) => void) | null>;
  connectError: string;
  reconnectAttempt: number;
}

// Slow the retry curve when the gateway is congested so reconnects do not
// keep hammering the handshake path while the server is already saturated.
const RECONNECT_BASE_DELAY = 5000;
const RECONNECT_MAX_DELAY = 120000;
// Local loopback should recover faster so the UI does not sit in a noisy
// reconnect banner while the gateway is bouncing on the same machine.
const LOCALHOST_RECONNECT_BASE_DELAY = 1000;
const LOCALHOST_RECONNECT_MAX_DELAY = 15000;
const INSTANCE_ID_STORAGE_KEY = 'oc-webchat-instance-id';
const DEFAULT_RPC_TIMEOUT_MS = 30_000;
const CONNECT_TIMEOUT_MS = 6_000;
const HANDSHAKE_FAILURES_BEFORE_COOLDOWN = 3;
const HANDSHAKE_FAILURE_COOLDOWN_MS = 15_000;
const METHOD_RPC_TIMEOUT_MS: Record<string, number> = {
  'chat.history': 12_000,
  'sessions.list': 12_000,
  'node.list': 12_000,
  status: 12_000,
};

function generateInstanceId(): string {
  return crypto.randomUUID ? crypto.randomUUID() : `inst-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function getOrCreateInstanceId(): string {
  const fallback = generateInstanceId();
  if (typeof window === 'undefined') return fallback;

  try {
    const existing = window.sessionStorage.getItem(INSTANCE_ID_STORAGE_KEY);
    if (existing) return existing;

    window.sessionStorage.setItem(INSTANCE_ID_STORAGE_KEY, fallback);
    return fallback;
  } catch {
    return fallback;
  }
}

function isLoopbackGatewayUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname === 'localhost'
      || parsed.hostname === '127.0.0.1'
      || parsed.hostname === '::1'
      || parsed.hostname.startsWith('127.');
  } catch {
    return false;
  }
}

/**
 * Low-level WebSocket hook for the OpenClaw gateway protocol.
 *
 * Handles connection (with challenge/auth handshake), JSON-RPC requests
 * with timeouts, event dispatch, and automatic reconnection with
 * exponential backoff + jitter.
 *
 * WebSocket traffic is proxied through Nerve's `/ws` endpoint so the
 * client works behind reverse proxies and HTTPS termination.
 */
export function useWebSocket(): UseWebSocketReturn {
  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected');
  const [connectError, setConnectError] = useState('');
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);
  const reqIdRef = useRef(0);
  const pendingRef = useRef<Record<string, PendingReq>>({});
  const timeoutsRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const connectReqIdRef = useRef<string | null>(null);
  const connectResolveRef = useRef<(() => void) | null>(null);
  const connectRejectRef = useRef<((e: Error) => void) | null>(null);
  const connectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onEvent = useRef<((msg: GatewayEvent) => void) | null>(null);
  
  // Auto-reconnect state
  const credentialsRef = useRef<{ url: string; token: string } | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);
  const intentionalDisconnectRef = useRef(false);
  const hasConnectedRef = useRef(false);
  const doConnectRef = useRef<((url: string, token: string, isReconnect: boolean) => Promise<void>) | null>(null);
  const instanceIdRef = useRef(getOrCreateInstanceId());
  const connectionGenRef = useRef(0);
  const reconnectDelayProfileRef = useRef({
    base: RECONNECT_BASE_DELAY,
    max: RECONNECT_MAX_DELAY,
  });
  const connectInFlightRef = useRef<{
    key: string;
    promise: Promise<void>;
  } | null>(null);
  const handshakeFailureStreakRef = useRef(0);

  const rejectPending = useCallback((reason: Error) => {
    const pending = pendingRef.current;
    for (const id of Object.keys(pending)) {
      pending[id].reject(reason);
      delete pending[id];
    }
    const timeouts = timeoutsRef.current;
    for (const id of Object.keys(timeouts)) {
      clearTimeout(timeouts[id]);
      delete timeouts[id];
    }
  }, []);

  const clearReconnectTimeout = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
  }, []);

  const clearConnectTimeout = useCallback(() => {
    if (connectTimeoutRef.current) {
      clearTimeout(connectTimeoutRef.current);
      connectTimeoutRef.current = null;
    }
  }, []);

  const rpc = useCallback((method: string, params: Record<string, unknown> = {}): Promise<unknown> => {
    return new Promise((resolve, reject) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== 1) return reject(new Error('Not connected'));
      const id = String(++reqIdRef.current);
      pendingRef.current[id] = { resolve, reject };
      ws.send(JSON.stringify({ type: 'req', id, method, params }));
      const timeoutMs = METHOD_RPC_TIMEOUT_MS[method] ?? DEFAULT_RPC_TIMEOUT_MS;
      const timeoutId = setTimeout(() => {
        if (pendingRef.current[id]) {
          delete pendingRef.current[id];
          if (timeoutsRef.current[id]) delete timeoutsRef.current[id];
          reject(new Error(`Timeout after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      timeoutsRef.current[id] = timeoutId;
    });
  }, []);

  const scheduleReconnect = useCallback((minDelayMs = 0) => {
    const creds = credentialsRef.current;
    if (intentionalDisconnectRef.current || !creds) {
      setConnectionState('disconnected');
      return;
    }

    const attempt = ++reconnectAttemptRef.current;
    setReconnectAttempt(attempt);
    const { base, max } = reconnectDelayProfileRef.current;
    const delay = Math.max(
      minDelayMs,
      Math.min(
        base * Math.pow(1.5, attempt - 1) + Math.random() * 500,
        max,
      ),
    );

    console.debug(`[WS] Reconnecting in ${Math.round(delay)}ms (attempt ${attempt})`);
    setConnectionState('reconnecting');

    reconnectTimeoutRef.current = setTimeout(() => {
      const latestCreds = credentialsRef.current;
      if (latestCreds && !intentionalDisconnectRef.current && doConnectRef.current) {
        doConnectRef.current(latestCreds.url, latestCreds.token, true).catch(() => {
          // The close handler owns retry scheduling so failed reconnect attempts do not stack timers.
        });
      }
    }, delay);
  }, []);

  const doConnect = useCallback((url: string, token: string, isReconnect: boolean): Promise<void> => {
    return new Promise((resolve, reject) => {
      const gen = ++connectionGenRef.current;
      reconnectDelayProfileRef.current = isLoopbackGatewayUrl(url)
        ? { base: LOCALHOST_RECONNECT_BASE_DELAY, max: LOCALHOST_RECONNECT_MAX_DELAY }
        : { base: RECONNECT_BASE_DELAY, max: RECONNECT_MAX_DELAY };
      if (!isReconnect) {
        setConnectError('');
      }
      if (wsRef.current) { wsRef.current.close(); wsRef.current = null; }
      rejectPending(new Error('Disconnected'));
      clearConnectTimeout();
      connectReqIdRef.current = null;
      connectResolveRef.current = resolve;
      connectRejectRef.current = reject;

      setConnectionState(isReconnect ? 'reconnecting' : 'connecting');

      let ws: WebSocket;
      try {
        // Always proxy WebSocket through Nerve's /ws endpoint.
        // This ensures the connection works regardless of how the user
        // accesses Nerve (direct, SSH tunnel, reverse proxy, HTTPS).
        // The server-side proxy handles Origin headers and auth.
        let wsUrl = url;
        const proxyProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const proxyBase = `${proxyProtocol}//${window.location.host}/ws`;
        wsUrl = `${proxyBase}?target=${encodeURIComponent(url)}`;
        ws = new WebSocket(wsUrl);
      } catch (e: unknown) {
        const errMsg = e instanceof Error ? e.message : String(e);
        setConnectError('Invalid URL: ' + errMsg);
        setConnectionState('disconnected');
        reject(e);
        return;
      }
      wsRef.current = ws;

      connectTimeoutRef.current = setTimeout(() => {
        if (gen !== connectionGenRef.current || wsRef.current !== ws) return;
        const err = new Error(`Gateway connect timed out after ${CONNECT_TIMEOUT_MS}ms`);
        setConnectError('Gateway did not answer');
        connectRejectRef.current?.(err);
        connectResolveRef.current = null;
        connectRejectRef.current = null;
        connectReqIdRef.current = null;
        if (wsRef.current === ws) {
          ws.close();
        }
      }, CONNECT_TIMEOUT_MS);

      ws.onopen = () => {
        setConnectionState(isReconnect ? 'reconnecting' : 'connecting');
      };

      ws.onmessage = (ev) => {
        let msg: GatewayMessage;
        try { msg = JSON.parse(ev.data) as GatewayMessage; } catch { return; }

        if (msg.type === 'event' && msg.event === 'connect.challenge') {
          const id = String(++reqIdRef.current);
          connectReqIdRef.current = id;
          ws.send(JSON.stringify({
            type: 'req', id, method: 'connect',
            params: {
              // OpenClaw 2026.5.12 requires protocol 4. Keeping this explicit
              // prevents stale Nerve clients from retrying a doomed handshake.
              minProtocol: 4, maxProtocol: 4,
              client: {
                id: 'openclaw-control-ui',
                version: '0.1.0',
                platform: 'web',
                mode: 'webchat',
                instanceId: instanceIdRef.current,
              },
              role: 'operator',
              scopes: ['operator.admin', 'operator.read', 'operator.write', 'operator.approvals', 'operator.pairing'],
              auth: { token },
              caps: ['tool-events']
            }
          }));
          onEvent.current?.(msg);
          return;
        }

        if (msg.type === 'res') {
          const response = msg as GatewayResponse;
          if (response.id === connectReqIdRef.current) {
            connectReqIdRef.current = null;
            if (response.ok) {
              clearConnectTimeout();
              // Success! Reset reconnect counter
              reconnectAttemptRef.current = 0;
              handshakeFailureStreakRef.current = 0;
              hasConnectedRef.current = true;
              setReconnectAttempt(0);
              setConnectError('');
              setConnectionState('connected');
              connectResolveRef.current?.();
              connectResolveRef.current = null;
              connectRejectRef.current = null;
            } else {
              const errMsg = 'Auth failed: ' + (response.error?.message || 'unknown');
              setConnectError(errMsg);
              setConnectionState('disconnected');
              clearConnectTimeout();
              // Treat auth failures during reconnect like transient failures so the
              // socket keeps retrying instead of getting stuck until a manual reload.
              ws.close();
              connectRejectRef.current?.(new Error(errMsg));
              connectResolveRef.current = null;
              connectRejectRef.current = null;
            }
            return;
          }
          const p = pendingRef.current[response.id];
          if (p) {
            delete pendingRef.current[response.id];
            const timeoutId = timeoutsRef.current[response.id];
            if (timeoutId) {
              clearTimeout(timeoutId);
              delete timeoutsRef.current[response.id];
            }
            if (response.ok) p.resolve(response.payload);
            else p.reject(new Error(response.error?.message || 'request failed'));
          }
          return;
        }

        if (msg.type === 'event') {
          onEvent.current?.(msg as GatewayEvent);
        }
      };

      ws.onerror = () => {
        // Don't set error message during reconnect attempts (too noisy)
        if (!isReconnect) {
          setConnectError('WebSocket error — check URL');
        }
      };

      ws.onclose = (event) => {
        // Stale connection: a newer doConnect has already superseded this one
        if (gen !== connectionGenRef.current) return;
        clearConnectTimeout();

        // A close before the connect response should fail the connect promise
        // immediately instead of leaving the caller stuck in "connecting".
        // If this close happens while connect handshake hasn't completed,
        // reject the connect promise so callers can settle and let the
        // reconnect scheduler own the retry policy.
        const closedBeforeConnect = Boolean(connectRejectRef.current) && !intentionalDisconnectRef.current;
        if (closedBeforeConnect) {
          connectRejectRef.current?.(new Error('Gateway connection closed before connect completed'));
        }
        connectResolveRef.current = null;
        connectRejectRef.current = null;
        connectReqIdRef.current = null;

        rejectPending(new Error('WebSocket disconnected'));
        wsRef.current = null;

        let minReconnectDelayMs = 0;
        if (closedBeforeConnect || event.code === 1013) {
          handshakeFailureStreakRef.current += 1;
          // Gateway busy closes usually mean OpenClaw is CPU-bound. After a few
          // quick failures, cool down so Nerve preserves the last good screen
          // instead of opening more handshakes into a saturated gateway.
          if (handshakeFailureStreakRef.current >= HANDSHAKE_FAILURES_BEFORE_COOLDOWN) {
            minReconnectDelayMs = HANDSHAKE_FAILURE_COOLDOWN_MS;
          }
        } else {
          handshakeFailureStreakRef.current = 0;
        }

        // First-connect stalls are recoverable too; keep trying while the user
        // still has credentials saved instead of leaving the UI stuck on Load failed.
        scheduleReconnect(minReconnectDelayMs);
      };
    });
  }, [rejectPending, scheduleReconnect, clearConnectTimeout]);
  
  // Store doConnect in ref so it can reference itself for reconnection
  useEffect(() => {
    doConnectRef.current = doConnect;
  }, [doConnect]);

  // Cleanup reconnect timeout and WebSocket on unmount
  useEffect(() => {
    return () => {
      clearReconnectTimeout();
      clearConnectTimeout();
      if (wsRef.current) {
        intentionalDisconnectRef.current = true; // prevent reconnect on cleanup close
        wsRef.current.close();
        wsRef.current = null;
      }
      rejectPending(new Error('Component unmounted'));
    };
  }, [clearReconnectTimeout, rejectPending]);

  const disconnect = useCallback(() => {
    intentionalDisconnectRef.current = true;
    clearReconnectTimeout();
    clearConnectTimeout();
    reconnectAttemptRef.current = 0;
    setReconnectAttempt(0);
    credentialsRef.current = null;
    connectResolveRef.current = null;
    connectRejectRef.current = null;
    connectReqIdRef.current = null;
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    rejectPending(new Error('Disconnected'));
    setConnectionState('disconnected');
  }, [rejectPending, clearReconnectTimeout, clearConnectTimeout]);

  const connect = useCallback((url: string, token: string): Promise<void> => {
    const normalizedUrl = url.trim();
    const normalizedToken = token.trim();
    const key = `${normalizedUrl}|||${normalizedToken}`;

    if (connectInFlightRef.current?.key === key) {
      return connectInFlightRef.current.promise;
    }

    // Store credentials for reconnection
    credentialsRef.current = { url: normalizedUrl, token: normalizedToken };
    intentionalDisconnectRef.current = false;
    clearReconnectTimeout();
    reconnectAttemptRef.current = 0;
    setReconnectAttempt(0);

    const doConnectPromise = doConnect(normalizedUrl, normalizedToken, false);
    const promise = doConnectPromise.finally(() => {
      if (connectInFlightRef.current?.key === key) {
        connectInFlightRef.current = null;
      }
    });
    connectInFlightRef.current = { key, promise };
    return promise;
  }, [doConnect, clearReconnectTimeout]);

  return { connectionState, connect, disconnect, rpc, onEvent, connectError, reconnectAttempt };
}
