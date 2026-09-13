import { describe, expect, it } from 'vitest';
import type { IncomingMessage } from 'node:http';
import {
  authorizeJaneMobileBridge,
  createJaneMobileRelayPolicy,
  extractJanePublicProgress,
  gatewayWebSocketUrl,
  isAllowedJaneMobileChatHistory,
  isAllowedJaneMobileChatSend,
} from './jane-mobile-proxy.js';

const sessionKey = 'agent:jane-whitmore---ceo:voice:direct:nerve-live';

function chatSend(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'req',
    id: 'send-1',
    method: 'chat.send',
    params: {
      sessionKey,
      message: 'hello',
      deliver: false,
      idempotencyKey: 'idem-1',
      ...overrides,
    },
  };
}

function chatHistory(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'req',
    id: 'history-1',
    method: 'chat.history',
    params: { sessionKey, limit: 20, ...overrides },
  };
}

describe('Jane mobile relay policy', () => {
  it('requires the private loopback bridge bearer', () => {
    const request = (address: string, authorization: string) => ({
      socket: { remoteAddress: address },
      headers: { authorization },
    }) as unknown as IncomingMessage;
    expect(authorizeJaneMobileBridge(request('127.0.0.1', 'Bearer bridge-secret'), 'bridge-secret')).toBe(true);
    expect(authorizeJaneMobileBridge(request('127.0.0.1', 'Bearer wrong'), 'bridge-secret')).toBe(false);
    expect(authorizeJaneMobileBridge(request('192.168.40.20', 'Bearer bridge-secret'), 'bridge-secret')).toBe(false);
  });

  it('allows only bounded Jane Live chat.send requests', () => {
    expect(isAllowedJaneMobileChatSend(chatSend())).toBe(true);
    expect(isAllowedJaneMobileChatSend(chatSend({ sessionKey: 'agent:other:main' }))).toBe(false);
    expect(isAllowedJaneMobileChatSend(chatSend({ message: 'x'.repeat(64_001) }))).toBe(false);
    expect(isAllowedJaneMobileChatSend(chatSend({
      attachments: [{ mimeType: 'image/png', content: Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64') }],
    }))).toBe(false);
  });

  it('allows only bounded Jane Live chat.history requests', () => {
    expect(isAllowedJaneMobileChatHistory(chatHistory())).toBe(true);
    expect(isAllowedJaneMobileChatHistory(chatHistory({ sessionKey: 'agent:other:main' }))).toBe(false);
    expect(isAllowedJaneMobileChatHistory(chatHistory({ limit: 21 }))).toBe(false);
    expect(isAllowedJaneMobileChatHistory(chatHistory({ cursor: 'unexpected' }))).toBe(false);
  });

  it('returns only responses for accepted requests and Jane Live chat events', () => {
    const policy = createJaneMobileRelayPolicy();
    expect(policy.allowClientFrame(JSON.stringify({
      type: 'req', id: 'connect-1', method: 'connect',
      params: {
        minProtocol: 4, maxProtocol: 4,
        client: { id: 'jane-mobile-bridge', platform: 'server', mode: 'webchat' },
        role: 'operator', scopes: ['operator.read', 'operator.write'], auth: {}, caps: ['tool-events'],
      },
    }), false)).toBe(true);
    expect(policy.allowClientFrame(JSON.stringify({
      type: 'req', id: 'admin', method: 'connect',
      params: {
        minProtocol: 4, maxProtocol: 4,
        client: { id: 'jane-mobile-bridge', platform: 'server', mode: 'webchat' },
        role: 'operator', scopes: ['operator.admin'], auth: {}, caps: ['tool-events'],
      },
    }), false)).toBe(false);
    expect(policy.allowClientFrame(JSON.stringify(chatSend()), false)).toBe(true);
    expect(policy.allowClientFrame(JSON.stringify(chatHistory()), false)).toBe(true);
    expect(policy.allowClientFrame(JSON.stringify({
      type: 'req', id: 'cron-status', method: 'nerve.cron.group.status', params: {},
    }), false)).toBe(true);
    expect(policy.allowClientFrame(JSON.stringify({
      type: 'req', id: 'cron-admin', method: 'nerve.cron.group.setEnabled', params: { enabled: true, idempotencyKey: 'valid-key', jobId: 'other' },
    }), false)).toBe(false);
    expect(policy.allowClientFrame(JSON.stringify({ type: 'req', id: 'x', method: 'sessions.list', params: {} }), false)).toBe(false);
    expect(policy.allowGatewayFrame(JSON.stringify({ type: 'res', id: 'send-1', ok: true }), false)).toBe(true);
    expect(policy.allowGatewayFrame(JSON.stringify({ type: 'res', id: 'history-1', ok: true, payload: { messages: [] } }), false)).toBe(true);
    expect(policy.allowGatewayFrame(JSON.stringify({ type: 'res', id: 'unknown', ok: true }), false)).toBe(false);
    expect(policy.allowGatewayFrame(JSON.stringify({
      type: 'event', event: 'chat', payload: { sessionKey, state: 'delta' },
    }), false)).toBe(true);
    expect(policy.allowGatewayFrame(JSON.stringify({
      type: 'event', event: 'chat', payload: { sessionKey, runId: 'jane-realtime:voice-turn', state: 'final' },
    }), false)).toBe(true);
    expect(policy.allowGatewayFrame(JSON.stringify({
      type: 'event', event: 'chat', payload: { sessionKey: 'agent:other:main', state: 'delta' },
    }), false)).toBe(false);
  });

  it('maps existing agent lifecycle and tool events to safe progress only', () => {
    const policy = createJaneMobileRelayPolicy();
    const mapped = policy.gatewayFrame(JSON.stringify({
      type: 'event',
      event: 'agent',
      payload: {
        sessionKey,
        runId: 'run-safe-1',
        stream: 'tool',
        data: { phase: 'start', name: 'bash', args: { prompt: 'private', token: 'secret' } },
      },
    }), false);

    expect(mapped).not.toBeNull();
    expect(JSON.parse(String(mapped))).toEqual({
      type: 'event',
      event: 'nerve.agent.progress',
      payload: {
        state: 'running', label: 'Checking local state', tool: 'bash', phase: 'start', run_id: 'run-safe-1',
      },
    });
    expect(String(mapped)).not.toMatch(/private|secret|prompt|token|sessionKey|args/);
  });

  it('exposes only concrete tool activity to the realtime orb', () => {
    expect(extractJanePublicProgress({
      type: 'event', event: 'agent', payload: { sessionKey, stream: 'lifecycle', data: { phase: 'start' } },
    })).toBeNull();
    expect(extractJanePublicProgress({
      type: 'event', event: 'agent', payload: {
        sessionKey, runId: 'run-orb', stream: 'tool',
        data: { phase: 'start', name: 'web_search', input: { query: 'London weather tomorrow' } },
      },
    })).toEqual({
      state: 'running', label: 'searching: London weather tomorrow', tool: 'web_search', phase: 'start',
      query: 'London weather tomorrow', run_id: 'run-orb',
    });
  });

  it('keeps public search and fetch details while excluding raw tool arguments', () => {
    const policy = createJaneMobileRelayPolicy();
    const search = policy.gatewayFrame(JSON.stringify({
      type: 'event', event: 'agent', payload: {
        sessionKey, runId: 'run-search', stream: 'tool',
        data: { phase: 'start', name: 'web_search', input: { query: 'London weather tomorrow', secret: 'omit' } },
      },
    }), false);
    expect(JSON.parse(String(search))).toMatchObject({
      payload: {
        state: 'running', label: 'searching: London weather tomorrow', tool: 'web_search', phase: 'start',
        query: 'London weather tomorrow', run_id: 'run-search',
      },
    });
    expect(String(search)).not.toMatch(/secret|input|args/);

    const fetch = policy.gatewayFrame(JSON.stringify({
      type: 'event', event: 'agent', payload: {
        sessionKey, runId: 'run-fetch', stream: 'tool',
        data: { phase: 'result', name: 'web_fetch', url: 'https://weather.example.test/forecast', body: 'omit' },
      },
    }), false);
    expect(JSON.parse(String(fetch))).toMatchObject({
      payload: {
        state: 'running', label: 'fetching: weather.example.test', tool: 'web_fetch', phase: 'result', domain: 'weather.example.test',
        run_id: 'run-fetch',
      },
    });
    expect(String(fetch)).not.toMatch(/body|forecast/);
  });

  it('identifies file tools without exposing their paths or arguments', () => {
    const policy = createJaneMobileRelayPolicy();
    const mapped = policy.gatewayFrame(JSON.stringify({
      type: 'event', event: 'agent', payload: {
        sessionKey, runId: 'run-file', stream: 'tool',
        data: { phase: 'start', toolName: 'read', input: { path: '/private/client/secret.txt' } },
      },
    }), false);
    expect(JSON.parse(String(mapped))).toMatchObject({
      payload: { state: 'running', label: 'Reading files', tool: 'read', phase: 'start', run_id: 'run-file' },
    });
    expect(String(mapped)).not.toMatch(/private|secret\.txt|input/);
  });

  it('normalizes the configured gateway URL to its websocket route', () => {
    expect(gatewayWebSocketUrl('http://127.0.0.1:18789').toString()).toBe('ws://127.0.0.1:18789/ws');
    expect(gatewayWebSocketUrl('wss://gateway.example/ws').toString()).toBe('wss://gateway.example/ws');
  });
});
