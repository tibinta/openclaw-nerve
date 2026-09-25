import { describe, expect, it } from 'vitest';
import {
  buildJaneRealtimeThreadRequest,
  codexRealtimeEnvironment,
  extractJaneCanonicalFinal,
  buildJaneRealtimeSpeechRequest,
  nativeApprovalDecision,
  nativeApprovalForClient,
  nativeApprovalExpiresAt,
  normalizeCodexRealtimeRequest,
  resumeErrorMeansMissingThread,
  realtimeTranscriptEntry,
  realtimeHistoryForClient,
  JaneRealtimeSpeechQueue,
  SpeechAckTimeoutError,
} from './codex-realtime-proxy.js';

describe('Codex realtime boundary', () => {
  it('extracts one useful canonical gateway final and suppresses NO_REPLY', () => {
    expect(extractJaneCanonicalFinal({
      sessionKey: 'agent:main:voice:direct:nerve-live', state: 'final', runId: 'run-1',
      messages: [{ role: 'assistant', content: [{ text: '  Buna, Alex.  ' }] }],
    })).toEqual({ key: 'jane:run-1', text: 'Buna, Alex.', runId: 'run-1' });
    expect(extractJaneCanonicalFinal({
      sessionKey: 'agent:main:voice:direct:nerve-live', state: 'final', content: 'NO_REPLY',
    })).toBeNull();
    expect(extractJaneCanonicalFinal({ sessionKey: 'agent:other', state: 'final', content: 'ignore' })).toBeNull();
  });

  it('uses the server-only realtime speech protocol with bounded text', () => {
    expect(buildJaneRealtimeSpeechRequest(42, 'thread-1', 'Salut')).toEqual({
      id: 42, method: 'thread/realtime/appendSpeech', params: { threadId: 'thread-1', text: 'Salut' },
    });
  });

  it('holds finals until Live starts, preserves order, and deduplicates canonical events', async () => {
    const sent: string[] = [];
    const queue = new JaneRealtimeSpeechQueue(async (text) => { sent.push(text); });
    queue.enqueue({ key: 'one', text: 'First' });
    queue.enqueue({ key: 'one', text: 'Duplicate' });
    queue.enqueue({ key: 'two', text: 'Second' });
    await Promise.resolve();
    expect(sent).toEqual([]);
    queue.setActive(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent).toEqual(['First', 'Second']);
  });

  it('keeps a rejected final for the next Live reconnect', async () => {
    const sent: string[] = [];
    let reject = true;
    const queue = new JaneRealtimeSpeechQueue(async (text) => {
      sent.push(text);
      if (reject) throw new Error('session closed');
    });
    queue.enqueue({ key: 'one', text: 'Retry me' });
    queue.setActive(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent).toEqual(['Retry me']);
    reject = false;
    queue.setActive(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent).toEqual(['Retry me', 'Retry me']);
  });

  it('quarantines an uncertain final without blocking later finals after reconnect', async () => {
    const sent: string[] = [];
    const queue = new JaneRealtimeSpeechQueue(async (text) => {
      sent.push(text);
      if (text === 'Uncertain') throw new SpeechAckTimeoutError('ack timed out');
    });
    queue.enqueue({ key: 'one', text: 'Uncertain' });
    queue.enqueue({ key: 'two', text: 'Later' });
    queue.setActive(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent).toEqual(['Uncertain']);
    queue.setActive(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent).toEqual(['Uncertain', 'Later']);
  });
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

  it('starts a new conversation only when the persisted thread is confirmed missing', () => {
    expect(resumeErrorMeansMissingThread({ message: 'Thread not found' })).toBe(true);
    expect(resumeErrorMeansMissingThread({ message: 'Gateway temporarily unavailable' })).toBe(false);
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

  it('journals repeated phrases by event identity and stream order', () => {
    const first = realtimeTranscriptEntry({ method: 'thread/realtime/transcript/done', params: { role: 'user', text: 'da', itemId: 'one' } }, 7);
    const second = realtimeTranscriptEntry({ method: 'thread/realtime/transcript/done', params: { role: 'user', text: 'da', itemId: 'two' } }, 8);
    expect(first).toMatchObject({ id: 'one', seq: 7, text: 'da' });
    expect(second).toMatchObject({ id: 'two', seq: 8, text: 'da' });
    expect(realtimeHistoryForClient([first!, second!]).params?.entries).toEqual([
      { ...first, eventId: 'one' },
      { ...second, eventId: 'two' },
    ]);
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
    }, 'codex-approval:1')).toEqual({
      id: 'codex-approval:1',
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thread', itemId: 'item', command: 'git status', cwd: '/workspace',
        availableDecisions: ['accept', 'acceptForSession', 'decline'],
      },
    });
    expect(nativeApprovalDecision({ id: 42, result: { decision: 'accept' } })).toBe('accept');
    expect(nativeApprovalDecision({ id: 42, result: { decision: 'allow-always' } })).toBeNull();
    expect(nativeApprovalExpiresAt({ params: { startedAtMs: 1_000 } }, 2_000)).toBe(602_000);
  });
});
