import { useRef, useCallback, useEffect } from 'react';
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

export type TTSProvider = 'openai' | 'replicate' | 'edge' | 'xiaomi';

/** @deprecated Use 'replicate' instead. Kept for migration. */
export type LegacyTTSProvider = 'qwen';

/** Migrate legacy provider names to current ones. */
export function migrateTTSProvider(provider: string): TTSProvider {
  if (provider === 'qwen') return 'replicate';
  if (provider === 'openai' || provider === 'replicate' || provider === 'edge' || provider === 'xiaomi') return provider;
  return 'openai';
}

async function fetchTTS(text: string, provider: TTSProvider = 'openai', model?: string): Promise<Blob> {
  const body: Record<string, string> = { text, provider };
  if (model) body.model = model;
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

/**
 * Hook that provides a `speak` function for text-to-speech playback.
 *
 * Audio is fetched from `/api/tts` and played via an `HTMLAudioElement`.
 * Successive calls cancel the previous utterance automatically.
 */
export function useTTS(enabled: boolean, provider: TTSProvider = 'openai', model?: string) {
  const currentAudio = useRef<{ audio: HTMLAudioElement; url: string } | null>(null);
  const generationRef = useRef(0);

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

  const speak = useCallback(async (text: string) => {
    if (!enabled || !text) return;
    cleanupAudio();
    const gen = ++generationRef.current;
    try {
      const blob = await fetchTTS(text, provider, model);
      // Superseded by a newer speak() call during fetch
      if (gen !== generationRef.current) return;
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
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
        await audio.play();
      } catch (err) {
        revoke();
        throw err;
      }
    } catch (err: unknown) {
      console.error('[TTS] play failed:', err instanceof Error ? err.message : String(err));
    }
  }, [enabled, provider, model, cleanupAudio]);

  return { speak };
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
