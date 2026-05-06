/**
 * useConnectionManager - Handles gateway connection lifecycle
 *
 * Extracted from App.tsx to separate connection concerns from layout.
 * Manages auto-connect on mount and reconnect logic.
 *
 * On first load, if no session config exists, fetches /api/connect-defaults
 * from the server to pre-fill (and auto-connect with) the configured gateway
 * URL and token. This bridges the server-side .env config to the browser.
 */
import { useState, useCallback, useEffect, useRef } from 'react';
import { useGateway, loadConfig, saveConfig } from '@/contexts/GatewayContext';
import { DEFAULT_GATEWAY_WS } from '@/lib/constants';
import { areGatewayUrlsEquivalent } from '@/lib/gatewayUrls';

export interface ConnectionManagerState {
  dialogOpen: boolean;
  setDialogOpen: (open: boolean) => void;
  editableUrl: string;
  setEditableUrl: (url: string) => void;
  officialUrl: string | null;
  editableToken: string;
  setEditableToken: (token: string) => void;
  handleConnect: (url: string, token: string) => Promise<void>;
  handleReconnect: () => Promise<void>;
  serverSideAuth: boolean;
}

/** Create an AbortSignal that times out after `ms` milliseconds. */
function timeoutSignal(ms: number): AbortSignal {
  // AbortSignal.timeout() not supported in Safari <16.4
  if (typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

/** Fetch gateway connection defaults from the Nerve server. */
async function fetchConnectDefaults(): Promise<{ wsUrl: string; token: string | null; authEnabled?: boolean; serverSideAuth?: boolean } | null> {
  try {
    const resp = await fetch('/api/connect-defaults', { signal: timeoutSignal(3000) });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
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

export function useConnectionManager(): ConnectionManagerState {
  const { connectionState, connect, disconnect } = useGateway();

  // Keep the cockpit connected automatically. The connect dialog is a
  // recovery fallback, not the default user flow.
  const [dialogOpen, setDialogOpen] = useState(false);

  // Editable connection settings (local state for settings drawer)
  // Lazy initializers avoid re-parsing sessionStorage on every render
  const [editableUrl, setEditableUrl] = useState(() => loadConfig().url || DEFAULT_GATEWAY_WS);
  const [editableToken, setEditableToken] = useState(() => loadConfig().token || '');
  const [serverSideAuth, setServerSideAuth] = useState(false);
  const [officialUrl, setOfficialUrl] = useState<string | null>(null);

  // Track if we've attempted auto-connect to avoid re-running
  const autoConnectAttempted = useRef(false);
  const autoConnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoConnectAttemptRef = useRef(0);

  const clearAutoConnectTimer = useCallback(() => {
    if (autoConnectTimerRef.current) {
      clearTimeout(autoConnectTimerRef.current);
      autoConnectTimerRef.current = null;
    }
  }, []);

  const tryAutoConnect = useCallback(async (url: string, token: string) => {
    clearAutoConnectTimer();
    try {
      saveConfig(url, token);
      await connect(url, token);
      setDialogOpen(false);
      autoConnectAttemptRef.current = 0;
    } catch {
      const attempt = ++autoConnectAttemptRef.current;
      const delay = Math.min(
        (isLoopbackGatewayUrl(url) ? 1000 : 3000) * Math.pow(1.5, attempt - 1),
        isLoopbackGatewayUrl(url) ? 15_000 : 60_000,
      );
      autoConnectTimerRef.current = setTimeout(() => {
        void tryAutoConnect(url, token);
      }, delay);
    }
  }, [clearAutoConnectTimer, connect]);

  /** Connect to the gateway, save config, and close the dialog. */
  const handleConnect = useCallback(async (url: string, token: string) => {
    saveConfig(url, token);
    await connect(url, token);
    setDialogOpen(false);
  }, [connect]);

  // Fetch server defaults (async, can't run in initializer)
  useEffect(() => {
    if (autoConnectAttempted.current) return;
    autoConnectAttempted.current = true;

      const saved = loadConfig();

      // Always fetch defaults once on mount to establish serverSideAuth and officialUrl
      fetchConnectDefaults().then((defaults) => {
        const isServerSideAuth = defaults?.serverSideAuth ?? false;
        setServerSideAuth(isServerSideAuth);

        const savedUrl = saved.url?.trim();
        const officialWsUrl = defaults?.wsUrl?.trim();

        if (officialWsUrl) {
          setOfficialUrl(officialWsUrl);
          // Treat the server-provided gateway as the authoritative default UI target.
        // This lets fresh installs and env-driven reconfiguration win over stale
        // browser storage, while still avoiding an automatic reconnect to a truly
        // different gateway unless the user explicitly confirms by connecting.
        setEditableUrl(officialWsUrl);
      }

      // Only override editableToken if it's currently empty
      if (!saved.token && defaults?.token) {
        setEditableToken(defaults.token);
      }

      if (isServerSideAuth && officialWsUrl) {
        setEditableToken('');
      }

      const targetUrl = officialWsUrl || savedUrl || DEFAULT_GATEWAY_WS;
      const targetToken = isServerSideAuth && officialWsUrl
        ? ''
        : (saved.token?.trim() || defaults?.token?.trim() || '');

      if (targetUrl) {
        setDialogOpen(false);
        void tryAutoConnect(targetUrl, targetToken);
      }
    });
    return () => clearAutoConnectTimer();
  }, [clearAutoConnectTimer, tryAutoConnect]);

  const handleReconnect = useCallback(async () => {
    // Don't reconnect if already connecting
    if (connectionState === 'connecting' || connectionState === 'reconnecting') {
      return;
    }

    const isOfficialUrl = areGatewayUrlsEquivalent(editableUrl, officialUrl);
    if (editableUrl && (editableToken || (serverSideAuth && isOfficialUrl))) {
      // Force empty token if server side auth is active for this URL
      const token = serverSideAuth && isOfficialUrl ? '' : editableToken;
      if (token !== editableToken) {
        setEditableToken('');
      }
      const targetUrl = isOfficialUrl && officialUrl ? officialUrl.trim() : editableUrl.trim();
      if (targetUrl !== editableUrl) {
        setEditableUrl(targetUrl);
      }

      // Save the new config first
      saveConfig(targetUrl, token);
      // Disconnect cleanly, then reconnect
      disconnect();
      // Small delay to ensure clean disconnect
      await new Promise(r => setTimeout(r, 100));
      try {
        await tryAutoConnect(targetUrl, token);
      } catch {
        // Connection failed - don't loop, just stay disconnected
      }
    } else {
      setDialogOpen(false);
    }
  }, [clearAutoConnectTimer, connectionState, disconnect, editableToken, editableUrl, officialUrl, serverSideAuth, tryAutoConnect]);

  return {
    dialogOpen,
    setDialogOpen,
    editableUrl,
    setEditableUrl,
    officialUrl,
    editableToken,
    setEditableToken,
    handleConnect,
    handleReconnect,
    serverSideAuth,
  };
}
