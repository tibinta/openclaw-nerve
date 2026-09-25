import { randomUUID } from 'node:crypto';
import { WebSocket, type RawData } from 'ws';
import { config } from './config.js';
import { gatewayRpcCall, subscribeGatewayEvents } from './gateway-rpc.js';
import { extractJaneCanonicalFinal } from './codex-realtime-proxy.js';

const SESSION_KEY = 'agent:main:voice:direct:nerve-live';
const MAX_MESSAGE_BYTES = 1024 * 1024;

type RpcCall = typeof gatewayRpcCall;
type Subscribe = typeof subscribeGatewayEvents;
type PostOffer = typeof fetch;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function send(ws: WebSocket, method: string, params: Record<string, unknown> = {}): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ method, params }));
}

// Realtime Talk owns its own speech and transcript. Replaying its chat final as
// a second TTS response duplicates the caption and can race the live audio.
function isRealtimeTalkFinal(payload: Record<string, unknown>): boolean {
  const message = record(payload.message);
  const metadata = record(message?.__openclaw);
  const provenance = record(message?.provenance) ?? record(payload.provenance);
  return [payload.runId, metadata?.runId].some((value) =>
    typeof value === 'string' && value.startsWith('talk-realtime-consult:'))
    || provenance?.kind === 'realtime_voice';
}

/** Bridge Jane Live's existing socket protocol to Gateway-owned OpenClaw Talk. */
export function createOpenClawTalkRelay(
  ws: WebSocket,
  rpc: RpcCall = gatewayRpcCall,
  subscribe: Subscribe = subscribeGatewayEvents,
  postOffer: PostOffer = fetch,
): void {
  let voiceSessionId: string | null = null;
  let closed = false;
  let starting = false;
  let liveReady = false;
  const deliveredFinals = new Set<string>();

  const closeTalk = () => {
    if (closed) return;
    closed = true;
    unsubscribe();
    if (voiceSessionId) void rpc('talk.client.close', { sessionKey: SESSION_KEY, voiceSessionId }).catch(() => undefined);
  };

  const deliverFinal = (final: NonNullable<ReturnType<typeof extractJaneCanonicalFinal>>) => {
    if (deliveredFinals.has(final.key)) return;
    deliveredFinals.add(final.key);
    if (deliveredFinals.size > 100) deliveredFinals.delete(deliveredFinals.values().next().value!);

    send(ws, 'thread/realtime/transcript/done', {
      role: 'assistant', text: final.text, eventId: final.key,
    });
    if (!voiceSessionId || !liveReady) return;

    const currentVoiceSessionId = voiceSessionId;
    void rpc('talk.speak', { text: final.text }, 30_000).then((value) => {
      const speech = record(value);
      if (closed || voiceSessionId !== currentVoiceSessionId || !speech
        || typeof speech.audioBase64 !== 'string' || !speech.audioBase64
        || speech.audioBase64.length > 4_000_000) {
        if (!closed && voiceSessionId === currentVoiceSessionId) {
          send(ws, 'thread/realtime/error', { message: 'Jane Live voice reply is unavailable' });
        }
        return;
      }
      send(ws, 'thread/realtime/speech', {
        eventId: final.key,
        audioBase64: speech.audioBase64,
        mimeType: typeof speech.mimeType === 'string' ? speech.mimeType : 'audio/mpeg',
      });
    }).catch(() => {
      if (!closed && voiceSessionId === currentVoiceSessionId) {
        send(ws, 'thread/realtime/error', { message: 'Jane Live voice reply is unavailable' });
      }
    });
  };

  const unsubscribe = subscribe((event) => {
    if (closed) return;
    if (event.event === 'chat' || event.event === 'session.message') {
      const payload = record(event.payload);
      const message = record(payload?.message);
      if (payload && isRealtimeTalkFinal(payload)) return;
      const final = payload && (event.event === 'chat'
        ? extractJaneCanonicalFinal(payload)
        : payload.sessionKey === SESSION_KEY && message?.role === 'assistant'
          ? extractJaneCanonicalFinal({ ...payload, state: 'final' })
          : null);
      if (!final) return;
      deliverFinal(final);
      return;
    }
    if (event.event !== 'talk.event') return;
    const envelope = record(event.payload);
    if (!envelope || envelope.voiceSessionId !== voiceSessionId) return;
    const talkEvent = record(envelope.talkEvent);
    if (!talkEvent || typeof talkEvent.type !== 'string') return;
    const payload = record(talkEvent.payload) ?? {};
    const type = talkEvent.type;
    if (type === 'session.closed') {
      send(ws, 'thread/realtime/closed');
      closeTalk();
      return;
    }
    if (type === 'session.error') {
      send(ws, 'thread/realtime/error', { message: 'OpenClaw Talk error' });
      return;
    }
    if (type === 'tool.call' || type === 'tool.progress' || type === 'tool.result' || type === 'tool.error') {
      const name = payload.name;
      send(ws, 'thread/realtime/activity', {
        state: type === 'tool.error' ? 'error' : type === 'tool.result' ? 'complete' : 'working',
        ...(typeof name === 'string' && /^[\w.:-]{1,80}$/u.test(name) ? { name } : {}),
        ...(typeof talkEvent.callId === 'string' ? { callId: talkEvent.callId } : {}),
        ...(typeof talkEvent.turnId === 'string' ? { turnId: talkEvent.turnId } : {}),
      });
      return;
    }
    const role = type.startsWith('output.text.') ? 'assistant' : type.startsWith('transcript.') ? 'user' : null;
    if (!role) return;
    const value = payload.text;
    if (typeof value !== 'string') return;
    send(ws, type.endsWith('.delta') ? 'thread/realtime/transcript/delta' : 'thread/realtime/transcript/done', {
      role,
      [type.endsWith('.delta') ? 'delta' : 'text']: value,
      ...(typeof payload.entryId === 'string' ? { eventId: payload.entryId } : {}),
    });
  });

  ws.on('message', (raw: RawData) => {
    if (closed) return;
    if (Buffer.byteLength(raw.toString()) > MAX_MESSAGE_BYTES) {
      send(ws, 'thread/realtime/error', { message: 'Voice request too large' });
      return;
    }
    let message: Record<string, unknown> | null;
    try { message = record(JSON.parse(raw.toString())); } catch { message = null; }
    if (!message) return;
    if (message.method === 'thread/realtime/stop') {
      closeTalk();
      send(ws, 'thread/realtime/closed');
      return;
    }
    if (message.method === 'thread/realtime/appendText') {
      send(ws, 'thread/realtime/error', { message: 'Typed text is unavailable in OpenClaw Talk voice sessions' });
      return;
    }
    if (message.method !== 'thread/realtime/start' || starting || voiceSessionId) return;
    const params = record(message.params);
    const transport = record(params?.transport);
    const sdp = transport?.type === 'webrtc' && typeof transport.sdp === 'string' ? transport.sdp : null;
    if (!sdp || Buffer.byteLength(sdp) > MAX_MESSAGE_BYTES) {
      send(ws, 'thread/realtime/error', { message: 'Invalid voice offer' });
      return;
    }
    starting = true;
    void (async () => {
      try {
        const created = record(await rpc('talk.client.create', {
          sessionKey: SESSION_KEY,
          transport: 'webrtc',
          capabilities: ['gateway-control-v1', 'voice-transcript'],
          ...(typeof params?.voice === 'string' ? { voice: params.voice } : {}),
        }, 25_000));
        if (!created || typeof created.voiceSessionId !== 'string') throw new Error('OpenClaw Talk did not create a voice session');
        voiceSessionId = created.voiceSessionId;
        if (closed) {
          void rpc('talk.client.close', { sessionKey: SESSION_KEY, voiceSessionId }).catch(() => undefined);
          return;
        }
        if (created.offerUrl !== '/plugins/openai/realtime/calls' || typeof created.clientSecret !== 'string'
          || record(created.clientControl)?.owner !== 'gateway') throw new Error('OpenClaw Talk did not provide Gateway-controlled WebRTC');
        const answer = await postOffer(new URL(created.offerUrl, config.gatewayUrl), {
          method: 'POST',
          headers: { Authorization: `Bearer ${created.clientSecret}`, 'Content-Type': 'application/sdp' },
          // Reject the iOS events data channel in the answer; Gateway control carries those events.
          body: sdp.replace(/^m=application[ \t]+\d+(?=[ \t])/gm, 'm=application 0'),
          signal: AbortSignal.timeout(35_000),
        });
        if (!answer.ok) throw new Error(`OpenClaw Talk offer failed (${answer.status})`);
        const answerSdp = await answer.text();
        if (!answerSdp) throw new Error('Empty OpenClaw Talk answer');
        if (closed) return;
        send(ws, 'thread/realtime/sdp', { sdp: answerSdp });
        send(ws, 'thread/realtime/started', { voiceSessionId });
        liveReady = true;
      } catch (error) {
        // Gateway errors can contain sensitive request details; keep the browser error bounded.
        send(ws, 'thread/realtime/error', { message: error instanceof Error && error.message.startsWith('OpenClaw Talk offer failed')
          ? error.message : 'OpenClaw Talk could not start' });
        closeTalk();
      } finally {
        starting = false;
      }
    })();
  });

  ws.on('close', closeTalk);
  ws.on('error', closeTalk);
  send(ws, 'nerve/realtime/ready', { id: randomUUID() });
}
