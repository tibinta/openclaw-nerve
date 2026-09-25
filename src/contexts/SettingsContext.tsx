/* eslint-disable react-refresh/only-export-components -- hook intentionally co-located with provider */
import { createContext, useContext, useCallback, useRef, useState, useEffect, useMemo, type ReactNode } from 'react';
import { useTTS, migrateTTSProvider, type TTSProvider } from '@/features/tts/useTTS';
import { unlockBrowserAudio } from '@/features/voice/audio-feedback';
import { type ThemeName, applyTheme, themeNames } from '@/lib/themes';
import { type FontName, applyFont, fontNames } from '@/lib/fonts';

export type STTProvider = 'local' | 'openai';
export type STTInputMode = 'browser' | 'local' | 'hybrid';
export const DEFAULT_LIVE_VOICE_PAUSE_MS = 1800;
export const DEFAULT_WAKE_VOICE_PAUSE_MS = DEFAULT_LIVE_VOICE_PAUSE_MS;
const MIN_LIVE_VOICE_PAUSE_MS = 700;
const MAX_LIVE_VOICE_PAUSE_MS = 5000;

interface TTSVoiceConfigSnapshot {
  openai?: { voice?: string; model?: string };
  edge?: { voice?: string };
  holler?: { voice?: string; nCodebooks?: string };
  qwen?: { speaker?: string };
  xiaomi?: { voice?: string; model?: string };
}

interface SettingsContextValue {
  soundEnabled: boolean;
  toggleSound: () => void;
  voiceReadbackEnabled: boolean;
  toggleVoiceReadback: () => void;
  disableVoiceReadback: () => void;
  voicePlaybackUnlocked: boolean;
  unlockVoicePlayback: () => Promise<boolean>;
  ttsProvider: TTSProvider;
  ttsModel: string;
  setTtsProvider: (provider: TTSProvider) => void;
  setTtsModel: (model: string) => void;
  toggleTtsProvider: () => void;
  sttProvider: STTProvider;
  setSttProvider: (provider: STTProvider) => void;
  sttInputMode: STTInputMode;
  setSttInputMode: (mode: STTInputMode) => void;
  sttModel: string;
  setSttModel: (model: string) => void;
  wakeWordEnabled: boolean;
  setWakeWordEnabled: (enabled: boolean) => void;
  handleToggleWakeWord: () => void;
  handleWakeWordState: (enabled: boolean, toggle: () => void) => void;
  liveTranscriptionPreview: boolean;
  toggleLiveTranscriptionPreview: () => void;
  continuousVoiceEnabled: boolean;
  toggleContinuousVoice: () => void;
  liveVoicePauseMs: number;
  setLiveVoicePauseMs: (ms: number) => void;
  wakeVoicePauseMs: number;
  setWakeVoicePauseMs: (ms: number) => void;
  speak: (text: string) => Promise<void>;
  stopSpeaking: () => void;
  isTtsSpeaking: boolean;
  panelRatio: number;
  setPanelRatio: (ratio: number) => void;
  telemetryVisible: boolean;
  toggleTelemetry: () => void;
  eventsVisible: boolean;
  toggleEvents: () => void;
  logVisible: boolean;
  toggleLog: () => void;
  theme: ThemeName;
  setTheme: (theme: ThemeName) => void;
  font: FontName;
  setFont: (font: FontName) => void;
  fontSize: number;
  setFontSize: (size: number) => void;
  editorFontSize: number;
  setEditorFontSize: (size: number) => void;
  kanbanVisible: boolean;
  toggleKanbanVisible: () => void;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);
const FONT_REFRESH_STORAGE_KEY = 'nerve:font-refresh-20260312';
const KANBAN_VISIBILITY_STORAGE_KEY = 'nerve:workspace:kanban-visible';
const HOLLER_DEFAULT_MIGRATION_KEY = 'nerve:holler-default-tts-20260518';
const VOICE_UNLOCK_STORAGE_KEY = 'nerve:voice-playback-unlocked';
const VOICE_READBACK_STORAGE_KEY = 'nerve:voice-readback-enabled';

const ALLOWED_FONT_SIZES = new Set([10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 22, 24]);
const ALLOWED_EDITOR_FONT_SIZES = new Set([10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 22, 24]);

function normalizeFontSize(size: number): number {
  return Number.isFinite(size) && ALLOWED_FONT_SIZES.has(size) ? size : 15;
}

function normalizeEditorFontSize(size: number): number {
  return Number.isFinite(size) && ALLOWED_EDITOR_FONT_SIZES.has(size) ? size : 13;
}

function resolveInitialFont(): FontName {
  const saved = localStorage.getItem('oc-font');
  const hasRefreshedFont = localStorage.getItem(FONT_REFRESH_STORAGE_KEY) === 'true';

  if (!hasRefreshedFont) {
    const shouldAdoptInstrumentSans =
      saved === null ||
      saved === 'inter' ||
      saved === 'system' ||
      saved === 'jetbrains-mono';

    localStorage.setItem(FONT_REFRESH_STORAGE_KEY, 'true');

    if (shouldAdoptInstrumentSans) {
      localStorage.setItem('oc-font', 'instrument-sans');
      return 'instrument-sans';
    }

    if (saved && fontNames.includes(saved as FontName)) {
      return saved as FontName;
    }
  }

  return saved && fontNames.includes(saved as FontName) ? saved as FontName : 'instrument-sans';
}

function resolveInitialTtsProvider(): TTSProvider {
  const hasMigrated = localStorage.getItem(HOLLER_DEFAULT_MIGRATION_KEY) === 'true';
  if (!hasMigrated) {
    // Holler is now the preferred local voice path. We switch existing browsers
    // once, then future user provider changes are respected by the migration key.
    localStorage.setItem(HOLLER_DEFAULT_MIGRATION_KEY, 'true');
    localStorage.setItem('oc-tts-provider', 'holler');
    return 'holler';
  }

  return migrateTTSProvider(localStorage.getItem('oc-tts-provider') || 'holler');
}

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [soundEnabled, setSoundEnabled] = useState(localStorage.getItem('oc-sound') === 'true');
  const [voiceReadbackEnabled, setVoiceReadbackEnabled] = useState(() => {
    const saved = localStorage.getItem(VOICE_READBACK_STORAGE_KEY);
    return saved === 'true';
  });
  const [voicePlaybackUnlocked, setVoicePlaybackUnlocked] = useState(false);
  const [ttsProvider, setTtsProvider] = useState<TTSProvider>(resolveInitialTtsProvider);
  const [ttsModel, setTtsModelState] = useState(() => localStorage.getItem('oc-tts-model') || '');
  const [ttsVoiceConfig, setTtsVoiceConfig] = useState<TTSVoiceConfigSnapshot | null>(null);
  const [sttProvider, setSttProviderState] = useState<STTProvider>(() => {
    const saved = localStorage.getItem('oc-stt-provider') as STTProvider | null;
    return saved === 'openai' ? 'openai' : 'local';
  });
  const [sttInputMode, setSttInputModeState] = useState<STTInputMode>(() => {
    const saved = localStorage.getItem('nerve:sttInputMode') as STTInputMode | null;
    return saved === 'browser' || saved === 'local' || saved === 'hybrid' ? saved : 'hybrid';
  });
  const [sttModel, setSttModelState] = useState(() => localStorage.getItem('oc-stt-model') || 'small.en');
  const [wakeWordEnabled, setWakeWordEnabled] = useState(false);
  const [liveTranscriptionPreview, setLiveTranscriptionPreview] = useState(() => {
    const saved = localStorage.getItem('nerve:liveTranscriptionPreview');
    return saved === 'true'; // Default to disabled (fresh installs)
  });
  const [continuousVoiceEnabled, setContinuousVoiceEnabled] = useState(() => localStorage.getItem('nerve:continuousVoiceEnabled') === 'true');
  const [liveVoicePauseMs, setLiveVoicePauseMsState] = useState(() => {
    const saved = Number(localStorage.getItem('nerve:liveVoicePauseMs'));
    return Number.isFinite(saved) && saved >= MIN_LIVE_VOICE_PAUSE_MS && saved <= MAX_LIVE_VOICE_PAUSE_MS
      ? Math.round(saved)
      : DEFAULT_LIVE_VOICE_PAUSE_MS;
  });
  const [wakeVoicePauseMs, setWakeVoicePauseMsState] = useState(() => {
    const saved = Number(localStorage.getItem('nerve:wakeVoicePauseMs'));
    return Number.isFinite(saved) && saved >= MIN_LIVE_VOICE_PAUSE_MS && saved <= MAX_LIVE_VOICE_PAUSE_MS
      ? Math.round(saved)
      : DEFAULT_WAKE_VOICE_PAUSE_MS;
  });
  const [panelRatio, setPanelRatioState] = useState(() => {
    const saved = localStorage.getItem('oc-panel-ratio');
    return saved ? Number(saved) : 75;
  });
  const [telemetryVisible, setTelemetryVisible] = useState(() => {
    const saved = localStorage.getItem('oc-telemetry-visible');
    return saved !== 'false'; // Default to true (visible)
  });
  const [eventsVisible, setEventsVisible] = useState(() => {
    return localStorage.getItem('nerve:showEvents') === 'true'; // Default to false (hidden)
  });
  const [logVisible, setLogVisible] = useState(() => {
    return localStorage.getItem('nerve:showLog') === 'true'; // Default to false (hidden)
  });
  const [theme, setThemeState] = useState<ThemeName>(() => {
    const saved = localStorage.getItem('oc-theme') as ThemeName | null;
    return saved && themeNames.includes(saved) ? saved : 'ayu-dark';
  });
  const [font, setFontState] = useState<FontName>(resolveInitialFont);
  const [fontSize, setFontSizeState] = useState<number>(() => {
    const saved = localStorage.getItem('nerve:font-size');
    const parsed = saved ? parseInt(saved, 10) : NaN;
    return normalizeFontSize(parsed);
  });
  const [editorFontSize, setEditorFontSizeState] = useState<number>(() => {
    const saved = localStorage.getItem('nerve:editor-font-size');
    const parsed = saved ? parseInt(saved, 10) : NaN;
    return normalizeEditorFontSize(parsed);
  });
  const [kanbanVisible, setKanbanVisible] = useState(() => {
    const saved = localStorage.getItem(KANBAN_VISIBILITY_STORAGE_KEY);
    return saved !== 'false';
  });
  // TTS is separate from small UI pings: voice replies with [tts: ...]
  // should still speak when "Sound effects" is off.
  const selectedTtsVoice =
    ttsProvider === 'openai' ? ttsVoiceConfig?.openai?.voice :
      ttsProvider === 'edge' ? ttsVoiceConfig?.edge?.voice :
        ttsProvider === 'holler' ? ttsVoiceConfig?.holler?.voice :
          ttsProvider === 'xiaomi' ? ttsVoiceConfig?.xiaomi?.voice :
            ttsVoiceConfig?.qwen?.speaker;
  const selectedTtsModel = ttsProvider === 'holler'
    ? (ttsModel || ttsVoiceConfig?.holler?.nCodebooks)
    : ttsProvider === 'xiaomi'
    ? (ttsModel || ttsVoiceConfig?.xiaomi?.model)
    : (ttsModel || ttsVoiceConfig?.openai?.model);
  const { speak, stopSpeaking, isSpeaking: isTtsSpeaking } = useTTS(true, ttsProvider, { model: selectedTtsModel || undefined, voice: selectedTtsVoice || undefined });
  const wakeWordToggleRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/tts/config')
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (!cancelled && data) setTtsVoiceConfig(data);
      })
      .catch(() => undefined);

    const handleConfigChanged = (event: Event) => {
      setTtsVoiceConfig((event as CustomEvent<TTSVoiceConfigSnapshot>).detail);
    };
    window.addEventListener('nerve:tts-config-changed', handleConfigChanged);
    return () => {
      cancelled = true;
      window.removeEventListener('nerve:tts-config-changed', handleConfigChanged);
    };
  }, []);

  // Apply theme on mount and when it changes
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // Apply font on mount and when it changes
  useEffect(() => {
    applyFont(font);
  }, [font]);

  // Apply font size on mount and when it changes
  useEffect(() => {
    document.documentElement.style.setProperty('--font-size-base', `${fontSize}px`);
  }, [fontSize]);

  // Apply editor font size on mount and when it changes
  useEffect(() => {
    document.documentElement.style.setProperty('--editor-font-size', `${editorFontSize}px`);
  }, [editorFontSize]);

  const toggleSound = useCallback(() => {
    setSoundEnabled(prev => {
      const next = !prev;
      localStorage.setItem('oc-sound', String(next));
      return next;
    });
  }, []);

  const toggleVoiceReadback = useCallback(() => {
    setVoiceReadbackEnabled(prev => {
      const next = !prev;
      localStorage.setItem(VOICE_READBACK_STORAGE_KEY, String(next));
      if (!next) {
        stopSpeaking();
      }
      return next;
    });
  }, [stopSpeaking]);
  const disableVoiceReadback = useCallback(() => {
    setVoiceReadbackEnabled(false);
    localStorage.setItem(VOICE_READBACK_STORAGE_KEY, 'false');
    stopSpeaking();
  }, [stopSpeaking]);

  const unlockVoicePlayback = useCallback(async () => {
    // Safari needs a real user gesture before later async TTS audio can play.
    // Keep this explicit so sales users can enable voice once after loading Nerve.
    const ok = await unlockBrowserAudio();
    setVoicePlaybackUnlocked(true);
    localStorage.setItem(VOICE_UNLOCK_STORAGE_KEY, 'true');
    setSoundEnabled(true);
    localStorage.setItem('oc-sound', 'true');
    return ok;
  }, []);

  useEffect(() => {
    if (voicePlaybackUnlocked) return;
    if (localStorage.getItem(VOICE_UNLOCK_STORAGE_KEY) !== 'true') return;

    const handleGesture = () => {
      void unlockVoicePlayback();
    };
    const events = ['click', 'touchstart', 'keydown'] as const;
    events.forEach((event) => window.addEventListener(event, handleGesture, { capture: true, once: true }));
    return () => {
      events.forEach((event) => window.removeEventListener(event, handleGesture, { capture: true }));
    };
  }, [unlockVoicePlayback, voicePlaybackUnlocked]);

  const toggleLiveTranscriptionPreview = useCallback(() => {
    setLiveTranscriptionPreview(prev => {
      const next = !prev;
      localStorage.setItem('nerve:liveTranscriptionPreview', String(next));
      return next;
    });
  }, []);

  const toggleContinuousVoice = useCallback(() => {
    setContinuousVoiceEnabled(prev => {
      const next = !prev;
      localStorage.setItem('nerve:continuousVoiceEnabled', String(next));
      return next;
    });
  }, []);

  const setLiveVoicePauseMs = useCallback((ms: number) => {
    const next = Math.min(MAX_LIVE_VOICE_PAUSE_MS, Math.max(MIN_LIVE_VOICE_PAUSE_MS, Math.round(ms)));
    setLiveVoicePauseMsState(next);
    localStorage.setItem('nerve:liveVoicePauseMs', String(next));
  }, []);

  const setWakeVoicePauseMs = useCallback((ms: number) => {
    const next = Math.min(MAX_LIVE_VOICE_PAUSE_MS, Math.max(MIN_LIVE_VOICE_PAUSE_MS, Math.round(ms)));
    setWakeVoicePauseMsState(next);
    localStorage.setItem('nerve:wakeVoicePauseMs', String(next));
  }, []);

  const changeTtsProvider = useCallback((provider: TTSProvider) => {
    setTtsProvider(provider);
    localStorage.setItem('oc-tts-provider', provider);
    // Reset model when switching providers — models are provider-specific
    setTtsModelState('');
    localStorage.setItem('oc-tts-model', '');
  }, []);

  const changeTtsModel = useCallback((model: string) => {
    setTtsModelState(model);
    localStorage.setItem('oc-tts-model', model);
  }, []);

  // Sync STT settings to server on mount (in case server restarted).
  // GET first to avoid overwriting server state with stale local values.
  useEffect(() => {
    if (!sttProvider) return;
    fetch('/api/transcribe/config')
      .then(resp => resp.ok ? resp.json() : null)
      .then(data => {
        const serverProvider = data?.provider as STTProvider | undefined;
        const serverModel = typeof data?.model === 'string' ? data.model : '';

        // Model: trust server on startup to avoid stale localStorage mismatches
        // (e.g. UI says tiny.en while server is actually tiny).
        if (serverModel && serverModel !== sttModel) {
          setSttModelState(serverModel);
          localStorage.setItem('oc-stt-model', serverModel);
        }

        // Provider: preserve prior behavior (push local preference to server).
        if (serverProvider !== sttProvider) {
          return fetch('/api/transcribe/config', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ provider: sttProvider }),
          });
        }
      })
      .catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const changeSttProvider = useCallback((provider: STTProvider) => {
    setSttProviderState(provider);
    localStorage.setItem('oc-stt-provider', provider);
    // Notify server to switch provider
    fetch('/api/transcribe/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider }),
    }).catch(() => {});
  }, []);

  const changeSttInputMode = useCallback((mode: STTInputMode) => {
    setSttInputModeState(mode);
    localStorage.setItem('nerve:sttInputMode', mode);
  }, []);

  const changeSttModel = useCallback((model: string) => {
    setSttModelState(model);
    localStorage.setItem('oc-stt-model', model);
    // Notify server to switch model
    fetch('/api/transcribe/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
    }).catch(() => {}); // Best-effort — server will use new model on next request
  }, []);

  const toggleTtsProvider = useCallback(() => {
    setTtsProvider(prev => {
      const order: TTSProvider[] = ['holler', 'edge', 'openai', 'replicate', 'xiaomi'];
      const next = order[(order.indexOf(prev) + 1) % order.length]!;
      localStorage.setItem('oc-tts-provider', next);
      return next;
    });
  }, []);

  const handleWakeWordState = useCallback((enabled: boolean, toggle: () => void) => {
    setWakeWordEnabled(enabled);
    wakeWordToggleRef.current = toggle;
  }, []);

  const handleToggleWakeWord = useCallback(() => {
    wakeWordToggleRef.current?.();
  }, []);

  const setPanelRatio = useCallback((ratio: number) => {
    setPanelRatioState(ratio);
    localStorage.setItem('oc-panel-ratio', String(ratio));
  }, []);

  const toggleTelemetry = useCallback(() => {
    setTelemetryVisible(prev => {
      const next = !prev;
      localStorage.setItem('oc-telemetry-visible', String(next));
      return next;
    });
  }, []);

  const toggleEvents = useCallback(() => {
    setEventsVisible(prev => {
      const next = !prev;
      localStorage.setItem('nerve:showEvents', String(next));
      return next;
    });
  }, []);

  const toggleLog = useCallback(() => {
    setLogVisible(prev => {
      const next = !prev;
      localStorage.setItem('nerve:showLog', String(next));
      return next;
    });
  }, []);

  const setTheme = useCallback((newTheme: ThemeName) => {
    setThemeState(newTheme);
    localStorage.setItem('oc-theme', newTheme);
  }, []);

  const setFont = useCallback((newFont: FontName) => {
    setFontState(newFont);
    localStorage.setItem('oc-font', newFont);
  }, []);

  const setFontSize = useCallback((size: number) => {
    const normalized = normalizeFontSize(size);
    setFontSizeState(normalized);
    localStorage.setItem('nerve:font-size', String(normalized));
  }, []);

  const setEditorFontSize = useCallback((size: number) => {
    const normalized = normalizeEditorFontSize(size);
    setEditorFontSizeState(normalized);
    localStorage.setItem('nerve:editor-font-size', String(normalized));
  }, []);

  const toggleKanbanVisible = useCallback(() => {
    setKanbanVisible(prev => {
      const next = !prev;
      localStorage.setItem(KANBAN_VISIBILITY_STORAGE_KEY, String(next));
      return next;
    });
  }, []);

  const value = useMemo<SettingsContextValue>(() => ({
    soundEnabled,
    toggleSound,
    voiceReadbackEnabled,
    toggleVoiceReadback,
    disableVoiceReadback,
    voicePlaybackUnlocked,
    unlockVoicePlayback,
    ttsProvider,
    ttsModel,
    setTtsProvider: changeTtsProvider,
    setTtsModel: changeTtsModel,
    toggleTtsProvider,
    sttProvider,
    setSttProvider: changeSttProvider,
    sttInputMode,
    setSttInputMode: changeSttInputMode,
    sttModel,
    setSttModel: changeSttModel,
    wakeWordEnabled,
    setWakeWordEnabled,
    handleToggleWakeWord,
    handleWakeWordState,
    liveTranscriptionPreview,
    toggleLiveTranscriptionPreview,
    continuousVoiceEnabled,
    toggleContinuousVoice,
    liveVoicePauseMs,
    setLiveVoicePauseMs,
    wakeVoicePauseMs,
    setWakeVoicePauseMs,
    speak,
    stopSpeaking,
    isTtsSpeaking,
    panelRatio,
    setPanelRatio,
    telemetryVisible,
    toggleTelemetry,
    eventsVisible,
    toggleEvents,
    logVisible,
    toggleLog,
    theme,
    setTheme,
    font,
    setFont,
    fontSize,
    setFontSize,
    editorFontSize,
    setEditorFontSize,
    kanbanVisible,
    toggleKanbanVisible,
  }), [
    soundEnabled, toggleSound, voiceReadbackEnabled, toggleVoiceReadback, disableVoiceReadback, voicePlaybackUnlocked, unlockVoicePlayback, ttsProvider, ttsModel, changeTtsProvider, changeTtsModel, toggleTtsProvider,
    sttProvider, changeSttProvider, sttInputMode, changeSttInputMode, sttModel, changeSttModel,
    wakeWordEnabled, handleToggleWakeWord, handleWakeWordState,
    liveTranscriptionPreview, toggleLiveTranscriptionPreview, continuousVoiceEnabled, toggleContinuousVoice,
    liveVoicePauseMs, setLiveVoicePauseMs, wakeVoicePauseMs, setWakeVoicePauseMs, speak, stopSpeaking, isTtsSpeaking, panelRatio, setPanelRatio, telemetryVisible, toggleTelemetry,
    eventsVisible, toggleEvents, logVisible, toggleLog, theme, setTheme, font, setFont,
    fontSize, setFontSize, editorFontSize, setEditorFontSize, kanbanVisible, toggleKanbanVisible,
  ]);

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings() {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error('useSettings must be used within SettingsProvider');
  return ctx;
}
