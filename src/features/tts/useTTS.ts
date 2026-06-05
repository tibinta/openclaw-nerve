import { useRef, useCallback, useEffect, useState } from 'react';
import { ensureAudioContext } from '@/features/voice/audio-feedback';

// ─── Audio autoplay unlock ─────────────────────────────────────────────────────
// Browsers block audio.play() until the user has interacted with the page.
// We "unlock" audio by resuming the shared AudioContext on the first user gesture,
// which whitelists the origin for subsequent programmatic playback.
if (typeof document !== 'undefined') {
  const events = ['click', 'touchstart', 'keydown'] as const;
  const handler = () => {
    ensureAudioContext();
    events.forEach(e => document.removeEventListener(e, handler, true));
  };
  events.forEach(e => document.addEventListener(e, handler, { capture: true, once: false }));
}

export type TTSProvider = 'holler' | 'openai' | 'replicate' | 'edge' | 'xiaomi';

/** @deprecated Use 'replicate' instead. Kept for migration. */
export type LegacyTTSProvider = 'qwen';

/** Migrate legacy provider names to current ones. */
export function migrateTTSProvider(provider: string): TTSProvider {
  if (provider === 'qwen') return 'replicate';
  if (provider === 'holler' || provider === 'openai' || provider === 'replicate' || provider === 'edge' || provider === 'xiaomi') return provider;
  return 'holler';
}

export interface TTSPlaybackOptions {
  model?: string;
  voice?: string;
}

const TTS_SENTENCE_GAP_MS = 200;
const TTS_CHUNK_MAX_CHARS = 420;
const TTS_SILENCE_THRESHOLD = 0.004;
const TTS_SILENCE_PADDING_SECONDS = 0.035;
const SENTENCE_END_RE = /[.!?…]+["')\]]*$/;
const SOFT_BREAK_RE = /[,;:]["')\]]*$/;

interface PreparedAudioChunk {
  buffer: AudioBuffer;
  context: AudioContext;
}

export function buildTTSRequestBody(
  text: string,
  provider: TTSProvider = 'openai',
  options: TTSPlaybackOptions = {},
): Record<string, string> {
  const body: Record<string, string> = { text, provider };
  if (options.model) body.model = options.model;
  if (options.voice) body.voice = options.voice;
  return body;
}

export function splitSpeechIntoTTSChunks(text: string): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return [];

  const parts = normalized.match(/\S+\s*/g) ?? [];
  const chunks: string[] = [];
  let current = '';

  const pushCurrent = () => {
    const chunk = current.trim();
    if (chunk) chunks.push(chunk);
    current = '';
  };

  for (const part of parts) {
    const word = part.trim();
    if (!word) continue;
    const candidate = current ? `${current} ${word}` : word;
    const shouldHardBreak = SENTENCE_END_RE.test(word) && candidate.length >= 12;
    const shouldSoftBreak = candidate.length >= TTS_CHUNK_MAX_CHARS && SOFT_BREAK_RE.test(word);
    const shouldForceBreak = candidate.length >= TTS_CHUNK_MAX_CHARS + 80;

    if (current && (shouldSoftBreak || shouldForceBreak)) {
      pushCurrent();
      current = word;
      if (SENTENCE_END_RE.test(word)) pushCurrent();
      continue;
    }

    current = candidate;
    if (shouldHardBreak) pushCurrent();
  }

  pushCurrent();
  return chunks;
}

function getAudioContextCtor(): typeof AudioContext | null {
  if (typeof window === 'undefined') return null;
  return window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext || null;
}

async function fetchTTS(text: string, provider: TTSProvider = 'openai', options: TTSPlaybackOptions = {}): Promise<Blob> {
  const body = buildTTSRequestBody(text, provider, options);
  const resp = await fetch('/api/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`TTS failed: ${resp.status}`);
  // Use the server's content type (audio/mpeg for MP3, audio/wav for WAV)
  const arrayBuffer = await resp.arrayBuffer();
  const ct = resp.headers.get('Content-Type') || 'audio/mpeg';
  const blob = new Blob([arrayBuffer], { type: ct });
  return blob;
}

async function fetchTTSWithFallback(text: string, provider: TTSProvider = 'holler', options: TTSPlaybackOptions = {}): Promise<Blob> {
  try {
    return await fetchTTS(text, provider, options);
  } catch (err) {
    if (provider !== 'holler') throw err;
    // Keep replies audible if the local Holler server is not running yet.
    console.warn('[TTS] Holler blob fallback failed; trying Edge:', err instanceof Error ? err.message : String(err));
    return fetchTTS(text, 'edge', options);
  }
}

async function playBlobViaAudioElement(blob: Blob): Promise<{ audio: HTMLAudioElement; url: string }> {
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  try {
    await audio.play();
    return { audio, url };
  } catch (err) {
    URL.revokeObjectURL(url);
    audio.src = '';
    throw err;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForAudioElementToEnd(audio: HTMLAudioElement): Promise<void> {
  return new Promise((resolve, reject) => {
    if (audio.ended) {
      resolve();
      return;
    }
    audio.addEventListener('ended', () => resolve(), { once: true });
    audio.addEventListener('error', () => reject(new Error('Audio playback failed')), { once: true });
  });
}

function getSharedPlaybackContext(): AudioContext {
  ensureAudioContext();
  const AudioContextCtor = getAudioContextCtor();
  if (!AudioContextCtor) throw new Error('AudioContext is not available');
  return new AudioContextCtor();
}

async function prepareBlobViaAudioContext(blob: Blob, context: AudioContext): Promise<PreparedAudioChunk> {
  if (context.state === 'suspended') await context.resume();
  const decoded = await context.decodeAudioData(await blob.arrayBuffer());
  const buffer = trimAudioBufferSilence(context, decoded);
  return { buffer, context };
}

async function playPreparedAudioChunk(chunk: PreparedAudioChunk): Promise<void> {
  const { context, buffer } = chunk;
  if (context.state === 'suspended') await context.resume();
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(context.destination);
  await new Promise<void>((resolve, reject) => {
    source.addEventListener('ended', () => {
      void context.close().catch(() => undefined);
      resolve();
    }, { once: true });
    try {
      source.start(0);
    } catch (err) {
      void context.close().catch(() => undefined);
      reject(err);
    }
  });
}

async function playBlobViaAudioContext(blob: Blob): Promise<void> {
  const context = getSharedPlaybackContext();
  try {
    const prepared = await prepareBlobViaAudioContext(blob, context);
    await playPreparedAudioChunk(prepared);
  } finally {
    await context.close().catch(() => undefined);
  }
}

export function findAudioSpeechBounds(
  channels: Float32Array[],
  sampleRate: number,
  threshold = TTS_SILENCE_THRESHOLD,
  paddingSeconds = TTS_SILENCE_PADDING_SECONDS,
): { start: number; end: number } {
  const length = channels[0]?.length ?? 0;
  if (length === 0) return { start: 0, end: 0 };

  let first = 0;
  let last = length - 1;

  const isAudible = (index: number) => channels.some((channel) => Math.abs(channel[index] ?? 0) >= threshold);
  while (first < length && !isAudible(first)) first++;
  if (first >= length) return { start: 0, end: length };

  while (last > first && !isAudible(last)) last--;

  const padding = Math.round(sampleRate * paddingSeconds);
  return {
    start: Math.max(0, first - padding),
    end: Math.min(length, last + padding + 1),
  };
}

function trimAudioBufferSilence(context: AudioContext, buffer: AudioBuffer): AudioBuffer {
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index));
  const { start, end } = findAudioSpeechBounds(channels, buffer.sampleRate);
  const trimmedLength = end - start;
  if (start === 0 && end === buffer.length) return buffer;
  if (trimmedLength <= Math.round(buffer.sampleRate * 0.08)) return buffer;

  // Holler WAV chunks can include seconds of generated silence. Trim only after
  // decode so speech timing stays natural while chunk transitions stay snappy.
  const trimmed = context.createBuffer(buffer.numberOfChannels, trimmedLength, buffer.sampleRate);
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    trimmed.copyToChannel(buffer.getChannelData(channel).slice(start, end), channel);
  }
  return trimmed;
}

async function playHollerPcmStream(text: string, options: TTSPlaybackOptions = {}): Promise<void> {
  ensureAudioContext();
  const AudioContextCtor = getAudioContextCtor();
  if (!AudioContextCtor) throw new Error('AudioContext is not available');
  const context = new AudioContextCtor({ sampleRate: 24000 });
  if (context.state === 'suspended') await context.resume();

  const resp = await fetch('/api/tts/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(buildTTSRequestBody(text, 'holler', options)),
  });
  if (!resp.ok || !resp.body) {
    await context.close().catch(() => undefined);
    throw new Error(`Holler stream failed: ${resp.status}`);
  }

  const reader = resp.body.getReader();
  const sampleRate = Number(resp.headers.get('X-Audio-Sample-Rate')) || 24000;
  let nextStartTime = context.currentTime + 0.04;
  let pending = new Uint8Array(0);
  const sources: AudioBufferSourceNode[] = [];

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;

      const merged = new Uint8Array(pending.byteLength + value.byteLength);
      merged.set(pending, 0);
      merged.set(value, pending.byteLength);

      const alignedBytes = merged.byteLength - (merged.byteLength % 4);
      if (alignedBytes === 0) {
        pending = merged;
        continue;
      }

      const chunkBytes = merged.slice(0, alignedBytes);
      pending = merged.slice(alignedBytes);
      const floats = new Float32Array(chunkBytes.buffer, chunkBytes.byteOffset, chunkBytes.byteLength / 4);
      const audioBuffer = context.createBuffer(1, floats.length, sampleRate);
      audioBuffer.copyToChannel(floats, 0);

      const source = context.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(context.destination);
      source.start(nextStartTime);
      sources.push(source);
      nextStartTime += audioBuffer.duration;
    }

    const waitMs = Math.max(0, (nextStartTime - context.currentTime) * 1000) + 120;
    await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
  } finally {
    sources.forEach((source) => {
      try {
        source.disconnect();
      } catch {
        // Already ended.
      }
    });
    await context.close().catch(() => undefined);
  }
}

/**
 * Hook that provides a `speak` function for text-to-speech playback.
 *
 * Audio is fetched from `/api/tts` and played via an `HTMLAudioElement`.
 * Successive calls are queued so a new assistant answer waits for the current
 * spoken answer to finish instead of cutting it off or replaying stale audio.
 */
export function useTTS(enabled: boolean, provider: TTSProvider = 'openai', modelOrOptions?: string | TTSPlaybackOptions) {
  const currentAudio = useRef<{ audio: HTMLAudioElement; url: string } | null>(null);
  const generationRef = useRef(0);
  const playbackQueueRef = useRef<Promise<void>>(Promise.resolve());
  const pendingSpeechCountRef = useRef(0);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const model = typeof modelOrOptions === 'string' ? modelOrOptions : modelOrOptions?.model;
  const voice = typeof modelOrOptions === 'string' ? undefined : modelOrOptions?.voice;

  const cleanupAudio = useCallback(() => {
    const current = currentAudio.current;
    if (!current) return;
    current.audio.pause();
    current.audio.src = '';
    URL.revokeObjectURL(current.url);
    currentAudio.current = null;
  }, []);

  useEffect(() => {
    return () => {
      generationRef.current++;
      cleanupAudio();
    };
  }, [cleanupAudio]);

  const playBlobChunk = useCallback(async (blob: Blob, gen: number) => {
    if (gen !== generationRef.current) return;

    let playback: { audio: HTMLAudioElement; url: string } | null = null;
    try {
      await playBlobViaAudioContext(blob);
      return;
    } catch (err) {
      // Keep audio alive if Web Audio cannot decode a provider response.
      // The fallback may include provider silence, but it is better than a
      // silent failed reply.
      console.warn('[TTS] Web Audio playback failed; trying audio element fallback:', err instanceof Error ? err.message : String(err));
      playback = await playBlobViaAudioElement(blob);
    }

    if (gen !== generationRef.current) {
      playback.audio.pause();
      playback.audio.src = '';
      URL.revokeObjectURL(playback.url);
      return;
    }

    const { audio, url } = playback;
    currentAudio.current = { audio, url };
    let revoked = false;
    const revoke = () => {
      if (revoked) return;
      revoked = true;
      URL.revokeObjectURL(url);
      if (currentAudio.current?.audio === audio) {
        currentAudio.current = null;
      }
    };
    audio.addEventListener('ended', revoke, { once: true });
    audio.addEventListener('error', () => revoke(), { once: true });
    try {
      await waitForAudioElementToEnd(audio);
    } catch (err) {
      revoke();
      throw err;
    }
  }, []);

  const playPreparedChunk = useCallback(async (prepared: PreparedAudioChunk, gen: number) => {
    if (gen !== generationRef.current) return;
    await playPreparedAudioChunk(prepared);
  }, []);

  const playSpeechNow = useCallback(async (text: string, gen: number) => {
    if (!enabled || !text) return;
    const chunks = splitSpeechIntoTTSChunks(text);
    if (chunks.length === 0) return;

    try {
      if (provider === 'holler' && chunks.length === 1) {
        for (let i = 0; i < chunks.length; i++) {
          if (gen !== generationRef.current) return;
          try {
            await playHollerPcmStream(chunks[i], { model, voice });
          } catch (err) {
            if (gen !== generationRef.current) return;
            console.warn('[TTS] Holler stream failed; trying fallback audio:', err instanceof Error ? err.message : String(err));
            const blob = await fetchTTSWithFallback(chunks[i], 'holler', { model, voice });
            await playBlobChunk(blob, gen);
          }
          if (gen !== generationRef.current) return;
          if (i < chunks.length - 1) await delay(TTS_SENTENCE_GAP_MS);
        }
        return;
      }

      // Start every sentence render and Web Audio decode immediately, then
      // consume prepared buffers in text order. This keeps the first sentence
      // snappy and removes provider/decode waits between later sentences.
      let queueContext: AudioContext | null = null;
      let preparedChunks: Array<Promise<PreparedAudioChunk>> = [];
      try {
        queueContext = getSharedPlaybackContext();
        preparedChunks = chunks.map(async (chunk) => {
          const blob = await fetchTTSWithFallback(chunk, provider, { model, voice });
          return prepareBlobViaAudioContext(blob, queueContext as AudioContext);
        });

        for (let i = 0; i < preparedChunks.length; i++) {
          if (gen !== generationRef.current) return;
          const prepared = await preparedChunks[i];
          if (gen !== generationRef.current) return;
          await playPreparedChunk(prepared, gen);
          if (gen !== generationRef.current) return;
          if (i < preparedChunks.length - 1) await delay(TTS_SENTENCE_GAP_MS);
        }
      } catch (err) {
        if (gen !== generationRef.current) return;
        await Promise.allSettled(preparedChunks);
        console.warn('[TTS] Prepared Web Audio queue failed; using audio element queue:', err instanceof Error ? err.message : String(err));
        const chunkAudio = chunks.map((chunk) => fetchTTSWithFallback(chunk, provider, { model, voice }));
        for (let i = 0; i < chunkAudio.length; i++) {
          if (gen !== generationRef.current) return;
          const blob = await chunkAudio[i];
          if (gen !== generationRef.current) return;
          await playBlobChunk(blob, gen);
          if (gen !== generationRef.current) return;
          if (i < chunkAudio.length - 1) await delay(TTS_SENTENCE_GAP_MS);
        }
      } finally {
        await queueContext?.close().catch(() => undefined);
      }
    } catch (err: unknown) {
      console.error('[TTS] play failed:', err instanceof Error ? err.message : String(err));
    } finally {
      // The public queue owns isSpeaking so multiple queued answers do not
      // flicker between chunks or between consecutive assistant replies.
    }
  }, [enabled, provider, model, voice, playBlobChunk, playPreparedChunk]);

  const speak = useCallback((text: string): Promise<void> => {
    if (!enabled || !text) return Promise.resolve();
    const speechText = text.trim();
    if (!speechText) return Promise.resolve();

    const gen = generationRef.current;
    pendingSpeechCountRef.current += 1;
    setIsSpeaking(true);

    const task = playbackQueueRef.current
      .catch(() => undefined)
      .then(() => playSpeechNow(speechText, gen))
      .finally(() => {
        pendingSpeechCountRef.current = Math.max(0, pendingSpeechCountRef.current - 1);
        if (pendingSpeechCountRef.current === 0 && gen === generationRef.current) {
          setIsSpeaking(false);
        }
      });

    playbackQueueRef.current = task;
    return task;
  }, [enabled, playSpeechNow]);

  return { speak, isSpeaking };
}

const TTS_PREFIX = '[tts: ';

function findTTSMarkerEnd(text: string, start: number): number {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === '[') {
      depth++;
      continue;
    }
    if (ch === ']') {
      if (depth === 0) return i;
      depth--;
    }
  }
  return -1;
}

/** Strip canonical `[tts: ...]` markers from text, returning cleaned text and the first TTS text found. */
export function extractTTSMarkers(text: string): { cleaned: string; ttsText: string | null } {
  let cursor = 0;
  let cleaned = '';
  let ttsText: string | null = null;

  while (cursor < text.length) {
    const start = text.indexOf(TTS_PREFIX, cursor);
    if (start === -1) {
      cleaned += text.slice(cursor);
      break;
    }

    cleaned += text.slice(cursor, start);

    const payloadStart = start + TTS_PREFIX.length;
    const end = findTTSMarkerEnd(text, payloadStart);
    if (end === -1) {
      cleaned += text.slice(start);
      break;
    }

    if (ttsText === null) {
      const payload = text.slice(payloadStart, end).trim();
      if (payload) ttsText = payload;
    }

    cursor = end + 1;
  }

  return { cleaned: cleaned.trim(), ttsText };
}
