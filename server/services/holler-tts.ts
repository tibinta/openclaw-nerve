/**
 * Holler local TTS provider.
 *
 * Holler runs as a separate Apple Silicon-optimized HTTP server. We keep this
 * adapter small and fail fast so Nerve can fall back to its older TTS providers
 * when Holler is not installed, still downloading, or asleep.
 */
import { getTTSConfig } from '../lib/tts-config.js';
import { DEFAULT_HOLLER_VOICE } from '../lib/voice-providers.js';

export interface HollerTTSResult {
  ok: true;
  buf: Buffer;
  contentType: string;
}

export interface HollerTTSError {
  ok: false;
  status: number;
  message: string;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '') || 'http://127.0.0.1:8100';
}

function parseCodebooks(value: string): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 1 && parsed <= 16 ? parsed : 12;
}

function parseTemperature(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0.7;
}

function buildPayload(text: string, voice?: string): Record<string, string | number | boolean> {
  const cfg = getTTSConfig().holler;
  return {
    text,
    voice: voice || cfg.voice || DEFAULT_HOLLER_VOICE,
    temperature: parseTemperature(cfg.temperature),
    n_codebooks: parseCodebooks(cfg.nCodebooks),
    continue: false,
  };
}

/** Stream raw Float32 PCM from Holler `/speak`. */
export async function streamHollerSpeech(text: string, voice?: string): Promise<Response | HollerTTSError> {
  const cfg = getTTSConfig().holler;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const resp = await fetch(`${normalizeBaseUrl(cfg.baseUrl)}/speak`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildPayload(text, voice)),
      signal: controller.signal,
    });

    if (!resp.ok || !resp.body) {
      return { ok: false, status: resp.status || 502, message: await resp.text().catch(() => 'Holler TTS failed') };
    }

    return new Response(resp.body, {
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Audio-Format': 'float32-pcm',
        'X-Audio-Sample-Rate': '24000',
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 502, message: `Holler unavailable: ${message}` };
  } finally {
    clearTimeout(timeout);
  }
}

/** Generate a complete WAV through Holler `/tts` for the existing blob playback path. */
export async function synthesizeHoller(text: string, voice?: string): Promise<HollerTTSResult | HollerTTSError> {
  const cfg = getTTSConfig().holler;
  const url = new URL(`${normalizeBaseUrl(cfg.baseUrl)}/tts`);
  url.searchParams.set('text', text);
  url.searchParams.set('voice', voice || cfg.voice || DEFAULT_HOLLER_VOICE);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) {
      return { ok: false, status: resp.status || 502, message: await resp.text().catch(() => 'Holler TTS failed') };
    }

    return {
      ok: true,
      buf: Buffer.from(await resp.arrayBuffer()),
      contentType: resp.headers.get('Content-Type') || 'audio/wav',
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 502, message: `Holler unavailable: ${message}` };
  } finally {
    clearTimeout(timeout);
  }
}
