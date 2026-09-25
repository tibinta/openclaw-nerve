import { describe, expect, it } from 'vitest';
import type { IncomingMessage } from 'node:http';
import {
  authorizeJaneMobileBridge,
  createJaneMobileRelayPolicy,
  extractJanePublicProgress,
  gatewayWebSocketUrl,
  isAllowedJaneMobileChatHistory,
  isAllowedJaneMobileChatSend,
  isAllowedJaneMobileSessionPatch,
  normalizeJaneMobileClientFrame,
  isAllowedJaneMobileApprovalRequest,
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

  it('allows only validated model, intelligence, and fast controls for Jane Live', () => {
    const base = {
      type: 'req', id: 'patch-1', method: 'sessions.patch',
      params: { key: sessionKey, model: 'openai/gpt-6-luna', thinkingLevel: 'medium', fastMode: false },
    };
    expect(isAllowedJaneMobileSessionPatch(base)).toBe(true);
    expect(isAllowedJaneMobileSessionPatch({ ...base, params: { ...base.params, key: 'agent:other:main' } })).toBe(false);
    expect(isAllowedJaneMobileSessionPatch({ ...base, params: { ...base.params, thinkingLevel: 'xhigh' } })).toBe(false);
    expect(isAllowedJaneMobileSessionPatch({ ...base, params: { ...base.params, model: 'openai/gpt 5' } })).toBe(false);
    expect(isAllowedJaneMobileSessionPatch({ ...base, params: { ...base.params, label: 'other session' } })).toBe(false);
  });

  it('maps legacy installed model names to the current Jane models', () => {
    const frame = JSON.stringify({
      type: 'req', id: 'patch-legacy', method: 'sessions.patch',
      params: { key: sessionKey, model: 'openai/gpt-5.6-luna', thinkingLevel: 'medium', fastMode: false },
    });
    expect(JSON.parse(String(normalizeJaneMobileClientFrame(frame, false))).params.model).toBe('openai/gpt-6-luna');
  });

  it('returns only responses for accepted requests and Jane Live chat events', () => {
    const policy = createJaneMobileRelayPolicy();
    expect(policy.allowClientFrame(JSON.stringify({
      type: 'req', id: 'connect-1', method: 'connect',
      params: {
        minProtocol: 4, maxProtocol: 4,
        client: { id: 'jane-mobile-bridge', platform: 'server', mode: 'webchat' },
        role: 'operator', scopes: ['operator.read', 'operator.write', 'operator.approvals'], auth: {}, caps: ['tool-events'],
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
      type: 'req', id: 'patch-1', method: 'sessions.patch',
      params: { key: sessionKey, thinkingLevel: 'high', fastMode: false },
    }), false)).toBe(true);
    expect(policy.allowClientFrame(JSON.stringify({
      type: 'req', id: 'cron-status', method: 'nerve.cron.group.status', params: {},
    }), false)).toBe(true);
    expect(policy.allowClientFrame(JSON.stringify({
      type: 'req', id: 'cron-admin', method: 'nerve.cron.group.setEnabled', params: { enabled: true, idempotencyKey: 'valid-key', jobId: 'other' },
    }), false)).toBe(false);
    expect(policy.allowClientFrame(JSON.stringify({ type: 'req', id: 'x', method: 'sessions.list', params: {} }), false)).toBe(false);
    expect(policy.allowGatewayFrame(JSON.stringify({ type: 'res', id: 'send-1', ok: true }), false)).toBe(true);
    expect(policy.allowGatewayFrame(JSON.stringify({ type: 'res', id: 'history-1', ok: true, payload: { messages: [] } }), false)).toBe(true);
    expect(policy.allowGatewayFrame(JSON.stringify({ type: 'res', id: 'patch-1', ok: true }), false)).toBe(true);
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

  it('relays only bounded Talk methods and events for a created Jane session', () => {
    const policy = createJaneMobileRelayPolicy();
    const talkRequest = (id: string, method: string, params: Record<string, unknown>) => ({ type: 'req', id, method, params });
    const create = talkRequest('talk-create', 'talk.session.create', {
      sessionKey, mode: 'realtime', transport: 'gateway-relay', brain: 'agent-consult',
      provider: 'openai', model: 'gpt-live-1-codex', language: 'ro',
    });
    expect(policy.allowClientFrame(JSON.stringify(create), false)).toBe(true);
    expect(policy.allowClientFrame(JSON.stringify({ ...create, id: 'duplicate-pending' }), false)).toBe(false);
    const earlyReady = policy.gatewayFrame(JSON.stringify({ type: 'event', event: 'talk.event', payload: {
      relaySessionId: 'relay-1', type: 'ready', audioBase64: 'private-audio', text: 'private transcript',
    } }), false);
    expect(JSON.parse(String(earlyReady))).toEqual({ type: 'event', event: 'talk.event', payload: {
      relaySessionId: 'relay-1', type: 'ready',
    } });
    expect(policy.allowGatewayFrame(JSON.stringify({ type: 'event', event: 'talk.event', payload: {
      relaySessionId: 'relay-1', type: 'input.audio', audioBase64: 'private-audio',
    } }), false)).toBe(false);
    expect(policy.allowGatewayFrame(JSON.stringify({ type: 'event', event: 'talk.event', payload: {
      relaySessionId: 'relay-1', type: 'transcript.final', text: 'private transcript',
    } }), false)).toBe(false);
    expect(policy.allowClientFrame(JSON.stringify(talkRequest('bad-create', 'talk.session.create', {
      sessionKey: 'agent:other:main',
    })), false)).toBe(false);
    expect(policy.allowClientFrame(JSON.stringify(talkRequest('too-broad', 'talk.session.create', {
      sessionKey, extra: true,
    })), false)).toBe(false);
    for (const [key, value] of [['provider', 'other'], ['model', 'other-model'], ['language', 'en']]) {
      expect(policy.allowClientFrame(JSON.stringify({
        ...create, id: `bad-${key}`, params: { ...create.params, [key]: value },
      }), false)).toBe(false);
    }
    expect(policy.allowGatewayFrame(JSON.stringify({ type: 'event', event: 'talk.event', payload: { sessionId: 'session-1' } }), false)).toBe(false);

    expect(policy.allowGatewayFrame(JSON.stringify({
      type: 'res', id: 'talk-create', ok: true, payload: { sessionId: 'session-1', relaySessionId: 'relay-1' },
    }), false)).toBe(true);
    expect(policy.allowClientFrame(JSON.stringify({ ...create, id: 'duplicate-active' }), false)).toBe(false);
    const ownEvent = JSON.stringify({ type: 'event', event: 'talk.event', payload: {
      relaySessionId: 'relay-1', type: 'turn.started', audioBase64: 'AQID',
      talkEvent: { sessionId: 'session-1', type: 'turn.started' },
    } });
    expect(policy.allowGatewayFrame(ownEvent, false)).toBe(true);
    expect(policy.allowGatewayFrame(JSON.stringify({ type: 'event', event: 'talk.event', payload: {
      relaySessionId: 'relay-1', talkEvent: { sessionId: 'other-session' },
    } }), false)).toBe(false);
    expect(policy.allowGatewayFrame(JSON.stringify({ type: 'event', event: 'talk.event', payload: {
      relaySessionId: 'other-relay', talkEvent: { sessionId: 'session-1' },
    } }), false)).toBe(false);

    expect(policy.allowClientFrame(JSON.stringify(talkRequest('audio', 'talk.session.appendAudio', {
      sessionId: 'session-1', audioBase64: 'AQID', timestamp: 1,
    })), false)).toBe(true);
    expect(policy.allowClientFrame(JSON.stringify(talkRequest('bad-audio', 'talk.session.appendAudio', {
      sessionId: 'session-1', audioBase64: 'AQI!',
    })), false)).toBe(false);
    expect(policy.allowClientFrame(JSON.stringify(talkRequest('wrong-session', 'talk.session.cancelOutput', {
      sessionId: 'other-session',
    })), false)).toBe(false);
    expect(policy.allowClientFrame(JSON.stringify(talkRequest('cancel', 'talk.session.cancelOutput', {
      sessionId: 'session-1', reason: 'user-cancelled',
    })), false)).toBe(true);
    expect(policy.allowClientFrame(JSON.stringify(talkRequest('ack-mark', 'talk.session.acknowledgeMark', {
      sessionId: 'session-1', markName: 'response.audio.done',
    })), false)).toBe(true);
    expect(policy.allowClientFrame(JSON.stringify(talkRequest('ack-wrong-session', 'talk.session.acknowledgeMark', {
      sessionId: 'other-session', markName: 'response.audio.done',
    })), false)).toBe(false);
    expect(policy.allowClientFrame(JSON.stringify(talkRequest('ack-too-long', 'talk.session.acknowledgeMark', {
      sessionId: 'session-1', markName: 'm'.repeat(129),
    })), false)).toBe(false);
    expect(policy.allowClientFrame(JSON.stringify(talkRequest('ack-extra', 'talk.session.acknowledgeMark', {
      sessionId: 'session-1', markName: 'response.audio.done', extra: true,
    })), false)).toBe(false);
    expect(policy.allowClientFrame(JSON.stringify(talkRequest('close', 'talk.session.close', {
      sessionId: 'session-1',
    })), false)).toBe(true);
    expect(policy.allowGatewayFrame(JSON.stringify({ type: 'res', id: 'close', ok: true }), false)).toBe(true);
    expect(policy.allowGatewayFrame(ownEvent, false)).toBe(false);
    expect(policy.allowClientFrame(JSON.stringify(talkRequest('after-close', 'talk.session.appendAudio', {
      sessionId: 'session-1', audioBase64: 'AQID',
    })), false)).toBe(false);
  });

  it('allows only bounded approval list and resolve requests', () => {
    expect(isAllowedJaneMobileApprovalRequest({ type: 'req', id: 'list', method: 'exec.approval.list', params: {} })).toBe(true);
    expect(isAllowedJaneMobileApprovalRequest({ type: 'req', id: 'resolve', method: 'plugin.approval.resolve', params: { id: 'approval-1', decision: 'deny' } })).toBe(true);
    expect(isAllowedJaneMobileApprovalRequest({ type: 'req', id: 'bad', method: 'exec.approval.resolve', params: { id: 'approval-1', decision: 'allow' } })).toBe(false);
    expect(isAllowedJaneMobileApprovalRequest({ type: 'req', id: 'bad', method: 'exec.approval.resolve', params: { id: 'approval/1', decision: 'deny' } })).toBe(false);
    expect(isAllowedJaneMobileApprovalRequest({ type: 'req', id: 'bad', method: 'exec.approval.resolve', params: { id: 'approval-1', decision: 'deny', extra: true } })).toBe(false);
    expect(isAllowedJaneMobileApprovalRequest({ type: 'req', id: 'bad', method: 'sessions.list', params: {} })).toBe(false);
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

  it('forwards sanitized live approval events and resolved removal signals', () => {
    const policy = createJaneMobileRelayPolicy();
    expect(policy.allowClientFrame(JSON.stringify({ type: 'req', id: 'list', method: 'exec.approval.list', params: {} }), false)).toBe(true);
    const requested = policy.gatewayFrame(JSON.stringify({
      type: 'event', event: 'exec.approval.requested', payload: {
        id: 'approval-1', createdAtMs: 1, expiresAtMs: 2,
        request: { command: 'echo secret', commandPreview: 'echo secret', cwd: '/private', sessionKey, sessionId: null, allowedDecisions: ['allow-once', 'deny'], token: 'omit' },
      },
    }), false);
    expect(JSON.parse(String(requested))).toEqual({
      type: 'event', event: 'exec.approval.requested', payload: {
        id: 'approval-1', createdAtMs: 1, expiresAtMs: 2,
        request: { command: 'echo secret', commandPreview: 'echo secret', cwd: '/private', allowedDecisions: ['allow-once', 'deny'] },
      },
    });
    expect(String(requested)).not.toContain('token');
    expect(policy.allowClientFrame(JSON.stringify({ type: 'req', id: 'resolve-unknown', method: 'exec.approval.resolve', params: { id: 'unknown', decision: 'deny' } }), false)).toBe(false);
    expect(policy.allowClientFrame(JSON.stringify({ type: 'req', id: 'resolve-live', method: 'exec.approval.resolve', params: { id: 'approval-1', decision: 'deny' } }), false)).toBe(true);
    expect(policy.allowClientFrame(JSON.stringify({ type: 'req', id: 'resolve-too-broad', method: 'exec.approval.resolve', params: { id: 'approval-1', decision: 'allow-always' } }), false)).toBe(false);
    const listed = policy.gatewayFrame(JSON.stringify({ type: 'res', id: 'list', ok: true, payload: {
      approvals: [
        { id: 'approval-1', createdAtMs: 1, expiresAtMs: 2, request: { title: 'safe', command: 'echo safe', sessionKey } },
        { id: 'other', createdAtMs: 1, expiresAtMs: 2, sessionKey: 'agent:other:main', request: { command: 'no' } },
      ],
    } }), false);
    expect(JSON.parse(String(listed))).toEqual({ type: 'res', id: 'list', ok: true, payload: {
      approvals: [{ id: 'approval-1', createdAtMs: 1, expiresAtMs: 2, request: { command: 'echo safe', allowedDecisions: ['allow-once', 'deny'] } }],
    } });
    expect(policy.gatewayFrame(JSON.stringify({ type: 'event', event: 'exec.approval.requested', payload: {
      id: 'other', createdAtMs: 1, expiresAtMs: 2, sessionKey: 'agent:other:main', request: { command: 'no' },
    } }), false)).toBeNull();
    expect(policy.gatewayFrame(JSON.stringify({ type: 'event', event: 'exec.approval.requested', payload: {
      id: 'unbound', createdAtMs: 1, expiresAtMs: 2, request: { command: 'no session' },
    } }), false)).toBeNull();
    const resolved = policy.gatewayFrame(JSON.stringify({ type: 'event', event: 'exec.approval.resolved', payload: { id: 'approval-1', decision: 'deny', sessionKey } }), false);
    expect(JSON.parse(String(resolved))).toEqual({ type: 'event', event: 'exec.approval.resolved', payload: { id: 'approval-1', decision: 'deny' } });
  });

  it('forwards approvals for the maintained isolated Jane cron scope', () => {
    const policy = createJaneMobileRelayPolicy();
    const frame = policy.gatewayFrame(JSON.stringify({
      type: 'event', event: 'exec.approval.requested', payload: {
        id: 'cron-approval', createdAtMs: 1, expiresAtMs: 2,
        request: { sessionKey: 'agent:jane-whitmore---ceo:cron:gated:mentoring', command: 'echo safe' },
      },
    }), false);
    expect(JSON.parse(String(frame))).toMatchObject({ event: 'exec.approval.requested', payload: { id: 'cron-approval' } });
    expect(policy.gatewayFrame(JSON.stringify({
      type: 'event', event: 'exec.approval.requested', payload: {
        id: 'other-approval', createdAtMs: 1, expiresAtMs: 2,
        request: { sessionKey: 'agent:jane-whitmore---ceo:main', command: 'echo no' },
      },
    }), false)).toBeNull();
  });

  it('accepts opaque OpenClaw session IDs but rejects conflicting Jane agent identities', () => {
    const policy = createJaneMobileRelayPolicy();
    const approved = policy.gatewayFrame(JSON.stringify({
      type: 'event', event: 'exec.approval.requested', payload: {
        id: 'uuid-session', createdAtMs: 1, expiresAtMs: 2,
        request: { sessionKey, sessionId: '16e98294-1f94-4a9d-bdd0-2c06315b6eee', command: 'echo safe' },
      },
    }), false);
    expect(approved).not.toBeNull();
    expect(String(approved)).not.toContain('sessionId');
    expect(policy.gatewayFrame(JSON.stringify({
      type: 'event', event: 'exec.approval.requested', payload: {
        id: 'wrong-agent', createdAtMs: 1, expiresAtMs: 2,
        request: { sessionKey, agentId: 'other', command: 'echo no' },
      },
    }), false)).toBeNull();
  });

  it('does not broaden an explicit empty approval decision list', () => {
    const policy = createJaneMobileRelayPolicy();
    const requested = policy.gatewayFrame(JSON.stringify({
      type: 'event', event: 'exec.approval.requested', payload: {
        id: 'no-decisions', createdAtMs: 1, expiresAtMs: 2,
        request: { sessionKey, command: 'echo safe', allowedDecisions: [] },
      },
    }), false);
    expect(JSON.parse(String(requested))).toMatchObject({ payload: { request: { allowedDecisions: [] } } });
    expect(policy.allowClientFrame(JSON.stringify({ type: 'req', id: 'resolve-empty', method: 'exec.approval.resolve', params: { id: 'no-decisions', decision: 'allow-once' } }), false)).toBe(false);
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
