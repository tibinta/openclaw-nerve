import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { createOpenClawTalkRelay } from './openclaw-talk-relay.js';

class Client extends EventEmitter {
  readyState = WebSocket.OPEN;
  sent: Array<{ method: string; params: Record<string, unknown> }> = [];
  send(value: string) { this.sent.push(JSON.parse(value)); }
  receive(method: string, params = {}) { this.emit('message', Buffer.from(JSON.stringify({ method, params }))); }
}

describe('OpenClaw Talk relay', () => {
  it('rejects the optional iOS data channel while retaining the audio offer', async () => {
    const client = new Client();
    const rpc = vi.fn(async () => ({ voiceSessionId: 'own', offerUrl: '/plugins/openai/realtime/calls', clientSecret: 'secret', clientControl: { owner: 'gateway' } }));
    const postOffer = vi.fn(async (_url: URL, init: RequestInit) => {
      expect(init.body).toBe('m=audio 9 UDP/TLS/RTP/SAVPF 111\r\nm=application 0 UDP/DTLS/SCTP webrtc-datachannel\r\n');
      return { ok: true, text: async () => 'answer' } as Response;
    });
    createOpenClawTalkRelay(client as unknown as WebSocket, rpc as never, () => () => {}, postOffer as never);
    client.receive('thread/realtime/start', { transport: { type: 'webrtc', sdp: 'm=audio 9 UDP/TLS/RTP/SAVPF 111\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n' } });
    await vi.waitFor(() => expect(client.sent.map((item) => item.method)).toContain('thread/realtime/started'));
  });

  it('exchanges SDP, filters events by session, and closes the owned call', async () => {
    const client = new Client();
    const rpc = vi.fn(async (method: string) => method === 'talk.client.create'
      ? { voiceSessionId: 'own', offerUrl: '/plugins/openai/realtime/calls', clientSecret: 'secret', clientControl: { owner: 'gateway' } }
      : method === 'talk.speak' ? { audioBase64: 'YQ==', mimeType: 'audio/mpeg' } : {});
    let emitEvent: (event: Record<string, unknown>) => void = () => {};
    const unsubscribe = vi.fn();
    const postOffer = vi.fn(async (_url: URL, init: RequestInit) => {
      expect(init.headers).toEqual({ Authorization: 'Bearer secret', 'Content-Type': 'application/sdp' });
      expect(init.body).toBe('offer');
      return { ok: true, text: async () => 'answer' } as Response;
    });
    createOpenClawTalkRelay(client as unknown as WebSocket, rpc as never, (listener) => {
      emitEvent = listener;
      return unsubscribe;
    }, postOffer as never);
    expect(client.sent[0].method).toBe('nerve/realtime/ready');
    client.receive('thread/realtime/start', { voice: 'juniper', transport: { type: 'webrtc', sdp: 'offer' } });
    await vi.waitFor(() => expect(client.sent.map((item) => item.method)).toContain('thread/realtime/started'));
    expect(rpc).toHaveBeenCalledWith('talk.client.create', expect.objectContaining({
      capabilities: ['gateway-control-v1', 'voice-transcript'],
    }), 25_000);
    expect(client.sent.find((item) => item.method === 'thread/realtime/sdp')?.params.sdp).toBe('answer');
    emitEvent({ event: 'talk.event', payload: { voiceSessionId: 'other', talkEvent: { type: 'transcript.done', payload: { text: 'wrong' } } } });
    emitEvent({ event: 'talk.event', payload: { voiceSessionId: 'own', talkEvent: { type: 'output.text.delta', payload: { text: 'Hi' } } } });
    emitEvent({ event: 'talk.event', payload: { voiceSessionId: 'own', talkEvent: { type: 'transcript.done', payload: { text: 'hello' } } } });
    emitEvent({ type: 'event', event: 'chat', payload: {
      sessionKey: 'agent:other:main', state: 'final', message_id: 'other-1',
      message: { role: 'assistant', content: 'Ignore another session' },
    } });
    emitEvent({ type: 'event', event: 'chat', payload: {
      sessionKey: 'agent:main:voice:direct:nerve-live', state: 'final', message_id: 'cron-1',
      message: { role: 'assistant', content: 'Cron result in the Jane conversation' },
    } });
    emitEvent({ event: 'session.message', payload: {
      sessionKey: 'agent:main:voice:direct:nerve-live', messageId: 'cron-1',
      message: { role: 'assistant', content: 'Cron result in the Jane conversation' },
    } });
    emitEvent({ event: 'session.message', payload: {
      sessionKey: 'agent:main:voice:direct:nerve-live', messageId: 'cron-2',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Assistant result from a one-shot job' }] },
    } });
    emitEvent({ event: 'session.message', payload: {
      sessionKey: 'agent:main:voice:direct:nerve-live', messageId: 'user-1',
      message: { role: 'user', content: 'Never project this as Jane' },
    } });
    for (const [responseId, content] of [['response-1', 'First persistent cron reply'], ['response-2', 'Second persistent cron reply']]) {
      emitEvent({ event: 'chat', payload: {
        sessionKey: 'agent:main:voice:direct:nerve-live', state: 'final', runId: 'persistent-session',
        message: { role: 'assistant', responseId, content },
      } });
    }
    emitEvent({ event: 'session.message', payload: {
      sessionKey: 'agent:main:voice:direct:nerve-live', messageId: 'different-envelope-id',
      message: { role: 'assistant', responseId: 'response-2', content: 'Second persistent cron reply' },
    } });
    emitEvent({ event: 'talk.event', payload: { voiceSessionId: 'own', talkEvent: {
      id: 'talk-event-1', type: 'tool.progress', callId: 'call-1', turnId: 'turn-1',
      payload: { name: 'web_search', phase: 'searching', result: 'private tool output' },
    } } });
    emitEvent({ event: 'talk.event', payload: { voiceSessionId: 'other', talkEvent: {
      type: 'tool.error', callId: 'other-call', payload: { name: 'shell', message: 'wrong session' },
    } } });
    expect(client.sent.find((item) => item.method === 'thread/realtime/transcript/delta')?.params).toEqual({ role: 'assistant', delta: 'Hi' });
    expect(client.sent.filter((item) => item.method === 'thread/realtime/transcript/done')).toEqual([
      { method: 'thread/realtime/transcript/done', params: { role: 'user', text: 'hello' } },
      { method: 'thread/realtime/transcript/done', params: {
        role: 'assistant', text: 'Cron result in the Jane conversation', eventId: 'jane:cron-1',
      } },
      { method: 'thread/realtime/transcript/done', params: {
        role: 'assistant', text: 'Assistant result from a one-shot job', eventId: 'jane:cron-2',
      } },
      { method: 'thread/realtime/transcript/done', params: {
        role: 'assistant', text: 'First persistent cron reply', eventId: 'jane:response-1',
      } },
      { method: 'thread/realtime/transcript/done', params: {
        role: 'assistant', text: 'Second persistent cron reply', eventId: 'jane:response-2',
      } },
    ]);
    expect(rpc.mock.calls.filter(([method]) => method === 'talk.speak')).toHaveLength(0);
    expect(client.sent.some((item) => item.method === 'thread/realtime/speech')).toBe(false);
    expect(client.sent.find((item) => item.method === 'thread/realtime/activity')).toEqual({
      method: 'thread/realtime/activity',
      params: { state: 'working', name: 'web_search', callId: 'call-1', turnId: 'turn-1' },
    });
    expect(JSON.stringify(client.sent)).not.toContain('private tool output');
    emitEvent({ event: 'talk.event', payload: { voiceSessionId: 'own', talkEvent: {
      type: 'tool.result', callId: 'call-1', payload: { name: 'web_search', result: 'private tool output' },
    } } });
    emitEvent({ event: 'talk.event', payload: { voiceSessionId: 'own', talkEvent: {
      type: 'tool.error', callId: 'call-2', payload: { name: 'browser', message: 'private error' },
    } } });
    expect(client.sent.filter((item) => item.method === 'thread/realtime/activity').map((item) => item.params.state))
      .toEqual(['working', 'complete', 'error']);
    expect(JSON.stringify(client.sent)).not.toContain('private error');
    emitEvent({ event: 'talk.event', payload: { voiceSessionId: 'own', talkEvent: {
      type: 'session.error', payload: { message: 'recoverable' },
    } } });
    expect(client.sent.at(-1)?.method).toBe('thread/realtime/error');
    expect(unsubscribe).not.toHaveBeenCalled();
    client.receive('thread/realtime/appendText', { text: 'typed' });
    expect(client.sent.at(-1)?.params.message).toMatch(/Typed text is unavailable/);
    client.receive('thread/realtime/stop');
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledWith('talk.client.close', {
      sessionKey: 'agent:main:voice:direct:nerve-live', voiceSessionId: 'own',
    }));
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('does not re-synthesize or echo replies already spoken by realtime Talk', async () => {
    const client = new Client();
    const rpc = vi.fn(async (method: string) => method === 'talk.client.create'
      ? { voiceSessionId: 'own', offerUrl: '/plugins/openai/realtime/calls', clientSecret: 'secret', clientControl: { owner: 'gateway' } }
      : method === 'talk.speak' ? { audioBase64: 'YQ==', mimeType: 'audio/mpeg' } : {});
    let emitEvent: (event: Record<string, unknown>) => void = () => {};
    createOpenClawTalkRelay(client as unknown as WebSocket, rpc as never, (listener) => {
      emitEvent = listener;
      return () => {};
    }, vi.fn(async () => ({ ok: true, text: async () => 'answer' })) as never);
    client.receive('thread/realtime/start', { transport: { type: 'webrtc', sdp: 'offer' } });
    await vi.waitFor(() => expect(client.sent.map((item) => item.method)).toContain('thread/realtime/started'));

    emitEvent({ event: 'talk.event', payload: { voiceSessionId: 'own', talkEvent: {
      type: 'output.text.done', payload: { text: 'Live reply', entryId: 'voice-1' },
    } } });
    emitEvent({ event: 'chat', payload: {
      sessionKey: 'agent:main:voice:direct:nerve-live',
      state: 'final', runId: 'talk-realtime-consult:voice-1', message_id: 'consult-1',
      message: { role: 'assistant', content: 'Live reply' },
    } });
    emitEvent({ event: 'session.message', payload: {
      sessionKey: 'agent:main:voice:direct:nerve-live', messageId: 'consult-1',
      message: { role: 'assistant', content: 'Live reply', __openclaw: { runId: 'talk-realtime-consult:voice-1' } },
    } });
    emitEvent({ event: 'session.message', payload: {
      sessionKey: 'agent:main:voice:direct:nerve-live', messageId: 'voice-1',
      message: { role: 'assistant', content: 'Live reply', provenance: { kind: 'realtime_voice' } },
    } });
    emitEvent({ event: 'session.message', payload: {
      sessionKey: 'agent:main:voice:direct:nerve-live', messageId: 'voice-2',
      message: { role: 'assistant', content: 'Live reply' }, provenance: { kind: 'realtime_voice' },
    } });
    expect(client.sent.filter((item) => item.method === 'thread/realtime/transcript/done'))
      .toEqual([{ method: 'thread/realtime/transcript/done', params: {
        role: 'assistant', text: 'Live reply', eventId: 'voice-1',
      } }]);
    expect(rpc).not.toHaveBeenCalledWith('talk.speak', expect.anything(), expect.anything());

    emitEvent({ event: 'chat', payload: {
      sessionKey: 'agent:main:voice:direct:nerve-live',
      state: 'final', message_id: 'typed-1', message: { role: 'assistant', content: 'Typed reply' },
    } });
    expect(rpc).not.toHaveBeenCalledWith('talk.speak', expect.anything(), expect.anything());
  });
});
