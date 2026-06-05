// Audio feedback using pre-recorded MP3 files served from /sounds/
// Files are preloaded into AudioBuffers for instant, glitch-free playback.

let audioCtx: AudioContext | null = null;
const bufferCache = new Map<string, AudioBuffer>();
const loadingCache = new Map<string, Promise<AudioBuffer | null>>();
const activeSources = new Set<AudioBufferSourceNode>();

export interface AudioFeedbackPlayback {
  played: boolean;
  path: string;
  durationMs: number;
}

/** Preload an audio file into an AudioBuffer. */
function preloadSound(path: string): Promise<AudioBuffer | null> {
  const existing = loadingCache.get(path);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const resp = await fetch(path);
      if (!resp.ok) return null;
      const arrayBuffer = await resp.arrayBuffer();
      if (!audioCtx) audioCtx = new AudioContext();
      const buffer = await audioCtx.decodeAudioData(arrayBuffer);
      bufferCache.set(path, buffer);
      return buffer;
    } catch {
      return null;
    }
  })();

  loadingCache.set(path, promise);
  return promise;
}

function numberedSoundPaths(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}-${String(index + 1).padStart(3, '0')}.mp3`);
}

// Short spoken confirmations. Keep the legacy single files last as safe fallbacks.
const WAKE_CONFIRM_PATHS = [
  ...numberedSoundPaths('/sounds/wake-confirmations/wake', 120),
  '/sounds/wake-alex.mp3',
  '/sounds/wake.mp3',
];
const SEND_CONFIRM_PATHS = [
  ...numberedSoundPaths('/sounds/send-confirmations/send', 120),
  '/sounds/send.ogg',
];
const SOUND_PATHS = [...WAKE_CONFIRM_PATHS, ...SEND_CONFIRM_PATHS, '/sounds/cancel.ogg', '/sounds/notify.ogg'];
if (typeof window !== 'undefined') {
  SOUND_PATHS.forEach(p => void preloadSound(p));
}

function playSound(path: string, playbackRate = 1): AudioFeedbackPlayback {
  try {
    if (!audioCtx) audioCtx = new AudioContext();
    if (audioCtx.state === 'suspended') audioCtx.resume();

    const buffer = bufferCache.get(path);
    if (!buffer) {
      // Not yet loaded — trigger preload for next time, skip this play
      preloadSound(path);
      return { played: false, path, durationMs: 0 };
    }

    const source = audioCtx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = playbackRate;
    source.connect(audioCtx.destination);
    activeSources.add(source);
    source.onended = () => {
      activeSources.delete(source);
    };
    source.start(0);
    return { played: true, path, durationMs: Math.ceil((buffer.duration * 1000) / playbackRate) };
  } catch {
    // AudioContext not available, silently skip
    return { played: false, path, durationMs: 0 };
  }
}

function pickLoaded(paths: string[], fallback: string): string {
  const loaded = paths.filter((path) => bufferCache.has(path));
  if (loaded.length === 0) return fallback;
  return loaded[Math.floor(Math.random() * loaded.length)] || fallback;
}

/** Initialize or resume the AudioContext (call on user interaction to unlock). */
export function ensureAudioContext(): void {
  try {
    if (!audioCtx) audioCtx = new AudioContext();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    // Re-trigger preloads if they failed before context existed
    SOUND_PATHS.forEach(p => { if (!bufferCache.has(p)) preloadSound(p); });
  } catch {
    // AudioContext not available
  }
}

/** Prime Safari/desktop autoplay from a real button tap before async TTS replies arrive later. */
export async function unlockBrowserAudio(): Promise<boolean> {
  try {
    ensureAudioContext();
    const audio = new Audio('/sounds/notify.ogg');
    audio.muted = true;
    audio.volume = 0;
    await audio.play();
    audio.pause();
    audio.src = '';
    return true;
  } catch {
    return false;
  }
}

/** Play ascending ping when wake-word is detected. */
export function playWakePing(): AudioFeedbackPlayback {
  return playSound(pickLoaded(WAKE_CONFIRM_PATHS, '/sounds/wake.mp3'));
}

/** Play confirmation sound when voice input is submitted. */
export function playSubmitPing(): AudioFeedbackPlayback {
  return playSound(pickLoaded(SEND_CONFIRM_PATHS, '/sounds/send.ogg'));
}

/** Play cancel sound when voice input is cancelled. */
export function playCancelPing(): AudioFeedbackPlayback {
  return playSound('/sounds/cancel.ogg');
}

/** Simple notification ping (used for chat completion sounds) */
export function playPing(): AudioFeedbackPlayback {
  return playSound('/sounds/notify.ogg');
}
