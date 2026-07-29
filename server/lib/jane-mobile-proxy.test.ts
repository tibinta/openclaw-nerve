import { describe, expect, it } from 'vitest';
import {
  createJaneMobileRelayPolicy,
  gatewayWebSocketUrl,
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

describe('Jane mobile relay policy', () => {
  it('allows only bounded Jane Live chat.send requests', () => {
    expect(isAllowedJaneMobileChatSend(chatSend())).toBe(true);
    expect(isAllowedJaneMobileChatSend(chatSend({ sessionKey: 'agent:other:main' }))).toBe(false);
    expect(isAllowedJaneMobileChatSend(chatSend({ message: 'x'.repeat(64_001) }))).toBe(false);
    expect(isAllowedJaneMobileChatSend(chatSend({
      attachments: [{ mimeType: 'image/png', content: Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64') }],
    }))).toBe(false);
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
    expect(policy.allowClientFrame(JSON.stringify({ type: 'req', id: 'x', method: 'sessions.list', params: {} }), false)).toBe(false);
    expect(policy.allowGatewayFrame(JSON.stringify({ type: 'res', id: 'send-1', ok: true }), false)).toBe(true);
    expect(policy.allowGatewayFrame(JSON.stringify({ type: 'res', id: 'unknown', ok: true }), false)).toBe(false);
    expect(policy.allowGatewayFrame(JSON.stringify({
      type: 'event', event: 'chat', payload: { sessionKey, state: 'delta' },
    }), false)).toBe(true);
    expect(policy.allowGatewayFrame(JSON.stringify({
      type: 'event', event: 'chat', payload: { sessionKey, runId: 'jane-realtime:voice-turn', state: 'final' },
    }), false)).toBe(false);
    expect(policy.allowGatewayFrame(JSON.stringify({
      type: 'event', event: 'chat', payload: { sessionKey: 'agent:other:main', state: 'delta' },
    }), false)).toBe(false);
  });

  it('normalizes the configured gateway URL to its websocket route', () => {
    expect(gatewayWebSocketUrl('http://127.0.0.1:18789').toString()).toBe('ws://127.0.0.1:18789/ws');
    expect(gatewayWebSocketUrl('wss://gateway.example/ws').toString()).toBe('wss://gateway.example/ws');
  });
});
