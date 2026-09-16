import { useCallback, useEffect, useRef, useState } from 'react';
import {
  publishCodexRealtimeApproval,
  readCodexRealtimeVoice,
  setCodexRealtimeApprovalResolver,
} from './codexRealtimeBridge';

type RealtimeStatus = 'idle' | 'connecting' | 'listening' | 'speaking';

interface RealtimeCaption {
  role: 'user' | 'assistant';
  text: string;
}

export interface RealtimeTranscriptUpdate extends RealtimeCaption {
  final: boolean;
}

interface ProtocolMessage {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  error?: { message?: string };
}

const START_TIMEOUT_MS = 20_000;
const CAPTION_RENDER_INTERVAL_MS = 50;

export function useCodexRealtimeVoice(
  onTranscript?: (update: RealtimeTranscriptUpdate) => void,
) {
  const [status, setStatus] = useState<RealtimeStatus>('idle');
  const [caption, setCaption] = useState<RealtimeCaption | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isMicrophoneMuted, setIsMicrophoneMuted] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const nextIdRef = useRef(1);
  const transcriptRef = useRef<Record<'user' | 'assistant', string>>({ user: '', assistant: '' });
  const pendingCaptionRef = useRef<RealtimeCaption | null>(null);
  const captionTimerRef = useRef<number | null>(null);
  const startedRef = useRef(false);
  const startingRef = useRef(false);
  const startResultRef = useRef<((started: boolean) => void) | null>(null);
  const microphoneMutedRef = useRef(false);

  const toggleMicrophoneMuted = useCallback(() => {
    const muted = !microphoneMutedRef.current;
    microphoneMutedRef.current = muted;
    streamRef.current?.getAudioTracks().forEach((track) => { track.enabled = !muted; });
    setIsMicrophoneMuted(muted);
  }, []);

  const send = useCallback((method: string, params: Record<string, unknown> = {}) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('GPT-Live is not connected');
    socket.send(JSON.stringify({ id: nextIdRef.current++, method, params }));
  }, []);

  const cancelPendingCaption = useCallback(() => {
    if (captionTimerRef.current !== null) window.clearTimeout(captionTimerRef.current);
    captionTimerRef.current = null;
    pendingCaptionRef.current = null;
  }, []);

  const flushPendingCaption = useCallback(() => {
    captionTimerRef.current = null;
    const nextCaption = pendingCaptionRef.current;
    pendingCaptionRef.current = null;
    if (nextCaption) setCaption(nextCaption);
  }, []);

  const queueCaption = useCallback((nextCaption: RealtimeCaption) => {
    pendingCaptionRef.current = nextCaption;
    if (captionTimerRef.current !== null) return;
    captionTimerRef.current = window.setTimeout(flushPendingCaption, CAPTION_RENDER_INTERVAL_MS);
  }, [flushPendingCaption]);

  const disconnect = useCallback((preserveMicrophone: boolean) => {
    cancelPendingCaption();
    const socket = socketRef.current;
    socketRef.current = null;
    setCodexRealtimeApprovalResolver(null);
    peerRef.current?.close();
    if (audioRef.current) audioRef.current.srcObject = null;
    socket?.close();
    peerRef.current = null;
    audioRef.current = null;
    if (!preserveMicrophone) {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      microphoneMutedRef.current = false;
      setIsMicrophoneMuted(false);
    }
    transcriptRef.current = { user: '', assistant: '' };
    startedRef.current = false;
    startingRef.current = false;
    startResultRef.current?.(false);
    startResultRef.current = null;
    setStatus('idle');
  }, [cancelPendingCaption]);

  const stop = useCallback(() => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        id: nextIdRef.current++,
        method: 'thread/realtime/stop',
        params: {},
      }));
    }
    disconnect(false);
  }, [disconnect]);

  const sendText = useCallback((text: string) => {
    const clean = text.trim();
    if (!clean) return;
    send('thread/realtime/appendText', { role: 'user', text: clean });
  }, [send]);

  const start = useCallback(async (): Promise<boolean> => {
    if (socketRef.current || startingRef.current) return startedRef.current;
    startingRef.current = true;
    cancelPendingCaption();
    setError(null);
    setCaption(null);
    setStatus('connecting');

    try {
      const existingStream = streamRef.current;
      const stream = existingStream?.getAudioTracks().some((track) => track.readyState !== 'ended')
        ? existingStream
        : await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
      stream.getAudioTracks().forEach((track) => { track.enabled = !microphoneMutedRef.current; });
      streamRef.current = stream;
      const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(`${scheme}//${window.location.host}/codex-realtime`);
      socketRef.current = socket;
      setCodexRealtimeApprovalResolver((id, decision) => {
        if (socket.readyState !== WebSocket.OPEN) throw new Error('GPT-Live is not connected');
        socket.send(JSON.stringify({ id, result: { decision } }));
        publishCodexRealtimeApproval(null);
      });

      const started = new Promise<boolean>((resolve) => {
        startResultRef.current = resolve;
        window.setTimeout(() => {
          if (startResultRef.current !== resolve) return;
          startResultRef.current = null;
          resolve(false);
          setError('GPT-Live took too long to connect');
          disconnect(true);
        }, START_TIMEOUT_MS);
      });

      socket.onmessage = (event) => {
        if (socketRef.current !== socket) return;
        let message: ProtocolMessage;
        try {
          message = JSON.parse(String(event.data)) as ProtocolMessage;
        } catch {
          return;
        }
        const params = message.params ?? {};

        if (message.id !== undefined && (message.method === 'item/commandExecution/requestApproval'
          || message.method === 'item/fileChange/requestApproval')) {
          publishCodexRealtimeApproval({ id: message.id, method: message.method, params });
          return;
        }

        if (message.method === 'nerve/realtime/ready') {
          void (async () => {
            const peer = new RTCPeerConnection();
            const audio = new Audio();
            audio.autoplay = true;
            peer.ontrack = (trackEvent) => {
              audio.srcObject = trackEvent.streams[0];
              void audio.play().catch(() => undefined);
            };
            peer.addTrack(stream.getAudioTracks()[0], stream);
            peer.createDataChannel('oai-events');
            peerRef.current = peer;
            audioRef.current = audio;
            const offer = await peer.createOffer();
            await peer.setLocalDescription(offer);
            if (!offer.sdp) throw new Error('Browser did not create a voice offer');
            send('thread/realtime/start', {
              voice: readCodexRealtimeVoice(),
              transport: { type: 'webrtc', sdp: offer.sdp },
            });
          })().catch((startError) => {
            setError(startError instanceof Error ? startError.message : 'GPT-Live could not start');
            disconnect(true);
          });
          return;
        }

        if (message.method === 'thread/realtime/sdp' && typeof params.sdp === 'string') {
          void peerRef.current?.setRemoteDescription({ type: 'answer', sdp: params.sdp });
          return;
        }

        if (message.method === 'thread/realtime/started') {
          startingRef.current = false;
          startedRef.current = true;
          setStatus('listening');
          startResultRef.current?.(true);
          startResultRef.current = null;
          return;
        }

        if (message.method === 'thread/realtime/transcript/delta') {
          const role = params.role === 'assistant' ? 'assistant' : params.role === 'user' ? 'user' : null;
          if (!role || typeof params.delta !== 'string') return;
          transcriptRef.current[role] += params.delta;
          const text = transcriptRef.current[role];
          queueCaption({ role, text });
          onTranscript?.({ role, text, final: false });
          setStatus(role === 'assistant' ? 'speaking' : 'listening');
          return;
        }

        if (message.method === 'thread/realtime/transcript/done') {
          const role = params.role === 'assistant' ? 'assistant' : params.role === 'user' ? 'user' : null;
          if (!role || typeof params.text !== 'string') return;
          const text = params.text.trim();
          transcriptRef.current[role] = '';
          cancelPendingCaption();
          if (text) setCaption({ role, text });
          if (text) onTranscript?.({ role, text, final: true });
          setStatus('listening');
          return;
        }

        if (message.method === 'thread/realtime/error' || message.error) {
          const detail = typeof params.message === 'string' ? params.message : message.error?.message;
          if (!startedRef.current) {
            setError(detail || 'GPT-Live voice failed');
            disconnect(true);
            return;
          }
          transcriptRef.current.assistant = '';
          setError('Voice playback was interrupted; listening is still active.');
          setStatus('listening');
          return;
        }
        if (message.method === 'thread/realtime/closed') {
          const wasStarted = startedRef.current;
          if (wasStarted) setError('GPT-Live disconnected; reconnecting automatically…');
          disconnect(true);
        }
      };

      socket.onerror = () => setError('GPT-Live connection failed');
      socket.onclose = () => {
        if (socketRef.current !== socket) return;
        const wasStarted = startedRef.current;
        if (wasStarted) setError('GPT-Live disconnected; reconnecting automatically…');
        disconnect(true);
      };
      return await started;
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : 'Microphone unavailable');
      disconnect(true);
      return false;
    }
  }, [cancelPendingCaption, disconnect, onTranscript, queueCaption, send]);

  useEffect(() => stop, [stop]);

  const clearError = useCallback(() => setError(null), []);

  return { status, caption, error, isMicrophoneMuted, toggleMicrophoneMuted, start, stop, sendText, clearError };
}
