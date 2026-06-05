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
const SENTENCE_END_RE = /[.!?…]+["')\]]*$/;
const SOFT_BREAK_RE = /[,;:]["')\]]*$/;

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

async function playBlobViaAudioContext(blob: Blob): Promise<void> {
  ensureAudioContext();
  const AudioContextCtor = getAudioContextCtor();
  if (!AudioContextCtor) throw new Error('AudioContext is not available');
  const context = new AudioContextCtor();
  if (context.state === 'suspended') await context.resume();
  const buffer = await context.decodeAudioData(await blob.arrayBuffer());
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
 * Successive calls cancel the previous utterance automatically.
 */
export function useTTS(enabled: boolean, provider: TTSProvider = 'openai', modelOrOptions?: string | TTSPlaybackOptions) {
  const currentAudio = useRef<{ audio: HTMLAudioElement; url: string } | null>(null);
  const generationRef = useRef(0);
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
      cleanupAudio();
    };
  }, [cleanupAudio]);

  const playChunk = useCallback(async (chunk: string, gen: number) => {
    if (provider === 'holler') {
      try {
        await playHollerPcmStream(chunk, { model, voice });
        return;
      } catch (err) {
        if (gen !== generationRef.current) return;
        console.warn('[TTS] Holler stream failed; trying fallback audio:', err instanceof Error ? err.message : String(err));
      }
    }

    const blob = await fetchTTSWithFallback(chunk, provider, { model, voice });
    if (gen !== generationRef.current) return;

    let playback: { audio: HTMLAudioElement; url: string } | null = null;
    try {
      playback = await playBlobViaAudioElement(blob);
    } catch (err) {
      // Safari can reject blob-backed HTMLAudioElement playback after async TTS.
      // Decode the same audio into Web Audio as a recovery path so the queue
      // keeps speaking instead of stopping at the first rejected blob.
      console.warn('[TTS] audio element playback failed; trying Web Audio fallback:', err instanceof Error ? err.message : String(err));
      await playBlobViaAudioContext(blob);
      return;
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
  }, [provider, model, voice]);

  const speak = useCallback(async (text: string) => {
    if (!enabled || !text) return;
    cleanupAudio();
    const gen = ++generationRef.current;
    const chunks = splitSpeechIntoTTSChunks(text);
    if (chunks.length === 0) return;

    setIsSpeaking(true);
    try {
      for (let i = 0; i < chunks.length; i++) {
        if (gen !== generationRef.current) return;
        await playChunk(chunks[i], gen);
        if (gen !== generationRef.current) return;
        if (i < chunks.length - 1) await delay(TTS_SENTENCE_GAP_MS);
      }
    } catch (err: unknown) {
      console.error('[TTS] play failed:', err instanceof Error ? err.message : String(err));
    } finally {
      if (gen === generationRef.current) {
        setIsSpeaking(false);
      }
    }
  }, [enabled, cleanupAudio, playChunk]);

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
