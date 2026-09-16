import { describe, expect, it } from 'vitest';
import {
  buildJaneRealtimeThreadRequest,
  codexRealtimeEnvironment,
  nativeApprovalDecision,
  nativeApprovalForClient,
  normalizeCodexRealtimeRequest,
} from './codex-realtime-proxy.js';

describe('Codex realtime boundary', () => {
  it('resumes Jane\'s persistent conversation and starts a durable fallback', () => {
    expect(buildJaneRealtimeThreadRequest(2, 'persisted-thread')).toEqual({
      id: 2,
      method: 'thread/resume',
      params: { threadId: 'persisted-thread' },
    });
    expect(buildJaneRealtimeThreadRequest(3, null)).toMatchObject({
      id: 3,
      method: 'thread/start',
      params: {
        ephemeral: false,
        approvalPolicy: 'on-request',
        sandbox: 'workspace-write',
        historyMode: 'paginated',
        config: { features: { realtime_conversation: true } },
      },
    });
  });

  it('forces native GPT-Live settings and strips Platform API routing', () => {
    const request = normalizeCodexRealtimeRequest({
      id: 7,
      method: 'thread/realtime/start',
      params: {
        threadId: 'attacker-thread',
        outputModality: 'text',
        model: 'attacker-model',
        version: 'v1',
        voice: 'cove',
        transport: { type: 'webrtc', sdp: 'v=0\r\n' },
      },
    }, 'nerve-thread');

    expect(request?.params).toMatchObject({
      threadId: 'nerve-thread',
      outputModality: 'audio',
      version: 'v3',
      voice: 'cove',
      clientManagedHandoffs: false,
      includeStartupContext: false,
      flushTranscriptTailOnSessionEnd: false,
      transport: { type: 'webrtc', sdp: 'v=0\r\n' },
    });
    expect(request?.params).not.toHaveProperty('model');
    expect(request?.params?.prompt).toContain('Vorbește natural');
    expect(request?.params?.prompt).toContain('deleagă o singură dată');
    expect(request?.params?.prompt).not.toContain('Rămâi tăcută');
    expect(codexRealtimeEnvironment({ OPENAI_API_KEY: 'secret', OPENAI_BASE_URL: 'https://api.example', SAFE: 'yes' }))
      .toEqual({ SAFE: 'yes' });
  });

  it('keeps transcripts passive and rejects the removed speech replay path', () => {
    expect(normalizeCodexRealtimeRequest({
      id: 8,
      method: 'thread/realtime/appendSpeech',
      params: { text: 'do not replay me' },
    }, 'nerve-thread')).toBeNull();
    expect(normalizeCodexRealtimeRequest({
      id: 9,
      method: 'thread/realtime/transcript/done',
      params: { role: 'user', text: 'do not dispatch me' },
    }, 'nerve-thread')).toBeNull();
    expect(normalizeCodexRealtimeRequest({ method: 'turn/start' }, 'nerve-thread')).toBeNull();
  });

  it('sends typed Live messages to the same thread without text deduplication', () => {
    const message = { id: 10, method: 'thread/realtime/appendText', params: { role: 'user', text: 'da' } };
    expect(normalizeCodexRealtimeRequest(message, 'nerve-thread')).toEqual({
      id: 10,
      method: 'thread/realtime/appendText',
      params: { threadId: 'nerve-thread', role: 'user', text: 'da' },
    });
    expect(normalizeCodexRealtimeRequest({ ...message, id: 11 }, 'nerve-thread')?.params?.text).toBe('da');
  });

  it('defaults an invalid voice and rejects invalid SDP', () => {
    expect(normalizeCodexRealtimeRequest({
      method: 'thread/realtime/start',
      params: { voice: 'not-a-voice', transport: { type: 'webrtc', sdp: 'v=0\r\n' } },
    }, 'nerve-thread')?.params?.voice).toBe('juniper');
    expect(normalizeCodexRealtimeRequest({
      method: 'thread/realtime/start',
      params: { transport: { type: 'webrtc', sdp: '' } },
    }, 'nerve-thread')).toBeNull();
  });

  it('exposes only bounded native approvals and accepts one valid decision shape', () => {
    expect(nativeApprovalForClient({
      id: 42,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thread', itemId: 'item', command: 'git status', cwd: '/workspace', secret: 'hidden',
        availableDecisions: ['accept', 'acceptForSession', 'decline', 'anything'],
      },
    })).toEqual({
      id: 42,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thread', itemId: 'item', command: 'git status', cwd: '/workspace',
        availableDecisions: ['accept', 'acceptForSession', 'decline'],
      },
    });
    expect(nativeApprovalDecision({ id: 42, result: { decision: 'accept' } })).toBe('accept');
    expect(nativeApprovalDecision({ id: 42, result: { decision: 'allow-always' } })).toBeNull();
  });
});
