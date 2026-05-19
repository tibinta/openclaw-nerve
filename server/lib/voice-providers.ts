/**
 * Voice provider registry used by Nerve server APIs.
 *
 * The dashboard and settings surfaces can read this registry instead of
 * guessing which voices the runtime supports. Keep defaults here linked to the
 * real provider adapters so updates do not drift from the voices that speak.
 */

export const DEFAULT_TTS_PROVIDER = 'holler';
export const DEFAULT_HOLLER_VOICE = 'nora';
export const DEFAULT_HOLLER_CODEBOOKS = '12';

export const HOLLER_VOICES = [
  { id: 'nora', label: 'Nora - warm woman', gender: 'woman', tone: 'warm', default: true },
  { id: 'tessa', label: 'Tessa - bright woman', gender: 'woman', tone: 'bright' },
  { id: 'kit', label: 'Kit - calm neutral', gender: 'neutral', tone: 'calm' },
  { id: 'dakota', label: 'Dakota - steady man', gender: 'man', tone: 'steady' },
  { id: 'joe', label: 'Joe - upbeat man', gender: 'man', tone: 'upbeat' },
  { id: 'oliver', label: 'Oliver - deep man', gender: 'man', tone: 'deep' },
] as const;

export const TTS_PROVIDERS = [
  {
    id: 'holler',
    label: 'Holler',
    default: true,
    local: true,
    realtime: true,
    streaming: true,
    defaultVoice: DEFAULT_HOLLER_VOICE,
    voices: HOLLER_VOICES,
    models: [
      { id: '12', label: 'Fast stream', default: true },
      { id: '16', label: 'Best quality' },
    ],
  },
  {
    id: 'openai',
    label: 'OpenAI',
    local: false,
    realtime: false,
    streaming: false,
    defaultVoice: 'nova',
  },
  {
    id: 'replicate',
    label: 'Replicate',
    local: false,
    realtime: false,
    streaming: false,
    defaultVoice: 'Serena',
  },
  {
    id: 'edge',
    label: 'Edge (Free)',
    local: false,
    realtime: false,
    streaming: false,
    defaultVoice: 'en-GB-SoniaNeural',
  },
  {
    id: 'xiaomi',
    label: 'Xiaomi Mimo',
    local: false,
    realtime: false,
    streaming: false,
    defaultVoice: 'mimo_default',
  },
] as const;

export const STT_PROVIDERS = [
  {
    id: 'browser',
    label: 'Browser English',
    language: 'en',
    local: true,
    realtime: true,
    default: true,
    backendProvider: 'local',
    inputMode: 'browser',
  },
  {
    id: 'local',
    label: 'Local Whisper',
    language: 'en',
    local: true,
    realtime: true,
    backendProvider: 'local',
    inputMode: 'hybrid',
  },
  {
    id: 'openai',
    label: 'OpenAI Whisper',
    language: 'auto',
    local: false,
    realtime: false,
    backendProvider: 'openai',
    inputMode: 'local',
  },
] as const;

export function getVoiceProviderRegistry() {
  return {
    defaults: {
      ttsProvider: DEFAULT_TTS_PROVIDER,
      ttsVoice: DEFAULT_HOLLER_VOICE,
      sttProvider: 'browser',
      sttLanguage: 'en',
      realtime: true,
    },
    tts: TTS_PROVIDERS,
    stt: STT_PROVIDERS,
  };
}
