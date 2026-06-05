import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { buildPrimaryWakePhrase, buildStopPhrasesRegex } from '@/lib/constants';
import { normalizeVoiceTranscript } from '@/lib/voiceTranscript';
import { playWakePing, playSubmitPing, playCancelPing, ensureAudioContext } from './audio-feedback';
import type { STTInputMode } from '@/contexts/SettingsContext';
import { getWakeWordSupport } from './wakeWordSupport';

// ─── Phrases from server config ──────────────────────────────────────────────

interface VoicePhrases {
  stopPhrases: string[];
  cancelPhrases: string[];
  wakePhrases?: string[];
}

const DEFAULT_PHRASES: VoicePhrases = {
  stopPhrases: ["boom", "i'm done", "im done", "all right i'm done", "alright i'm done", "that's it", "thats it", "send it", "done"],
  cancelPhrases: ['cancel', 'never mind', 'nevermind'],
};

let phrasesCache: { lang: string; phrases: VoicePhrases } | null = null;

/** Fetch effective voice phrases for the given language (no English merge). */
async function fetchVoicePhrases(lang?: string): Promise<VoicePhrases> {
  const effectiveLang = lang || 'en';
  if (phrasesCache && phrasesCache.lang === effectiveLang) return phrasesCache.phrases;
  try {
    const resp = await fetch(`/api/voice-phrases?lang=${effectiveLang}`, { signal: AbortSignal.timeout(3000) });
    if (!resp.ok) return DEFAULT_PHRASES;
    const data = await resp.json();
    const phrases: VoicePhrases = {
      stopPhrases: Array.isArray(data.stopPhrases) ? data.stopPhrases : DEFAULT_PHRASES.stopPhrases,
      cancelPhrases: Array.isArray(data.cancelPhrases) ? data.cancelPhrases : DEFAULT_PHRASES.cancelPhrases,
      wakePhrases: Array.isArray(data.wakePhrases) ? data.wakePhrases : undefined,
    };
    phrasesCache = { lang: effectiveLang, phrases };
    return phrases;
  } catch {
    return DEFAULT_PHRASES;
  }
}

/** Invalidate the phrase cache (call when language changes). */
export function invalidatePhrasesCache(): void {
  phrasesCache = null;
}

const WAKE_WORD_KEY = 'nerve:wakeWordEnabled';
const SILENCE_RMS_THRESHOLD = 0.018;
const SILENCE_CHECK_MS = 200;
const SILENCE_MIN_RECORDING_MS = 900;
const SILENCE_NO_SPEECH_LIMIT_MS = 10000;
const WAKE_CONFIRM_FALLBACK_DELAY_MS = 1800;
const WAKE_CONFIRM_OUTRO_PAD_MS = 250;

export interface StartRecordingOptions {
  pauseMs?: number;
  noSpeechTimeoutMs?: number;
}

type BrowserAudioContext = typeof AudioContext;

function getSupportedRecordingMimeType(): string | undefined {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/aac',
  ];
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
    return undefined;
  }
  return candidates.find((type) => MediaRecorder.isTypeSupported(type));
}

/** Get SpeechRecognition constructor with webkit prefix fallback. */
function getSpeechRecognition(): SpeechRecognitionConstructor | undefined {
  const w = window as WindowWithSpeechRecognition;
  return w.SpeechRecognition || w.webkitSpeechRecognition;
}

export type VoiceState = 'idle' | 'listening' | 'recording' | 'transcribing';

function normalizeForMatch(text: string, language: string): string {
  const normalized = (text || '')
    .normalize('NFKC')
    .replace(/[’`´]/g, "'")
    .replace(/[.,!?،؟。！？؛…]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) return '';

  const code = (language || '').trim();
  if (code) {
    try {
      return normalized.toLocaleLowerCase(code);
    } catch {
      // Fall back to default lowercasing below.
    }
  }

  return normalized.toLowerCase();
}

function matchesPhrase(transcript: string, phrases: string[], language: string): boolean {
  const normalizedTranscript = normalizeForMatch(transcript, language);
  if (!normalizedTranscript) return false;

  return phrases.some((phrase) => {
    const normalizedPhrase = normalizeForMatch(phrase, language);
    return normalizedPhrase.length > 0 && normalizedTranscript.includes(normalizedPhrase);
  });
}

function cleanTranscript(text: string, stopPhrasesRegex: RegExp): string {
  return normalizeVoiceTranscript((text || '').trim().replace(stopPhrasesRegex, '').trim());
}

/**
 * Hook that manages voice input via the Web Speech API and MediaRecorder.
 *
 * Supports wake-word activation, stop/cancel phrases, and double-tap left-Shift
 * as a keyboard shortcut. Audio is recorded as WebM/Opus and sent to
 * `/api/transcribe` for server-side speech-to-text.
 *
 * @param onTranscription - Callback invoked with the cleaned transcription text.
 * @param agentName - Agent display name used to build dynamic wake phrases.
 * @param language - Active language code used for recognition and phrase matching.
 * @param phrasesVersion - Incrementing token to force phrase reloads after config edits.
 * @param sttInputMode - Finalization strategy for browser vs backend transcription.
 */
/** Map ISO 639-1 language code to BCP-47 locale for Web Speech API. */
export const LANG_TO_BCP47: Record<string, string> = {
  en: 'en-US',
  zh: 'zh-CN',
  hi: 'hi-IN',
  es: 'es-ES',
  fr: 'fr-FR',
  ar: 'ar-SA',
  bn: 'bn-IN',
  pt: 'pt-BR',
  ru: 'ru-RU',
  ja: 'ja-JP',
  de: 'de-DE',
  tr: 'tr-TR',
};

/** Resolve UI language setting to a valid recognition locale. */
export function resolveRecognitionLang(language: string): string {
  const normalized = (language || '').trim().toLowerCase();

  if (!normalized || normalized === 'auto') {
    return LANG_TO_BCP47.en;
  }

  if (LANG_TO_BCP47[normalized]) {
    return LANG_TO_BCP47[normalized];
  }

  // Already a locale-like value (e.g. en-GB)
  if (language.includes('-')) {
    return language;
  }

  return LANG_TO_BCP47.en;
}

export function useVoiceInput(
  onTranscription: (text: string) => void,
  agentName: string = 'Agent',
  language: string = 'en',
  phrasesVersion: number = 0,
  sttInputMode: STTInputMode = 'hybrid',
  autoStopAfterSilenceMs?: number,
  suppressWakeWordResume: boolean = false,
  wakeAutoStopAfterSilenceMs?: number,
) {
  const [state, setState] = useState<VoiceState>('idle');
  const stateRef = useRef<VoiceState>('idle');
  const [interimTranscript, setInterimTranscript] = useState('');
  const [error, setError] = useState<string | null>(null);
  const clearError = useCallback(() => setError(null), []);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const lastCapsTimeRef = useRef(0);
  const onTranscriptionRef = useRef(onTranscription);
  onTranscriptionRef.current = onTranscription;
  const sttInputModeRef = useRef(sttInputMode);
  sttInputModeRef.current = sttInputMode;
  const autoStopAfterSilenceMsRef = useRef(autoStopAfterSilenceMs);
  autoStopAfterSilenceMsRef.current = autoStopAfterSilenceMs;
  const wakeAutoStopAfterSilenceMsRef = useRef(wakeAutoStopAfterSilenceMs);
  wakeAutoStopAfterSilenceMsRef.current = wakeAutoStopAfterSilenceMs;
  const suppressWakeWordResumeRef = useRef(suppressWakeWordResume);
  suppressWakeWordResumeRef.current = suppressWakeWordResume;

  // Single persistent recognition instance
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const wakeWordSupport = useMemo(() => getWakeWordSupport(), []);
  const wakeWordSupported = wakeWordSupport.supported;
  const [storedWakeWordEnabled, setStoredWakeWordEnabled] = useState(() => {
    try { return localStorage.getItem(WAKE_WORD_KEY) === 'true'; } catch { return false; }
  });
  const wakeWordEnabled = wakeWordSupported ? storedWakeWordEnabled : false;
  const wakeWordEnabledRef = useRef(wakeWordEnabled);

  useEffect(() => {
    wakeWordEnabledRef.current = wakeWordEnabled;
  }, [wakeWordEnabled]);

  // Persist raw desktop preference to localStorage without mutating it on unsupported mobile web.
  useEffect(() => {
    try { localStorage.setItem(WAKE_WORD_KEY, String(storedWakeWordEnabled)); } catch { /* noop */ }
  }, [storedWakeWordEnabled]);

  // Single primary wake phrase based on agent name + selected language.
  const defaultWakePhrase = useMemo(() => buildPrimaryWakePhrase(agentName, language), [agentName, language]);

  // Phrases loaded from server config — refetch when language or phrase config changes
  const [phrases, setPhrases] = useState<VoicePhrases>(phrasesCache?.phrases || DEFAULT_PHRASES);
  useEffect(() => {
    invalidatePhrasesCache();
    fetchVoicePhrases(language).then(setPhrases);
  }, [language, phrasesVersion]);

  // Use a single wake phrase per language (custom phrase wins over generated default).
  const wakePhrases = useMemo(() => {
    const primaryWake = buildPrimaryWakePhrase(agentName, language, phrases.wakePhrases);
    return primaryWake ? [primaryWake] : [defaultWakePhrase];
  }, [agentName, language, phrases.wakePhrases, defaultWakePhrase]);

  const stopPhrasesRegex = useMemo(
    () => buildStopPhrasesRegex(agentName, {
      language,
      stopPhrases: phrases.stopPhrases,
      cancelPhrases: phrases.cancelPhrases,
      wakePhrases,
    }),
    [agentName, language, phrases.cancelPhrases, phrases.stopPhrases, wakePhrases],
  );
  // Refs to access current values in callbacks without stale closures
  // (event handlers are set up once but need fresh phrase values)
  const wakePhrasesRef = useRef(wakePhrases);
  wakePhrasesRef.current = wakePhrases;
  const stopPhrasesRegexRef = useRef(stopPhrasesRegex);
  stopPhrasesRegexRef.current = stopPhrasesRegex;
  const phrasesRef = useRef(phrases);
  phrasesRef.current = phrases;
  const languageRef = useRef(language);
  languageRef.current = language;
  const wakeTriggeredRef = useRef(false);
  const recordingHeardSpeechRef = useRef(false);
  const browserTranscriptRef = useRef('');
  const lastNonEmptyTranscriptRef = useRef('');
  // Track intentional stops to avoid restart loops
  const intentionalStopRef = useRef(false);
  // Mode: 'wake' = listening for wake word, 'stop' = listening for stop/cancel phrases
  const modeRef = useRef<'wake' | 'stop'>('wake');
  // Track pending timeouts for cleanup
  const pendingTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const silenceIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const transcriptPauseTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const silenceAudioContextRef = useRef<AudioContext | null>(null);
  const activeRecordingPauseMsRef = useRef<number | undefined>(undefined);
  const activeNoSpeechTimeoutMsRef = useRef<number>(SILENCE_NO_SPEECH_LIMIT_MS);
  const oneShotRecordingOptionsRef = useRef<StartRecordingOptions | undefined>(undefined);
  const startRef = useRef<(options?: StartRecordingOptions) => Promise<void> | void>(() => undefined);
  const discardRef = useRef<() => void>(() => undefined);
  const stopRef = useRef<() => void>(() => undefined);

  const setVoiceState = useCallback((s: VoiceState) => {
    stateRef.current = s;
    setState(s);
  }, []);

  const trackedTimeout = useCallback((fn: () => void, ms: number) => {
    const id = setTimeout(() => {
      pendingTimersRef.current.delete(id);
      fn();
    }, ms);
    pendingTimersRef.current.add(id);
    return id;
  }, []);

  const stopSilenceWatcher = useCallback(() => {
    if (silenceIntervalRef.current) {
      clearInterval(silenceIntervalRef.current);
      silenceIntervalRef.current = null;
    }
    if (silenceAudioContextRef.current) {
      void silenceAudioContextRef.current.close().catch(() => undefined);
      silenceAudioContextRef.current = null;
    }
  }, []);

  const startSilenceWatcher = useCallback((stream: MediaStream) => {
    stopSilenceWatcher();
    const pauseMs = activeRecordingPauseMsRef.current;
    if (!pauseMs || pauseMs <= 0) return;

    const AudioContextCtor = window.AudioContext || (window as Window & { webkitAudioContext?: BrowserAudioContext }).webkitAudioContext;
    if (!AudioContextCtor) return;

    try {
      const audioContext = new AudioContextCtor();
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      silenceAudioContextRef.current = audioContext;

      const samples = new Uint8Array(analyser.fftSize);
      const startedAt = Date.now();
      let heardSpeech = false;
      let quietSince: number | null = null;

      silenceIntervalRef.current = setInterval(() => {
        if (stateRef.current !== 'recording') return;
        analyser.getByteTimeDomainData(samples);
        let total = 0;
        for (let i = 0; i < samples.length; i += 1) {
          const centered = (samples[i] - 128) / 128;
          total += centered * centered;
        }
        const rms = Math.sqrt(total / samples.length);
        const now = Date.now();
        const isQuiet = rms < SILENCE_RMS_THRESHOLD;

        if (!isQuiet) {
          heardSpeech = true;
          recordingHeardSpeechRef.current = true;
          quietSince = null;
          return;
        }

        if (!quietSince) quietSince = now;
        const longEnough = now - startedAt >= SILENCE_MIN_RECORDING_MS;
        const pauseReached = heardSpeech && now - quietSince >= pauseMs;
        const noSpeechLimitMs = activeNoSpeechTimeoutMsRef.current || SILENCE_NO_SPEECH_LIMIT_MS;
        const noSpeechTimeout = !heardSpeech && now - startedAt >= noSpeechLimitMs;
        if (longEnough && (pauseReached || noSpeechTimeout)) {
          stopRef.current();
        }
      }, SILENCE_CHECK_MS);
    } catch (err) {
      console.warn('[VOICE] silence watcher unavailable:', err);
      stopSilenceWatcher();
    }
  }, [stopSilenceWatcher]);

  const clearTranscriptPauseTimer = useCallback(() => {
    if (transcriptPauseTimeoutRef.current) {
      clearTimeout(transcriptPauseTimeoutRef.current);
      transcriptPauseTimeoutRef.current = null;
    }
  }, []);

  const scheduleTranscriptPauseStop = useCallback(() => {
    clearTranscriptPauseTimer();
    const pauseMs = activeRecordingPauseMsRef.current;
    if (!pauseMs || pauseMs <= 0) return;
    transcriptPauseTimeoutRef.current = setTimeout(() => {
      transcriptPauseTimeoutRef.current = null;
      if (stateRef.current === 'recording') {
        stopRef.current();
      }
    }, pauseMs);
  }, [clearTranscriptPauseTimer]);

  const stopStream = useCallback(() => {
    clearTranscriptPauseTimer();
    stopSilenceWatcher();
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    mediaRecorderRef.current = null;
    chunksRef.current = [];
  }, [clearTranscriptPauseTimer, stopSilenceWatcher]);

  const resetBrowserTranscript = useCallback(() => {
    browserTranscriptRef.current = '';
    lastNonEmptyTranscriptRef.current = '';
  }, []);

  // Start or restart the single recognition instance
  const ensureRecognition = useCallback((mode: 'wake' | 'stop') => {
    modeRef.current = mode;

    // If we already have a running instance, abort it first
    if (recognitionRef.current) {
      intentionalStopRef.current = true;
      try { recognitionRef.current.abort(); } catch { /* already stopped */ }
      recognitionRef.current = null;
    }

    const SpeechRecognition = getSpeechRecognition();
    if (!SpeechRecognition) {
      console.warn('[VOICE] SpeechRecognition not available');
      if (mode === 'wake') {
        wakeWordEnabledRef.current = false;
        setStoredWakeWordEnabled(false);
        if (stateRef.current === 'listening') {
          setVoiceState('idle');
        }
      }
      return;
    }

    // Small delay to let the previous instance fully release
    trackedTimeout(() => {
      // Re-check state — might have changed during the delay
      if (mode === 'wake' && !wakeWordEnabledRef.current) return;
      if (mode === 'stop' && stateRef.current !== 'recording') return;

      const recognition = new SpeechRecognition();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = resolveRecognitionLang(languageRef.current);
      recognitionRef.current = recognition;
      intentionalStopRef.current = false;

      recognition.onresult = (event: SpeechRecognitionEvent) => {
        const currentMode = modeRef.current;
        if (currentMode === 'stop') {
          let full = '';
          for (let j = 0; j < event.results.length; j++) {
            full += event.results[j][0].transcript;
          }
          const cleaned = cleanTranscript(full, stopPhrasesRegexRef.current);
          if (cleaned) {
            recordingHeardSpeechRef.current = true;
            browserTranscriptRef.current = cleaned;
            lastNonEmptyTranscriptRef.current = cleaned;
            setInterimTranscript(cleaned);
            scheduleTranscriptPauseStop();
          }
        }

        for (let i = event.resultIndex; i < event.results.length; i++) {
          const transcript = event.results[i][0].transcript;
          if (currentMode === 'stop') {
            if (matchesPhrase(transcript, phrasesRef.current.cancelPhrases, languageRef.current)) {
              playCancelPing();
              doDiscard();
              return;
            }
            if (matchesPhrase(transcript, phrasesRef.current.stopPhrases, languageRef.current)) {
              doStopAndTranscribe();
              return;
            }
          } else if (currentMode === 'wake') {
            if (matchesPhrase(transcript, wakePhrasesRef.current, languageRef.current)) {
              // Guard against double-trigger from interim + final results
              if (wakeTriggeredRef.current) return;
              wakeTriggeredRef.current = true;
              // Stop recognition immediately — no longer needed and it uses the audio pipeline
              intentionalStopRef.current = true;
              try { recognitionRef.current?.abort(); } catch { /* already stopped */ }
              recognitionRef.current = null;
              const wakeFeedback = playWakePing();
              const wakeDelayMs = wakeFeedback.durationMs > 0
                ? wakeFeedback.durationMs + WAKE_CONFIRM_OUTRO_PAD_MS
                : WAKE_CONFIRM_FALLBACK_DELAY_MS;
              // Use the actual decoded confirmation length so the mic opens after Jane's acknowledgement, not during it.
              trackedTimeout(() => doStartRecording(), wakeDelayMs);
              return;
            }
          }
        }
      };

      recognition.onerror = (event: { error: string }) => {
        console.warn('[VOICE] error:', event.error, 'mode:', modeRef.current, 'intentional:', intentionalStopRef.current);
        if (intentionalStopRef.current) return;
        if (event.error === 'not-allowed' || event.error === 'service-not-allowed') return;
        if (event.error === 'aborted') return;
        // Transient error — restart
        scheduleRestart();
      };

      recognition.onend = () => {
        console.debug('[VOICE] onend, mode:', modeRef.current, 'intentional:', intentionalStopRef.current, 'state:', stateRef.current);
        if (intentionalStopRef.current) return;
        // Unexpected end — restart
        scheduleRestart();
      };

      try {
        recognition.start();
        console.debug('[VOICE] started in mode:', mode);
      } catch (e) {
        console.warn('[VOICE] failed to start:', e);
        // Try again after a delay
        trackedTimeout(() => {
          if (wakeWordEnabledRef.current || stateRef.current === 'recording') {
            ensureRecognitionRef.current(modeRef.current);
          }
        }, 2000);
      }
    }, 200);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- refs are stable, deps are intentionally minimal to avoid recreation
  }, [scheduleTranscriptPauseStop, trackedTimeout]);

  const ensureRecognitionRef = useRef(ensureRecognition);
  ensureRecognitionRef.current = ensureRecognition;

  const scheduleRestart = useCallback(() => {
    const mode = modeRef.current;
    const delay = 500;
    console.debug('[VOICE] scheduling restart in', delay, 'ms, mode:', mode, 'state:', stateRef.current);
    trackedTimeout(() => {
      if (mode === 'wake' && wakeWordEnabledRef.current && (stateRef.current === 'listening' || stateRef.current === 'idle')) {
        stateRef.current = 'listening';
        setState('listening');
        ensureRecognitionRef.current('wake');
      } else if (mode === 'stop' && stateRef.current === 'recording' && wakeTriggeredRef.current) {
        ensureRecognitionRef.current('stop');
      }
    }, delay);
  }, [trackedTimeout]);

  // Action functions that use refs to avoid stale closures
  const doStartRecording = useCallback(async (options?: StartRecordingOptions) => {
    // Initialize AudioContext on user interaction
    ensureAudioContext();
    // Stop recognition intentionally — we'll restart in stop mode after recording starts
    intentionalStopRef.current = true;
    try { recognitionRef.current?.abort(); } catch { /* already stopped */ }
    recognitionRef.current = null;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];
      recordingHeardSpeechRef.current = false;
      const recordingOptions = options || oneShotRecordingOptionsRef.current;
      oneShotRecordingOptionsRef.current = undefined;
      // Wake-triggered dictation must send after quiet speech even when the
      // separate Live Voice loop is off. Keep this per recording so manual mic,
      // Live Voice, and Wake can each use the right pause window.
      activeRecordingPauseMsRef.current = recordingOptions?.pauseMs
        ?? (wakeTriggeredRef.current
          ? wakeAutoStopAfterSilenceMsRef.current
          : autoStopAfterSilenceMsRef.current);
      // Post-TTS reply listening should close quickly if Alex says nothing.
      // Normal wake/manual paths keep the broader safety timeout.
      activeNoSpeechTimeoutMsRef.current = recordingOptions?.noSpeechTimeoutMs ?? SILENCE_NO_SPEECH_LIMIT_MS;
      resetBrowserTranscript();
      setInterimTranscript('');
      // Safari on iPhone often rejects WebM. Pick the first supported format so
      // tap-to-talk works through HTTPS tunnels and LAN HTTPS alike.
      const mimeType = getSupportedRecordingMimeType();
      const mr = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      mediaRecorderRef.current = mr;
      mr.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      // Ask the browser for periodic chunks. Safari/WebKit can lose the final
      // blob when recording is stopped while speech recognition is also ending;
      // timesliced chunks give us recoverable audio before the stop edge.
      mr.start(1000);
      startSilenceWatcher(stream);
      setError(null);
      setVoiceState('recording');
      // Now start listening for stop phrases
      ensureRecognitionRef.current('stop');
      } catch (err) {
        console.error('Mic access denied:', err);
      const msg = err instanceof DOMException && err.name === 'NotAllowedError'
          ? 'Microphone permission denied'
          : 'Failed to access microphone';
      activeRecordingPauseMsRef.current = undefined;
      activeNoSpeechTimeoutMsRef.current = SILENCE_NO_SPEECH_LIMIT_MS;
      setError(msg);
      if (wakeWordEnabledRef.current && !suppressWakeWordResumeRef.current) {
        setVoiceState('listening');
        ensureRecognitionRef.current('wake');
      }
    }
  }, [resetBrowserTranscript, setVoiceState, startSilenceWatcher]);

  const doDiscard = useCallback(() => {
    setInterimTranscript('');
    clearTranscriptPauseTimer();
    resetBrowserTranscript();
    recordingHeardSpeechRef.current = false;
    wakeTriggeredRef.current = false;
    intentionalStopRef.current = true;
    try { recognitionRef.current?.abort(); } catch { /* already stopped */ }
    recognitionRef.current = null;

    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.onstop = null;
      mediaRecorderRef.current.stop();
    }
    stopStream();
    activeRecordingPauseMsRef.current = undefined;
    activeNoSpeechTimeoutMsRef.current = SILENCE_NO_SPEECH_LIMIT_MS;
    if (wakeWordEnabledRef.current && !suppressWakeWordResumeRef.current) {
      setVoiceState('listening');
      ensureRecognitionRef.current('wake');
    } else {
      setVoiceState('idle');
    }
  }, [clearTranscriptPauseTimer, resetBrowserTranscript, stopStream, setVoiceState]);

  const transcribeWithBackend = useCallback(async (blob: Blob) => {
    const fd = new FormData();
    const ext = blob.type.includes('mp4') || blob.type.includes('m4a') || blob.type.includes('aac') ? 'm4a' : 'webm';
    fd.append('file', blob, `audio.${ext}`);
    const resp = await fetch('/api/transcribe', { method: 'POST', body: fd, credentials: 'include' });
    if (!resp.ok) throw new Error(await resp.text());
    const { text } = await resp.json();
    return cleanTranscript(text || '', stopPhrasesRegexRef.current);
  }, []);

  const waitForBrowserTranscript = useCallback(async (timeoutMs = 350, stepMs = 25) => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const current = cleanTranscript(browserTranscriptRef.current, stopPhrasesRegexRef.current);
      if (current) return current;
      await new Promise((resolve) => setTimeout(resolve, stepMs));
    }
    return cleanTranscript(browserTranscriptRef.current, stopPhrasesRegexRef.current);
  }, []);

  const doStopAndTranscribe = useCallback(() => {
    const mr = mediaRecorderRef.current;
    if (!mr || mr.state !== 'recording') return;
    setInterimTranscript('');
    clearTranscriptPauseTimer();
    wakeTriggeredRef.current = false;
    const shouldPlaySubmitFeedback = recordingHeardSpeechRef.current
      || Boolean(browserTranscriptRef.current.trim())
      || Boolean(lastNonEmptyTranscriptRef.current.trim());
    if (shouldPlaySubmitFeedback) playSubmitPing();
    intentionalStopRef.current = true;
    try {
      recognitionRef.current?.stop();
    } catch {
      try { recognitionRef.current?.abort(); } catch { /* already stopped */ }
    }
    recognitionRef.current = null;

    setVoiceState('transcribing');
    mr.onstop = async () => {
      const blob = new Blob(chunksRef.current, { type: mr.mimeType || chunksRef.current[0]?.type || 'audio/webm' });
      stopStream();
      try {
        const browserRecognitionSupported = Boolean(getSpeechRecognition());
        let browserTranscript = cleanTranscript(browserTranscriptRef.current, stopPhrasesRegexRef.current);
        let cleaned = '';

        if (sttInputModeRef.current === 'local') {
          cleaned = await transcribeWithBackend(blob);
        } else {
          if (!browserTranscript) {
            browserTranscript = await waitForBrowserTranscript();
          }

          if (browserTranscript) {
            cleaned = browserTranscript;
          } else if (sttInputModeRef.current === 'hybrid' || !browserRecognitionSupported) {
            cleaned = await transcribeWithBackend(blob);
          } else if (activeRecordingPauseMsRef.current) {
            cleaned = '';
          } else {
            throw new Error('Browser speech recognition did not produce a transcript');
          }
        }

        if (!cleaned && lastNonEmptyTranscriptRef.current) {
          cleaned = lastNonEmptyTranscriptRef.current;
        }

        if (cleaned) onTranscriptionRef.current(cleaned);
        setError(null);
      } catch (err) {
        console.error('Transcription failed:', err);
        setError(`Transcription failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        resetBrowserTranscript();
        recordingHeardSpeechRef.current = false;
        activeRecordingPauseMsRef.current = undefined;
        activeNoSpeechTimeoutMsRef.current = SILENCE_NO_SPEECH_LIMIT_MS;
      }
      // Resume wake word listener
      if (wakeWordEnabledRef.current && !suppressWakeWordResumeRef.current) {
        setVoiceState('listening');
        ensureRecognitionRef.current('wake');
      } else {
        setVoiceState('idle');
      }
    };
    try { mr.requestData?.(); } catch { /* Some browsers only emit on stop. */ }
    mr.stop();
  }, [clearTranscriptPauseTimer, resetBrowserTranscript, stopStream, setVoiceState, transcribeWithBackend, waitForBrowserTranscript]);

  const startWakeWordListener = useCallback(async () => {
    if (!wakeWordSupported) {
      wakeWordEnabledRef.current = false;
      if (stateRef.current === 'listening') {
        setVoiceState('idle');
      }
      return;
    }

    const SpeechRecognition = getSpeechRecognition();
    if (!SpeechRecognition) {
      console.warn('[VOICE] SpeechRecognition not available');
      wakeWordEnabledRef.current = false;
      setStoredWakeWordEnabled(false);
      setVoiceState('idle');
      setError('Speech recognition is not supported in this browser');
      return;
    }

    // Mark the listener as requested before we await permission so a later
    // stop call can cancel the startup cleanly without racing a stale enable.
    wakeWordEnabledRef.current = true;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
      if (!wakeWordEnabledRef.current) return;
    } catch (err) {
      console.warn('[VOICE] Failed to acquire microphone for wake word', err);
      wakeWordEnabledRef.current = false;
      setStoredWakeWordEnabled(false);
      setVoiceState('idle');
      setError(err instanceof Error && /denied|permission/i.test(err.message)
        ? 'Microphone permission denied'
        : 'Microphone access is required for wake word');
      return;
    }

    // Initialize AudioContext on user interaction
    ensureAudioContext();
    setStoredWakeWordEnabled(true);
    setError(null);
    setVoiceState('listening');
    ensureRecognitionRef.current('wake');
  }, [setVoiceState, wakeWordSupported]);

  const stopWakeWordListener = useCallback(() => {
    wakeWordEnabledRef.current = false;
    intentionalStopRef.current = true;
    try { recognitionRef.current?.abort(); } catch { /* already stopped */ }
    recognitionRef.current = null;
    if (stateRef.current === 'listening') {
      setVoiceState('idle');
    }
    if (wakeWordSupported) {
      setStoredWakeWordEnabled(false);
    }
  }, [setVoiceState, wakeWordSupported]);

  const toggleWakeWord = useCallback(() => {
    if (wakeWordEnabledRef.current) {
      stopWakeWordListener();
      return;
    }
    return startWakeWordListener();
  }, [startWakeWordListener, stopWakeWordListener]);

  // Restart recognition when language changes (so Web Speech API uses new locale)
  useEffect(() => {
    if (wakeWordEnabledRef.current && stateRef.current === 'listening') {
      ensureRecognitionRef.current('wake');
    }
  }, [language]);

  const startOneShotReplyRecording = useCallback((options: StartRecordingOptions) => {
    oneShotRecordingOptionsRef.current = options;
    return doStartRecording(options);
  }, [doStartRecording]);

  // Auto-start wake word listener if persisted as enabled (only if mic already granted)
  const startWakeWordRef = useRef(startWakeWordListener);
  startWakeWordRef.current = startWakeWordListener;
  useEffect(() => {
    if (!wakeWordSupported || !wakeWordEnabled || stateRef.current !== 'idle') return;
    // Only auto-start if mic permission was previously granted (avoid surprise prompts)
    navigator.permissions?.query({ name: 'microphone' as PermissionName }).then((result) => {
      if (!wakeWordEnabled || stateRef.current !== 'idle') return;
      if (result.state === 'granted') {
        startWakeWordRef.current();
      } else {
        // Keep the saved preference, but avoid surprise permission prompts on reload.
        wakeWordEnabledRef.current = false;
        setVoiceState('idle');
      }
    }).catch(() => {
      // Permissions API not available — try starting anyway (user interaction required)
      if (!wakeWordEnabled || stateRef.current !== 'idle') return;
      startWakeWordRef.current();
    });
  }, [setVoiceState, wakeWordEnabled, wakeWordSupported]);

  // Double-tap left Shift support
  startRef.current = doStartRecording;
  discardRef.current = doDiscard;
  stopRef.current = doStopAndTranscribe;

  useEffect(() => {
    let shiftDownAlone = false;
    const keydownHandler = (e: KeyboardEvent) => {
      if (e.key === 'Shift' && e.location === 1) {
        shiftDownAlone = true;
      } else {
        shiftDownAlone = false;
      }
    };
    const keyupHandler = (e: KeyboardEvent) => {
      if (e.key !== 'Shift' || e.location !== 1 || !shiftDownAlone) return;
      shiftDownAlone = false;
      const now = Date.now();
      const isDouble = (now - lastCapsTimeRef.current) < 300;
      lastCapsTimeRef.current = now;

      if (isDouble) {
        if (stateRef.current === 'recording') {
          discardRef.current();
        } else if (stateRef.current === 'idle' || stateRef.current === 'listening') {
          startRef.current();
        }
      } else {
        if (stateRef.current === 'recording') {
          trackedTimeout(() => {
            if (Date.now() - lastCapsTimeRef.current >= 290) {
              stopRef.current();
            }
          }, 300);
        }
      }
    };

    window.addEventListener('keydown', keydownHandler);
    window.addEventListener('keyup', keyupHandler);
    return () => {
      window.removeEventListener('keydown', keydownHandler);
      window.removeEventListener('keyup', keyupHandler);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only effect, trackedTimeout is stable ref-based
  }, []);

  useEffect(() => {
    const timers = pendingTimersRef.current;
    return () => {
      // Clear all pending timers
      for (const id of timers) clearTimeout(id);
      timers.clear();
      wakeWordEnabledRef.current = false;
      intentionalStopRef.current = true;
      clearTranscriptPauseTimer();
      try { recognitionRef.current?.abort(); } catch { /* already stopped */ }
      recognitionRef.current = null;
      if (mediaRecorderRef.current?.state === 'recording') {
        try { mediaRecorderRef.current.stop(); } catch { /* already stopped */ }
      }
      stopStream();
    };
  }, [clearTranscriptPauseTimer, stopStream]);

  return {
    voiceState: state,
    interimTranscript,
    startRecording: doStartRecording,
    startOneShotReplyRecording,
    stopAndTranscribe: doStopAndTranscribe,
    discardRecording: doDiscard,
    wakeWordEnabled,
    toggleWakeWord,
    startWakeWordListener,
    stopWakeWordListener,
    error,
    clearError,
  };
}
