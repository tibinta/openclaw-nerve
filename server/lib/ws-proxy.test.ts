/** Tests for ws-proxy — connection, relaying, auth, and lifecycle. */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { createServer, type Server } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { MockGateway } from '../../src/test/mock-gateway.js';

// Mock config before importing ws-proxy
vi.mock('./config.js', () => {
  const WS_ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
  return {
    config: {
      auth: false,
      host: '127.0.0.1',
      port: 3080,
      sslPort: 3443,
      sessionSecret: 'test-secret',
      gatewayToken: 'test-token',
      gatewayUrl: 'ws://127.0.0.1:1',
      janeMobileBridgeToken: 'bridge-secret',
      sessionsDir: '/tmp/openclaw-nerve-ws-proxy-test-sessions',
    },
    WS_ALLOWED_HOSTS,
    SESSION_COOKIE_NAME: 'nerve_session_3080',
  };
});

vi.mock('./session.js', () => ({
  verifySession: vi.fn(),
  parseSessionCookie: vi.fn(),
}));

vi.mock('./device-identity.js', () => ({
  getDeviceIdentity: vi.fn(() => ({
    deviceId: 'mock-device-id-' + '0'.repeat(48),
    publicKeyRaw: Buffer.alloc(32),
    publicKeyB64url: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    privateKeyPem: '',
  })),
  createDeviceBlock: vi.fn(() => ({
    id: 'mock-device-id-' + '0'.repeat(48),
    publicKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    signature: 'mock-signature',
    signedAt: Date.now(),
    nonce: 'test-nonce',
  })),
}));

vi.mock('./openclaw-bin.js', () => ({
  resolveOpenclawBin: vi.fn(() => '/usr/bin/echo'),
}));

import { setupWebSocketProxy, closeAllWebSockets, _internals, isLegacyJaneWriteRequest } from './ws-proxy.js';

describe('legacy Jane history write guard', () => {
  it('allows history reads and rejects writes to old Jane sessions', () => {
    expect(isLegacyJaneWriteRequest({ type: 'req', id: 'read', method: 'chat.history', params: { sessionKey: 'agent:jane-whitmore---ceo:main' } })).toBe(false);
    expect(isLegacyJaneWriteRequest({ type: 'req', id: 'send', method: 'chat.send', params: { sessionKey: 'agent:jane-whitmore---ceo:main' } })).toBe(true);
    expect(isLegacyJaneWriteRequest({ type: 'req', id: 'reset', method: 'sessions.reset', params: { key: 'agent:jane-whitmore---ceo:main' } })).toBe(true);
    expect(isLegacyJaneWriteRequest({ type: 'req', id: 'new', method: 'chat.send', params: { sessionKey: 'agent:main:main' } })).toBe(false);
  });
});
import { config } from './config.js';
import { verifySession, parseSessionCookie } from './session.js';
import { createDeviceBlock } from './device-identity.js';
import { createServer as createHttpServer } from 'node:http';

const mockedConfig = config as {
  auth: boolean;
  sessionSecret: string;
  gatewayUrl: string;
  janeMobileBridgeToken: string;
};
const mockedVerifySession = verifySession as ReturnType<typeof vi.fn>;
const mockedParseSessionCookie = parseSessionCookie as ReturnType<typeof vi.fn>;

function waitForMessage(ws: WebSocket, timeoutMs = 3000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WS message timeout')), timeoutMs);
    ws.once('message', (data) => {
      clearTimeout(timer);
      resolve(data.toString());
    });
  });
}

function waitForClose(ws: WebSocket, timeoutMs = 3000): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WS close timeout')), timeoutMs);
    ws.once('close', (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString() });
    });
  });
}

/** Wait for close or error — useful when server rejects the upgrade entirely */
function waitForCloseOrError(ws: WebSocket, timeoutMs = 3000): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WS close/error timeout')), timeoutMs);
    const done = (code: number, reason: string) => {
      clearTimeout(timer);
      resolve({ code, reason });
    };
    ws.once('close', (code, reason) => done(code, reason.toString()));
    ws.once('error', (err) => {
      // ws library throws errors for HTTP rejection or socket destruction
      done(1006, err.message);
    });
  });
}

async function waitForCondition(assertion: () => Promise<boolean> | boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await assertion()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('condition timed out');
}

describe('ws-proxy', () => {
  let mockGw: MockGateway;
  let proxyServer: Server;
  let proxyPort: number;

  beforeAll(async () => {
    mockGw = new MockGateway();
    await mockGw.start();
  });

  afterAll(async () => {
    closeAllWebSockets();
    await mockGw.close();
  });

  beforeEach(async () => {
    mockedConfig.auth = false;
    mockedVerifySession.mockReset();
    mockedParseSessionCookie.mockReset();
    mockGw.clearReceived();
    await fs.rm(config.sessionsDir, { recursive: true, force: true });
    await fs.mkdir(config.sessionsDir, { recursive: true });

    // Create a new HTTP server and attach ws-proxy
    proxyServer = createServer();
    setupWebSocketProxy(proxyServer);

    await new Promise<void>((resolve) => {
      proxyServer.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = proxyServer.address();
    proxyPort = typeof addr === 'object' && addr ? addr.port : 0;
  });

  afterEach(async () => {
    closeAllWebSockets();
    await new Promise<void>((resolve) => {
      proxyServer.close(() => resolve());
    });
    await fs.rm(config.sessionsDir, { recursive: true, force: true });
  });

  describe('connection establishment', () => {
    it('rejects connections without ?target param', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${proxyPort}/ws`);
      const { code, reason } = await waitForClose(ws);
      expect(code).toBe(1008);
      expect(reason).toContain('Missing');
    });

    it('rejects connections with invalid target URL', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${proxyPort}/ws?target=not-a-url`);
      const { code } = await waitForClose(ws);
      expect(code).toBe(1008);
    });

    it('rejects connections with disallowed host', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${proxyPort}/ws?target=ws://evil.com:9999`);
      const { code, reason } = await waitForClose(ws);
      expect(code).toBe(1008);
      expect(reason).toContain('not allowed');
    });

    it('allows root path for gateway target', async () => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${proxyPort}/ws?target=${encodeURIComponent(mockGw.url)}`,
      );
      const msg = await waitForMessage(ws);
      const parsed = JSON.parse(msg);
      expect(parsed.type).toBe('event');
      expect(parsed.event).toBe('connect.challenge');
      ws.close();
    });

    it('accepts connections to allowed gateway target', async () => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${proxyPort}/ws?target=${encodeURIComponent(mockGw.url + '/ws')}`,
      );
      // Should receive connect.challenge from mock gateway (relayed through proxy)
      const msg = await waitForMessage(ws);
      const parsed = JSON.parse(msg);
      expect(parsed.type).toBe('event');
      expect(parsed.event).toBe('connect.challenge');
      expect(parsed.payload.nonce).toBeTruthy();
      ws.close();
    });

    it('destroys non-/ws upgrade requests', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${proxyPort}/other`);
      const { code } = await waitForCloseOrError(ws);
      // Socket gets destroyed = abnormal close
      expect(code).toBe(1006);
    });

    it('rejects websocket upgrades from disallowed browser origins', async () => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${proxyPort}/ws?target=${encodeURIComponent(mockGw.url + '/ws')}`,
        { origin: 'https://evil.example' },
      );
      const { code, reason } = await waitForCloseOrError(ws);
      expect(code).toBe(1006);
      expect(reason).toContain('Unexpected server response: 403');
    });
  });

  describe('message relaying', () => {
    it('rejects binary JSON writes to archived Jane without forwarding them', async () => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${proxyPort}/ws?target=${encodeURIComponent(mockGw.url + '/ws')}`,
      );
      expect(JSON.parse(await waitForMessage(ws)).event).toBe('connect.challenge');
      mockGw.clearReceived();

      const response = waitForMessage(ws);
      ws.send(Buffer.from(JSON.stringify({
        type: 'req', id: 'archived-write', method: 'chat.send',
        params: { sessionKey: 'agent:jane-whitmore---ceo:main', message: 'no' },
      })));
      expect(JSON.parse(await response)).toMatchObject({
        type: 'res', id: 'archived-write', ok: false,
        error: { message: 'Legacy Jane history is read-only.' },
      });
      expect(mockGw.received).toEqual([]);
      ws.close();
    });

    it('forwards restricted session mutations for control-ui clients instead of intercepting them', async () => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${proxyPort}/ws?target=${encodeURIComponent(mockGw.url + '/ws')}`,
      );

      const challenge = await waitForMessage(ws);
      expect(JSON.parse(challenge).event).toBe('connect.challenge');

      ws.send(JSON.stringify({
        type: 'req',
        method: 'connect',
        id: 'c-control-1',
        params: { auth: { token: 'test-token' }, client: { id: 'openclaw-control-ui', mode: 'webchat' } },
      }));

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout waiting for connect response')), 5000);
        ws.on('message', (data) => {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.type === 'res' && msg.id === 'c-control-1') {
              clearTimeout(timer);
              resolve();
            }
          } catch { /* ignore */ }
        });
      });

      mockGw.clearReceived();
      ws.send(JSON.stringify({
        type: 'req',
        method: 'sessions.delete',
        id: 'delete-1',
        params: { key: 'agent:main:subagent:test', deleteTranscript: true },
      }));

      await mockGw.expectMessages(1);
      const deleteMsg = mockGw.received.find((m) => {
        const d = m.data as Record<string, unknown>;
        return d.type === 'req' && d.method === 'sessions.delete';
      });
      expect(deleteMsg).toBeTruthy();

      ws.close();
    });

    it('relays gateway messages to client', async () => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${proxyPort}/ws?target=${encodeURIComponent(mockGw.url + '/ws')}`,
      );
      // First message is the connect.challenge
      const challenge = await waitForMessage(ws);
      expect(JSON.parse(challenge).event).toBe('connect.challenge');

      // Gateway broadcasts a custom event
      mockGw.broadcast(JSON.stringify({ type: 'event', event: 'test', payload: { hello: true } }));

      const msg = await waitForMessage(ws);
      const parsed = JSON.parse(msg);
      expect(parsed.type).toBe('event');
      expect(parsed.event).toBe('test');
      expect(parsed.payload.hello).toBe(true);

      ws.close();
    });

    it('relays client messages to gateway', async () => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${proxyPort}/ws?target=${encodeURIComponent(mockGw.url + '/ws')}`,
      );
      await waitForMessage(ws); // consume challenge

      // Send a message from client through proxy
      ws.send(JSON.stringify({ type: 'req', method: 'ping', id: 'p1' }));

      // Wait for it to arrive at the mock gateway
      const msgs = await mockGw.expectMessages(1, 2000);
      const received = msgs[0].data as Record<string, unknown>;
      expect(received.type).toBe('req');
      expect(received.method).toBe('ping');

      ws.close();
    });

    it('bounds control-ui sessions.list requests before forwarding to the gateway', async () => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${proxyPort}/ws?target=${encodeURIComponent(mockGw.url + '/ws')}`,
      );

      const challenge = await waitForMessage(ws);
      expect(JSON.parse(challenge).event).toBe('connect.challenge');

      ws.send(JSON.stringify({
        type: 'req',
        method: 'connect',
        id: 'c-control-bounds',
        params: { auth: { token: 'test-token' }, client: { id: 'openclaw-control-ui', mode: 'webchat' } },
      }));

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout waiting for connect response')), 5000);
        ws.on('message', (data) => {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.type === 'res' && msg.id === 'c-control-bounds') {
              clearTimeout(timer);
              resolve();
            }
          } catch { /* ignore */ }
        });
      });

      mockGw.clearReceived();
      ws.send(JSON.stringify({
        type: 'req',
        method: 'sessions.list',
        id: 'sessions-unbounded',
        params: { limit: 10000 },
      }));

      await mockGw.expectMessages(1);
      const sessionListMsg = mockGw.received.find((m) => {
        const d = m.data as Record<string, unknown>;
        return d.type === 'req' && d.method === 'sessions.list';
      });

      expect(sessionListMsg).toBeTruthy();
      expect((sessionListMsg!.data as Record<string, unknown>).params).toEqual({
        activeMinutes: 10080,
        limit: 200,
      });

      ws.close();
    });

    it('rotates a chat session binding after an invalid encrypted content response', async () => {
      const sessionKey = 'agent:main:imessage:direct:+447494722196';
      const previousSessionId = '026b3a95-9d15-47ba-a3bf-a18f0fa0598e';
      await fs.writeFile(path.join(config.sessionsDir, 'sessions.json'), JSON.stringify({
        [sessionKey]: {
          sessionId: previousSessionId,
          sessionFile: path.join(config.sessionsDir, `${previousSessionId}.jsonl`),
          status: 'failed',
          systemSent: true,
          contextTokens: 42,
          inputTokens: 10,
          outputTokens: 2,
          totalTokens: 54,
        },
      }));
      await fs.writeFile(path.join(config.sessionsDir, `${previousSessionId}.jsonl`), 'failed transcript\n');

      const ws = new WebSocket(
        `ws://127.0.0.1:${proxyPort}/ws?target=${encodeURIComponent(mockGw.url + '/ws')}`,
      );

      await waitForMessage(ws);
      ws.send(JSON.stringify({
        type: 'req',
        method: 'connect',
        id: 'c-recover',
        params: { auth: { token: 'test-token' }, client: { id: 'nerve-ui', mode: 'webchat' } },
      }));
      await waitForCondition(async () => mockGw.received.some((entry) => {
        const data = entry.data as Record<string, unknown>;
        return data.type === 'req' && data.method === 'connect';
      }));

      mockGw.clearReceived();
      ws.send(JSON.stringify({
        type: 'req',
        method: 'chat.send',
        id: 'send-1',
        params: { sessionKey, message: 'hello' },
      }));
      await mockGw.expectMessages(1);

      mockGw.broadcast(JSON.stringify({
        type: 'res',
        id: 'send-1',
        ok: false,
        error: {
          code: 'invalid_encrypted_content',
          message: 'invalid_encrypted_content: encrypted content could not be decrypted or parsed',
        },
      }));

      await waitForCondition(async () => {
        const store = JSON.parse(await fs.readFile(path.join(config.sessionsDir, 'sessions.json'), 'utf-8'));
        return store[sessionKey].sessionId !== previousSessionId;
      });

      const store = JSON.parse(await fs.readFile(path.join(config.sessionsDir, 'sessions.json'), 'utf-8'));
      const rotated = store[sessionKey];
      expect(rotated.sessionId).not.toBe(previousSessionId);
      expect(rotated.status).toBe('waiting');
      expect(rotated.systemSent).toBe(false);
      expect(rotated.contextTokens).toBe(0);
      expect(rotated.lastRecovery).toMatchObject({
        reason: 'rotate_after_invalid_encrypted_content_llm_failures',
        previousSessionId,
      });
      await expect(fs.readFile(path.join(config.sessionsDir, `${previousSessionId}.jsonl`), 'utf-8')).resolves.toBe('failed transcript\n');
      await expect(fs.readFile(path.join(config.sessionsDir, `${rotated.sessionId}.jsonl`), 'utf-8')).resolves.toBe('');

      ws.close();
    });

    it('rotates when invalid encrypted content is embedded in a successful chat response', async () => {
      const sessionKey = 'agent:main:imessage:direct:+447494722196';
      const previousSessionId = '14c6df3a-8e87-420a-a06b-30adf9732b88';
      await fs.writeFile(path.join(config.sessionsDir, 'sessions.json'), JSON.stringify({
        [sessionKey]: {
          sessionId: previousSessionId,
          sessionFile: path.join(config.sessionsDir, `${previousSessionId}.jsonl`),
          status: 'failed',
          systemSent: true,
          contextTokens: 272000,
          inputTokens: 31505,
          outputTokens: 230,
          totalTokens: 303735,
        },
      }));
      await fs.writeFile(path.join(config.sessionsDir, `${previousSessionId}.jsonl`), 'failed transcript\n');

      const ws = new WebSocket(
        `ws://127.0.0.1:${proxyPort}/ws?target=${encodeURIComponent(mockGw.url + '/ws')}`,
      );

      await waitForMessage(ws);
      ws.send(JSON.stringify({
        type: 'req',
        method: 'connect',
        id: 'c-recover-success',
        params: { auth: { token: 'test-token' }, client: { id: 'nerve-ui', mode: 'webchat' } },
      }));
      await waitForCondition(async () => mockGw.received.some((entry) => {
        const data = entry.data as Record<string, unknown>;
        return data.type === 'req' && data.method === 'connect';
      }));

      mockGw.clearReceived();
      ws.send(JSON.stringify({
        type: 'req',
        method: 'chat.send',
        id: 'send-success-error',
        params: { sessionKey, message: 'hello' },
      }));
      await mockGw.expectMessages(1);

      mockGw.broadcast(JSON.stringify({
        type: 'res',
        id: 'send-success-error',
        ok: true,
        result: {
          message: {
            role: 'assistant',
            content: [],
            stopReason: 'error',
            errorMessage: 'invalid_encrypted_content: encrypted content could not be decrypted or parsed',
          },
        },
      }));

      await waitForCondition(async () => {
        const store = JSON.parse(await fs.readFile(path.join(config.sessionsDir, 'sessions.json'), 'utf-8'));
        return store[sessionKey].sessionId !== previousSessionId;
      });

      const store = JSON.parse(await fs.readFile(path.join(config.sessionsDir, 'sessions.json'), 'utf-8'));
      const rotated = store[sessionKey];
      expect(rotated.sessionId).not.toBe(previousSessionId);
      expect(rotated.status).toBe('waiting');
      expect(rotated.systemSent).toBe(false);
      expect(rotated.contextTokens).toBe(0);
      expect(rotated.lastRecovery).toMatchObject({
        reason: 'rotate_after_invalid_encrypted_content_llm_failures',
        previousSessionId,
      });

      ws.close();
    });
  });

  describe('auth enforcement', () => {
    it('rejects WS upgrade when auth is enabled and no cookie', async () => {
      mockedConfig.auth = true;
      mockedParseSessionCookie.mockReturnValue(null);

      const ws = new WebSocket(`ws://127.0.0.1:${proxyPort}/ws?target=${encodeURIComponent(mockGw.url + '/ws')}`);
      const { code } = await waitForCloseOrError(ws);
      // Should get rejected (socket destroyed = 1006 or HTTP 401)
      expect(code).toBe(1006);
    });

    it('rejects WS upgrade when auth is enabled and session is invalid', async () => {
      mockedConfig.auth = true;
      mockedParseSessionCookie.mockReturnValue('bad-token');
      mockedVerifySession.mockReturnValue(null);

      const ws = new WebSocket(`ws://127.0.0.1:${proxyPort}/ws?target=${encodeURIComponent(mockGw.url + '/ws')}`);
      const { code } = await waitForCloseOrError(ws);
      expect(code).toBe(1006);
    });

    it('allows WS upgrade when auth is enabled and session is valid', async () => {
      mockedConfig.auth = true;
      mockedParseSessionCookie.mockReturnValue('good-token');
      mockedVerifySession.mockReturnValue({ exp: Date.now() + 60000, iat: Date.now() });

      const ws = new WebSocket(
        `ws://127.0.0.1:${proxyPort}/ws?target=${encodeURIComponent(mockGw.url + '/ws')}`,
        { headers: { Cookie: 'nerve_session_3080=good-token' } },
      );
      const msg = await waitForMessage(ws);
      expect(JSON.parse(msg).event).toBe('connect.challenge');
      ws.close();
    });
  });

  describe('closeAllWebSockets', () => {
    it('closes all active connections', async () => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${proxyPort}/ws?target=${encodeURIComponent(mockGw.url + '/ws')}`,
      );
      await waitForMessage(ws); // Wait for challenge = connection established

      const closePromise = waitForClose(ws);
      closeAllWebSockets();
      const { code } = await closePromise;
      expect(code).toBe(1001); // Server shutting down
    });
  });

  describe('challenge-nonce timing', () => {
    const mockedCreateDeviceBlock = createDeviceBlock as ReturnType<typeof vi.fn>;

    it('injects gateway token when connect params omit token for authenticated clients', async () => {
      mockedConfig.auth = true;
      mockedParseSessionCookie.mockReturnValue('good-token');
      mockedVerifySession.mockReturnValue({ exp: Date.now() + 60000, iat: Date.now() });
      mockGw.clearReceived();

      const ws = new WebSocket(
        `ws://127.0.0.1:${proxyPort}/ws?target=${encodeURIComponent(mockGw.url + '/ws')}`,
        { headers: { Cookie: 'nerve_session_3080=good-token' } },
      );

      await new Promise<void>((resolve) => ws.on('open', resolve));
      ws.send(JSON.stringify({
        type: 'req',
        method: 'connect',
        id: 'c-token-1',
        params: { client: { id: 'nerve-ui', mode: 'webchat' } },
      }));

      // Wait for connect response
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout waiting for connect response')), 5000);
        ws.on('message', (data) => {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.type === 'res' && msg.id === 'c-token-1') {
              clearTimeout(timer);
              resolve();
            }
          } catch { /* ignore */ }
        });
      });

      const connectMsg = mockGw.received.find((m) => {
        const d = m.data as Record<string, unknown>;
        return d.type === 'req' && d.method === 'connect';
      });
      expect(connectMsg).toBeTruthy();
      const params = (connectMsg!.data as Record<string, unknown>).params as Record<string, unknown>;
      const auth = (params.auth as Record<string, unknown> | undefined) ?? {};
      expect(auth.token).toBe('test-token');

      ws.close();
    });

    it('injects gateway token when connect params provide empty token for authenticated clients', async () => {
      mockedConfig.auth = true;
      mockedParseSessionCookie.mockReturnValue('good-token');
      mockedVerifySession.mockReturnValue({ exp: Date.now() + 60000, iat: Date.now() });
      mockGw.clearReceived();

      const ws = new WebSocket(
        `ws://127.0.0.1:${proxyPort}/ws?target=${encodeURIComponent(mockGw.url + '/ws')}`,
        { headers: { Cookie: 'nerve_session_3080=good-token' } },
      );

      await new Promise<void>((resolve) => ws.on('open', resolve));
      ws.send(JSON.stringify({
        type: 'req',
        method: 'connect',
        id: 'c-token-2',
        params: { auth: { token: '' }, client: { id: 'nerve-ui', mode: 'webchat' } },
      }));

      // Wait for connect response
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout waiting for connect response')), 5000);
        ws.on('message', (data) => {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.type === 'res' && msg.id === 'c-token-2') {
              clearTimeout(timer);
              resolve();
            }
          } catch { /* ignore */ }
        });
      });

      const connectMsg = mockGw.received.find((m) => {
        const d = m.data as Record<string, unknown>;
        return d.type === 'req' && d.method === 'connect';
      });
      expect(connectMsg).toBeTruthy();
      const params = (connectMsg!.data as Record<string, unknown>).params as Record<string, unknown>;
      const auth = (params.auth as Record<string, unknown> | undefined) ?? {};
      expect(auth.token).toBe('test-token');

      ws.close();
    });

    it('injects device identity when connect is buffered before gateway opens', async () => {
      mockGw.clearReceived();

      const ws = new WebSocket(
        `ws://127.0.0.1:${proxyPort}/ws?target=${encodeURIComponent(mockGw.url + '/ws')}`,
      );

      // Wait for WS to open to the proxy, then send connect immediately
      // (will be buffered because gateway relay isn't open yet or just opened)
      await new Promise<void>((resolve) => ws.on('open', resolve));
      ws.send(JSON.stringify({
        type: 'req',
        method: 'connect',
        id: 'c1',
        params: { auth: { token: 'test-token' }, client: { id: 'nerve-ui', mode: 'webchat', platform: 'web' } },
      }));

      // Wait for the connect response from mock gateway
      const messages: string[] = [];
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout waiting for connect response')), 5000);
        ws.on('message', (data) => {
          messages.push(data.toString());
          try {
            const msg = JSON.parse(data.toString());
            if (msg.type === 'res' && msg.id === 'c1') {
              clearTimeout(timer);
              resolve();
            }
          } catch { /* ignore */ }
        });
      });

      // Verify the gateway received a connect message WITH device identity
      const connectMsg = mockGw.received.find((m) => {
        const d = m.data as Record<string, unknown>;
        return d.type === 'req' && d.method === 'connect';
      });
      expect(connectMsg).toBeTruthy();
      const params = (connectMsg!.data as Record<string, unknown>).params as Record<string, unknown>;
      expect(params.device).toBeTruthy();
      expect((params.device as Record<string, unknown>).id).toMatch(/^mock-device-id/);
      expect((params.client as Record<string, unknown>).platform).toBe('server');

      ws.close();
    });

    it('waits for challenge nonce before sending connect (not flushed early)', async () => {
      mockGw.clearReceived();
      mockedCreateDeviceBlock.mockClear();

      const ws = new WebSocket(
        `ws://127.0.0.1:${proxyPort}/ws?target=${encodeURIComponent(mockGw.url + '/ws')}`,
      );
      await new Promise<void>((resolve) => ws.on('open', resolve));

      // Send connect
      ws.send(JSON.stringify({
        type: 'req',
        method: 'connect',
        id: 'c2',
        params: { auth: { token: 'test-token' }, client: { id: 'nerve-ui', mode: 'webchat' } },
      }));

      // Wait for the connect response
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout')), 5000);
        ws.on('message', (data) => {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.type === 'res' && msg.id === 'c2') {
              clearTimeout(timer);
              resolve();
            }
          } catch { /* ignore */ }
        });
      });

      // createDeviceBlock should have been called (identity was injected)
      expect(mockedCreateDeviceBlock).toHaveBeenCalled();

      ws.close();
    });

    it('sends connect without device identity on challenge timeout', async () => {
      const originalTimeout = _internals.challengeTimeoutMs;
      _internals.challengeTimeoutMs = 200; // Short timeout for testing

      // Create a minimal gateway that never sends a challenge
      const ncServer = createHttpServer();
      const ncWss = new WebSocketServer({ server: ncServer });
      const ncReceived: unknown[] = [];

      ncWss.on('connection', (ncWs: WebSocket) => {
        // Intentionally do NOT send connect.challenge
        ncWs.on('message', (data: Buffer | string) => {
          const raw = data.toString();
          try {
            const parsed = JSON.parse(raw);
            ncReceived.push(parsed);
            // Respond to connect
            if (parsed.type === 'req' && parsed.method === 'connect') {
              ncWs.send(JSON.stringify({
                type: 'res',
                id: parsed.id,
                ok: true,
                payload: { session: { id: 'test' }, scopes: ['operator.read'] },
              }));
            }
          } catch { ncReceived.push(raw); }
        });
      });

      await new Promise<void>((resolve) => {
        ncServer.listen(0, '127.0.0.1', () => resolve());
      });
      const addr = ncServer.address();
      const ncPort = typeof addr === 'object' && addr ? addr.port : 0;

      try {
        const ws = new WebSocket(
          `ws://127.0.0.1:${proxyPort}/ws?target=${encodeURIComponent(`ws://127.0.0.1:${ncPort}`)}`,
        );
        await new Promise<void>((resolve) => ws.on('open', resolve));

        ws.send(JSON.stringify({
          type: 'req',
          method: 'connect',
          id: 'c3',
          params: { auth: { token: 'test-token' }, client: { id: 'nerve-ui' } },
        }));

        // Wait for the connect response (arrives after 200ms timeout fires)
        const response = await waitForMessage(ws, 5000);
        const parsed = JSON.parse(response);
        expect(parsed.type).toBe('res');
        expect(parsed.id).toBe('c3');
        expect(parsed.ok).toBe(true);

        // Verify gateway received connect WITHOUT device block (timeout degradation)
        const connectMsg = ncReceived.find(
          (m: unknown) => (m as Record<string, unknown>).type === 'req' && (m as Record<string, unknown>).method === 'connect',
        ) as Record<string, unknown> | undefined;
        expect(connectMsg).toBeTruthy();
        expect((connectMsg!.params as Record<string, unknown>).device).toBeUndefined();

        ws.close();
      } finally {
        ncWss.close();
        await new Promise<void>((resolve) => ncServer.close(() => resolve()));
        _internals.challengeTimeoutMs = originalTimeout;
      }
    });

    it('preserves non-connect messages in pending buffer during nonce wait', async () => {
      mockGw.clearReceived();

      const ws = new WebSocket(
        `ws://127.0.0.1:${proxyPort}/ws?target=${encodeURIComponent(mockGw.url + '/ws')}`,
      );
      await new Promise<void>((resolve) => ws.on('open', resolve));

      // Send a non-connect message first, then connect
      ws.send(JSON.stringify({ type: 'req', method: 'ping', id: 'p1' }));
      ws.send(JSON.stringify({
        type: 'req',
        method: 'connect',
        id: 'c4',
        params: { auth: { token: 'test-token' }, client: { id: 'nerve-ui' } },
      }));

      // Wait for the connect response
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout')), 5000);
        ws.on('message', (data) => {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.type === 'res' && msg.id === 'c4') {
              clearTimeout(timer);
              resolve();
            }
          } catch { /* ignore */ }
        });
      });

      // Both ping and connect should have reached the gateway
      const allMsgs = mockGw.received;
      const pingMsg = allMsgs.find((m) => (m.data as Record<string, unknown>).method === 'ping');
      const connectMsg = allMsgs.find((m) => (m.data as Record<string, unknown>).method === 'connect');
      expect(pingMsg).toBeTruthy();
      expect(connectMsg).toBeTruthy();

      ws.close();
    });

    it('dispatches deferred connect before queued non-connect messages', async () => {
      // Gateway that delays connect.challenge to force nonce-wait buffering
      const delayedServer = createHttpServer();
      const delayedWss = new WebSocketServer({ server: delayedServer });
      const requestOrder: string[] = [];

      delayedWss.on('connection', (delayedWs: WebSocket) => {
        setTimeout(() => {
          delayedWs.send(JSON.stringify({
            type: 'event',
            event: 'connect.challenge',
            payload: { nonce: 'late-nonce' },
          }));
        }, 120);

        delayedWs.on('message', (data: Buffer | string) => {
          try {
            const parsed = JSON.parse(data.toString());
            if (parsed.type === 'req' && typeof parsed.method === 'string') {
              requestOrder.push(parsed.method);
              if (parsed.id) {
                delayedWs.send(JSON.stringify({
                  type: 'res',
                  id: parsed.id,
                  ok: true,
                  payload: {},
                }));
              }
            }
          } catch { /* ignore */ }
        });
      });

      await new Promise<void>((resolve) => {
        delayedServer.listen(0, '127.0.0.1', () => resolve());
      });
      const addr = delayedServer.address();
      const delayedPort = typeof addr === 'object' && addr ? addr.port : 0;

      try {
        const ws = new WebSocket(
          `ws://127.0.0.1:${proxyPort}/ws?target=${encodeURIComponent(`ws://127.0.0.1:${delayedPort}`)}`,
        );
        await new Promise<void>((resolve) => ws.on('open', resolve));

        // Connect should be deferred until challenge; ping must remain queued behind it.
        ws.send(JSON.stringify({
          type: 'req',
          method: 'connect',
          id: 'c5',
          params: { auth: { token: 'test-token' }, client: { id: 'nerve-ui' } },
        }));
        ws.send(JSON.stringify({ type: 'req', method: 'ping', id: 'p5' }));

        // Wait until ping response confirms both requests were forwarded.
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('timeout waiting for ping response')), 5000);
          ws.on('message', (data) => {
            try {
              const msg = JSON.parse(data.toString());
              if (msg.type === 'res' && msg.id === 'p5') {
                clearTimeout(timer);
                resolve();
              }
            } catch { /* ignore */ }
          });
        });

        const connectIndex = requestOrder.indexOf('connect');
        const pingIndex = requestOrder.indexOf('ping');
        expect(connectIndex).toBeGreaterThanOrEqual(0);
        expect(pingIndex).toBeGreaterThanOrEqual(0);
        expect(connectIndex).toBeLessThan(pingIndex);

        ws.close();
      } finally {
        delayedWss.close();
        await new Promise<void>((resolve) => delayedServer.close(() => resolve()));
      }
    });

    it('denies token injection for external users behind a local reverse proxy', async () => {
      mockGw.clearReceived();

      const ws = new WebSocket(
        `ws://127.0.0.1:${proxyPort}/ws?target=${encodeURIComponent(mockGw.url + '/ws')}`,
        {
          headers: {
            // Spoof/forward an external IP. Since the direct connection is 127.0.0.1,
            // the proxy will resolve the client IP to this external address.
            'X-Forwarded-For': '203.0.113.5',
          },
        },
      );

      await new Promise<void>((resolve) => ws.on('open', resolve));
      ws.send(JSON.stringify({
        type: 'req',
        method: 'connect',
        id: 'c-proxy-1',
        params: { client: { id: 'nerve-ui' } },
      }));

      // Wait for the connect request to be received by the gateway
      await mockGw.expectMessages(1);

      const connectMsg = mockGw.received.find((m) => {
        const d = m.data as Record<string, unknown>;
        return d.type === 'req' && d.method === 'connect';
      });
      expect(connectMsg).toBeTruthy();
      const params = (connectMsg!.data as Record<string, unknown>).params as Record<string, unknown>;
      const auth = (params.auth as Record<string, unknown> | undefined) ?? {};
      // Should NOT have injected the token because the resolved IP is not loopback
      expect(auth.token).toBeUndefined();

      ws.close();
    });
  });
});

// ── Observability tests (appended) ──────────────────────────────────
// These are added in a separate describe block outside the main one
// since the main describe block is already closed.

describe('ws-proxy observability', () => {
  let mockGw2: MockGateway;
  let proxyServer2: Server;
  let proxyPort2: number;

  beforeAll(async () => {
    mockGw2 = new MockGateway();
    await mockGw2.start();
  });

  afterAll(async () => {
    closeAllWebSockets();
    await mockGw2.close();
  });

  beforeEach(async () => {
    (config as { auth: boolean }).auth = false;
    proxyServer2 = createServer();
    setupWebSocketProxy(proxyServer2);
    await new Promise<void>((resolve) => {
      proxyServer2.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = proxyServer2.address();
    proxyPort2 = typeof addr === 'object' && addr ? addr.port : 0;
  });

  afterEach(async () => {
    closeAllWebSockets();
    await new Promise<void>((resolve) => {
      proxyServer2.close(() => resolve());
    });
  });

  it('logs connection ID in [ws-proxy:XXXXXXXX] format on new connection', async () => {
    const logSpy = vi.spyOn(console, 'log');
    const ws = new WebSocket(
      `ws://127.0.0.1:${proxyPort2}/ws?target=${encodeURIComponent(mockGw2.url + '/ws')}`,
    );
    await waitForMessage(ws);

    const newConnLog = logSpy.mock.calls.find(
      (args) => typeof args[0] === 'string' && args[0].includes('New connection'),
    );
    expect(newConnLog).toBeTruthy();
    expect(newConnLog![0]).toMatch(/\[ws-proxy:[0-9a-f]{8}\]/);

    ws.close();
    await new Promise((r) => setTimeout(r, 50));
    logSpy.mockRestore();
  });

  it('logs summary with duration and message counts on close', async () => {
    const logSpy = vi.spyOn(console, 'log');
    const ws = new WebSocket(
      `ws://127.0.0.1:${proxyPort2}/ws?target=${encodeURIComponent(mockGw2.url + '/ws')}`,
    );
    await waitForMessage(ws);

    const closePromise = waitForClose(ws);
    ws.close();
    await closePromise;
    await new Promise((r) => setTimeout(r, 100));

    const summaryLog = logSpy.mock.calls.find(
      (args) => typeof args[0] === 'string' && args[0].includes('Summary:'),
    );
    expect(summaryLog).toBeTruthy();
    expect(summaryLog![0]).toMatch(/\[ws-proxy:[0-9a-f]{8}\] Summary: duration=\d+ms/);
    expect(summaryLog![0]).toContain('client->gw=');
    expect(summaryLog![0]).toContain('gw->client=');

    logSpy.mockRestore();
  });

  it('uses unique connection IDs for concurrent connections', async () => {
    const logSpy = vi.spyOn(console, 'log');

    const ws1 = new WebSocket(
      `ws://127.0.0.1:${proxyPort2}/ws?target=${encodeURIComponent(mockGw2.url + '/ws')}`,
    );
    await waitForMessage(ws1);

    const ws2 = new WebSocket(
      `ws://127.0.0.1:${proxyPort2}/ws?target=${encodeURIComponent(mockGw2.url + '/ws')}`,
    );
    await waitForMessage(ws2);

    const connLogs = logSpy.mock.calls.filter(
      (args) => typeof args[0] === 'string' && args[0].includes('New connection'),
    );
    expect(connLogs.length).toBeGreaterThanOrEqual(2);

    const ids = connLogs.map((args) => {
      const match = (args[0] as string).match(/\[ws-proxy:([0-9a-f]{8})\]/);
      return match?.[1];
    });
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);

    ws1.close();
    ws2.close();
    await new Promise((r) => setTimeout(r, 50));
    logSpy.mockRestore();
  });
});

describe('Jane mobile internal bridge', () => {
  let gateway: MockGateway;
  let server: Server;
  let port: number;

  beforeAll(async () => {
    gateway = new MockGateway({ requireToken: 'test-token' });
    await gateway.start();
  });

  afterAll(async () => {
    closeAllWebSockets();
    await gateway.close();
  });

  beforeEach(async () => {
    mockedConfig.auth = true;
    mockedConfig.gatewayUrl = gateway.url;
    mockedConfig.janeMobileBridgeToken = 'bridge-secret';
    gateway.clearReceived();
    server = createServer();
    setupWebSocketProxy(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    port = typeof address === 'object' && address ? address.port : 0;
  });

  afterEach(async () => {
    closeAllWebSockets();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('rejects a loopback bridge without the dedicated bearer', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/internal/jane-mobile`);
    const closed = await waitForCloseOrError(ws);
    expect(closed.reason).toContain('401');
  });

  it('injects gateway auth without a browser cookie and relays only Jane Live chat', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/internal/jane-mobile`, {
      headers: { Authorization: 'Bearer bridge-secret' },
    });
    expect(JSON.parse(await waitForMessage(ws)).event).toBe('connect.challenge');

    const connectResponse = waitForMessage(ws);
    ws.send(JSON.stringify({
      type: 'req', id: 'connect-1', method: 'connect',
      params: {
        minProtocol: 4, maxProtocol: 4,
        client: { id: 'jane-mobile-bridge', version: '1.0.0', platform: 'server', mode: 'webchat', instanceId: 'test' },
        role: 'operator', scopes: ['operator.read', 'operator.write', 'operator.approvals'], auth: {}, caps: ['tool-events'],
      },
    }));
    await waitForCondition(() => gateway.received.some(({ data }) => {
      const message = data as Record<string, unknown>;
      if (message.method !== 'connect') return false;
      const auth = ((message.params as Record<string, unknown>)?.auth || {}) as Record<string, unknown>;
      return auth.token === 'test-token';
    }));
    expect(JSON.parse(await connectResponse)).toMatchObject({ type: 'res', id: 'connect-1', ok: true });

    ws.send(JSON.stringify({
      type: 'req', id: 'send-1', method: 'chat.send',
      params: {
        sessionKey: 'agent:main:voice:direct:nerve-live',
        message: 'hello Jane', deliver: false, idempotencyKey: 'idem-1',
      },
    }));
    await waitForCondition(() => gateway.received.some(({ data }) => (data as Record<string, unknown>).method === 'chat.send'));

    const finalEvent = waitForMessage(ws);
    gateway.broadcast(JSON.stringify({
      type: 'event', event: 'chat',
      payload: { sessionKey: 'agent:main:voice:direct:nerve-live', state: 'final', message: { role: 'assistant', content: 'done' } },
    }));
    expect(JSON.parse(await finalEvent)).toMatchObject({
      type: 'event', event: 'chat', payload: { state: 'final' },
    });
    ws.close();
  });

  it('closes the bridge when it requests an unscoped gateway method', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/internal/jane-mobile`, {
      headers: { Authorization: 'Bearer bridge-secret' },
    });
    await waitForMessage(ws);
    ws.send(JSON.stringify({ type: 'req', id: 'bad-1', method: 'sessions.list', params: {} }));
    const closed = await waitForClose(ws);
    expect(closed.code).toBe(1008);
    expect(closed.reason).toContain('not allowed');
  });
});
