/**
 * useChatTTS — TTS playback logic extracted from ChatContext
 *
 * Manages voice fallback text generation, TTS marker extraction,
 * auto-speak logic, and played-sound deduplication.
 */
import { useRef, useCallback, useEffect, useMemo } from 'react';
import { playPing } from '@/features/voice/audio-feedback';
import type { FinalMessageData } from '@/features/chat/operations';
import type { ChatMsg } from '@/features/chat/types';
import {
  getLatestVoiceControlSnapshot,
  VOICE_CONTROL_STATE_EVENT,
  type VoiceControlSnapshot,
} from '@/features/voice/voiceControlBridge';

// ─── Constants ──────────────────────────────────────────────────────────────────

export const FALLBACK_MAX_CHARS = 12000;
export const VOICE_REPLY_SPOKEN_EVENT = 'nerve:voice-reply-spoken';
const APPROVAL_NOTICE_SPEECH = 'Approval needed, Alex, can you approve this?';
const TTS_DEDUPE_WINDOW_MS = 60_000;
const COMPLETION_CUE_DEDUPE_WINDOW_MS = 2_000;
const VOICE_SUBMIT_CONFIRMATION_DELAY_MS = 1500;

// ─── Pure helpers ───────────────────────────────────────────────────────────────

/** Strip code blocks, markdown noise, and validate text is speakable for TTS fallback. */
export function buildVoiceFallbackText(raw: string): string | null {
  if (isApprovalNotice(raw)) return APPROVAL_NOTICE_SPEECH;

  // Active voice replies must speak the visible answer, not a model-authored
  // marker payload that can accidentally include older chat context.
  let text = stripTTSMarkers(raw);
  // Strip fenced code blocks
  text = text.replace(/```[\s\S]*?```/g, '');
  // Preserve short status labels styled as inline code, but avoid reading real code snippets.
  text = text.replace(/`([^`\n]+)`/g, (_match, value: string) => inlineCodeToSpeech(value));
  // Strip markdown images/links
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  // Strip markdown formatting (bold, italic, headers, hr)
  text = text.replace(/#{1,6}\s+/g, '');
  text = text.replace(/[*_~]{1,3}/g, '');
  text = text.replace(/^---+$/gm, '');
  // Drop obvious transcript/editor noise that should never be spoken.
  text = text.replace(/^\s*COPY\s*$/gmi, '');
  text = text.replace(/^\s*Tool(?:\s+text-to-speech.*)?$/gmi, '');
  text = text.replace(/^\s*text-to-speech.*$/gmi, '');
  // Collapse markdown layout into spoken pauses while keeping status/report lines.
  text = text
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/\n{2,}/g, '. ')
    .replace(/\n/g, '. ')
    .replace(/([\p{L}\p{N}])-([\p{L}\p{N}])/gu, '$1 $2')
    .replace(/\s{2,}/g, ' ')
    .replace(/\.\s*\./g, '.')
    .replace(/^[.\s]+/, '')
    .trim();
  // Must have at least 3 letter characters (unicode-aware for non-Latin scripts)
  if (!/\p{L}{3,}/u.test(text)) return null;
  // Keep cron readback whole for normal messages, but prevent accidental
  // huge logs/transcripts from monopolising the browser TTS queue.
  if (text.length > FALLBACK_MAX_CHARS) {
    text = text.slice(0, FALLBACK_MAX_CHARS).replace(/\s\S*$/, '') + '…';
  }
  return text;
}

function isApprovalNotice(raw: string): boolean {
  const text = stripTTSMarkers(raw).replace(/\s+/g, ' ').trim();
  if (!text) return false;

  const startsLikeApproval = /^\[Approval\](?:\s|$)/i.test(text) || /^Approval needed\b/i.test(text);
  if (!startsLikeApproval) return false;

  return /\brequestApproval\b/i.test(text)
    || /\bcodex_command_approval\b/i.test(text)
    || /\bReply:\s*\/approve\b/i.test(text)
    || /\bID:\s*(?:plugin|exec|approval):/i.test(text);
}

function inlineCodeToSpeech(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';

  const looksLikeCode = /[=;{}()[\]<>]|=>|\b(?:const|let|var|function|return|import|export)\b/.test(trimmed);
  const isShortLabel = trimmed.length <= 80 && /^[#@£$€\p{L}\p{N}][#@£$€%&×\p{L}\p{N}._:/+\-\s–—→]*\/?$/u.test(trimmed);
  if (looksLikeCode && !isShortLabel) return '';
  if (!isShortLabel) return '';

  return trimmed
    .replace(/\bp\s*\/\s*m\b/gi, 'per month')
    .replace(/\/mo\b/gi, ' per month')
    .replace(/\/month\b/gi, ' per month')
    .replace(/\/yr\b/gi, ' per year')
    .replace(/\/week\b/gi, ' per week')
    .replace(/\/year\b/gi, ' per year')
    .replace(/\/+$/g, '')
    .replace(/(?<=\d)[–—-](?=[£$€]?\d)/g, ' to ')
    .replace(/(?<=\d):(?=\d)/g, ' to ')
    .replace(/(?<=\d)\/(?=\d)/g, ' over ')
    .replace(/(?<=\d)\s*[×x](?=\s|$)/gi, ' times')
    .replace(/(?<=\d)%/g, ' percent')
    .replace(/\s*[→]\s*/g, ' to ')
    .replace(/\s*&\s*/g, ' and ')
    .replace(/[#@](?=[\p{L}\p{N}])/gu, '')
    .replace(/\+/g, ' plus ')
    .replace(/[._:/-]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function stripTTSMarkers(raw: string): string {
  let cursor = 0;
  let cleaned = '';

  while (cursor < raw.length) {
    const start = raw.indexOf('[tts: ', cursor);
    if (start === -1) {
      cleaned += raw.slice(cursor);
      break;
    }

    cleaned += raw.slice(cursor, start);
    const payloadStart = start + '[tts: '.length;
    let depth = 0;
    let end = -1;
    for (let i = payloadStart; i < raw.length; i++) {
      const ch = raw[i];
      if (ch === '[') {
        depth++;
      } else if (ch === ']') {
        if (depth === 0) {
          end = i;
          break;
        }
        depth--;
      }
    }

    if (end === -1) {
      cleaned += raw.slice(start);
      break;
    }
    cursor = end + 1;
  }

  return cleaned.trim();
}

/** Reduce a reply to a short spoken summary for ADHD/dyslexia-friendly playback. */
export function buildConciseSpeechText(raw: string): string | null {
  const cleaned = buildVoiceFallbackText(raw);
  if (!cleaned) return null;

  if (shouldSpeakFullStatusUpdate(raw, cleaned)) return cleaned;

  const sentenceMatch = cleaned.match(/^(.{1,180}?[.!?])(?:\s|$)/);
  if (sentenceMatch?.[1]) return sentenceMatch[1].trim();

  if (cleaned.length <= 140) return cleaned;

  const clipped = cleaned.slice(0, 180).replace(/\s+\S*$/, '').trim();
  return clipped ? `${clipped}…` : cleaned;
}

function shouldSpeakFullStatusUpdate(raw: string, cleaned: string): boolean {
  const nonEmptyLines = raw.split('\n').filter((line) => line.trim()).length;
  if (nonEmptyLines >= 3) return true;
  return /\b(heartbeat|active task|blocked|blocker|agent action|accountability update|next clean step|next in line|task protocol|live lanes)\b/i.test(cleaned);
}

function speechKey(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

function prunePlayedSpeech(played: Map<string, number>, now: number) {
  for (const [key, lastPlayedAt] of played) {
    if (now - lastPlayedAt > TTS_DEDUPE_WINDOW_MS) {
      played.delete(key);
    }
  }
}

function isVoiceInputBusy(snapshot: VoiceControlSnapshot): boolean {
  return snapshot.voiceState === 'recording' || snapshot.voiceState === 'transcribing';
}

// ─── Hook ───────────────────────────────────────────────────────────────────────

interface UseChatTTSDeps {
  soundEnabled: React.RefObject<boolean>;
  voiceReadbackEnabled?: React.RefObject<boolean>;
  speak: React.RefObject<(text: string) => void | Promise<void>>;
  stopSpeaking?: React.RefObject<() => void>;
}

interface DeferredSpeech {
  text: string;
  voiceReply: boolean;
}

export function useChatTTS({ soundEnabled, voiceReadbackEnabled, speak, stopSpeaking }: UseChatTTSDeps) {
  const readbackEnabled = voiceReadbackEnabled ?? { current: true };
  const voiceReplyPendingRef = useRef(false);
  const playedSoundsRef = useRef<Map<string, number>>(new Map());
  const deferredSpeechRef = useRef<DeferredSpeech[]>([]);
  const voiceInputBusyRef = useRef(isVoiceInputBusy(getLatestVoiceControlSnapshot()));
  const deferredSpeechTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastCompletionCueAtRef = useRef(0);

  const speakText = useCallback((text: string, voiceReply = false) => {
    lastCompletionCueAtRef.current = Date.now();
    const done = Promise.resolve(speak.current(text));
    if (voiceReply) {
      void done.finally(() => {
        window.dispatchEvent(new CustomEvent(VOICE_REPLY_SPOKEN_EVENT));
      });
    }
    return done;
  }, [speak]);

  const clearDeferredSpeechTimer = useCallback(() => {
    if (!deferredSpeechTimerRef.current) return;
    clearTimeout(deferredSpeechTimerRef.current);
    deferredSpeechTimerRef.current = null;
  }, []);

  const flushDeferredSpeech = useCallback(() => {
    clearDeferredSpeechTimer();
    if (voiceInputBusyRef.current) return;

    const queued = deferredSpeechRef.current.splice(0);
    for (const item of queued) {
      speakText(item.text, item.voiceReply);
    }
  }, [clearDeferredSpeechTimer, speakText]);

  const isVoiceInputCurrentlyBusy = useCallback(() => {
    const latestBusy = isVoiceInputBusy(getLatestVoiceControlSnapshot());
    if (latestBusy) voiceInputBusyRef.current = true;
    return latestBusy || voiceInputBusyRef.current;
  }, []);

  const scheduleDeferredSpeechFlush = useCallback((delayMs = VOICE_SUBMIT_CONFIRMATION_DELAY_MS) => {
    clearDeferredSpeechTimer();
    deferredSpeechTimerRef.current = setTimeout(() => {
      deferredSpeechTimerRef.current = null;
      flushDeferredSpeech();
    }, delayMs);
  }, [clearDeferredSpeechTimer, flushDeferredSpeech]);

  const speakOrDeferText = useCallback((text: string, voiceReply = false) => {
    const voiceControl = getLatestVoiceControlSnapshot();
    // GPT-Live owns its audio. Gateway finals are display/history only while Live is active.
    if (voiceControl.continuousVoiceEnabled) return;
    if (isVoiceInputCurrentlyBusy()) {
      deferredSpeechRef.current.push({ text, voiceReply });
      return;
    }
    speakText(text, voiceReply);
  }, [isVoiceInputCurrentlyBusy, speakText]);

  const playCompletionCue = useCallback((dedupeRecentCue = false) => {
    if (!soundEnabled.current) return;
    const now = Date.now();
    if (dedupeRecentCue && now - lastCompletionCueAtRef.current <= COMPLETION_CUE_DEDUPE_WINDOW_MS) return;
    lastCompletionCueAtRef.current = now;
    playPing();
  }, [soundEnabled]);

  const handleVoiceControlState = useCallback((snapshot: VoiceControlSnapshot) => {
    const wasBusy = voiceInputBusyRef.current;
    const isBusy = isVoiceInputBusy(snapshot);
    voiceInputBusyRef.current = isBusy;

    if (isBusy) {
      clearDeferredSpeechTimer();
      stopSpeaking?.current?.();
      return;
    }
    if (wasBusy && deferredSpeechRef.current.length > 0) {
      scheduleDeferredSpeechFlush();
    }
  }, [clearDeferredSpeechTimer, scheduleDeferredSpeechFlush, stopSpeaking]);

  useEffect(() => {
    handleVoiceControlState(getLatestVoiceControlSnapshot());
    const handleStateEvent = (event: Event) => {
      handleVoiceControlState((event as CustomEvent<VoiceControlSnapshot>).detail);
    };

    window.addEventListener(VOICE_CONTROL_STATE_EVENT, handleStateEvent);
    return () => {
      window.removeEventListener(VOICE_CONTROL_STATE_EVENT, handleStateEvent);
      clearDeferredSpeechTimer();
    };
  }, [clearDeferredSpeechTimer, handleVoiceControlState]);

  const markSpeechIfNew = useCallback((text: string) => {
    const speechText = text.trim();
    if (!speechText) return null;

    const now = Date.now();
    prunePlayedSpeech(playedSoundsRef.current, now);
    const key = speechKey(speechText);
    const lastPlayedAt = playedSoundsRef.current.get(key);
    // Cron TTS can arrive through both websocket finals and history recovery; dedupe by spoken text.
    if (lastPlayedAt !== undefined && now - lastPlayedAt <= TTS_DEDUPE_WINDOW_MS) return null;

    playedSoundsRef.current.set(key, now);
    return speechText;
  }, []);

  /** Track whether the user sent a voice message (for TTS fallback). */
  const trackVoiceMessage = useCallback((text: string) => {
    voiceReplyPendingRef.current = text.startsWith('[voice] ');
  }, []);

  /** Clear the played-sounds dedup set (called on chat_started). */
  const resetPlayedSounds = useCallback(() => {
    playedSoundsRef.current.clear();
  }, []);

  /**
   * Handle TTS for a completed assistant turn.
   * Called from chat_final processing when the run is the active run.
   */
  const handleFinalTTS = useCallback((finalData: FinalMessageData | null, isActiveRun: boolean) => {
    if (!isActiveRun && !voiceReplyPendingRef.current) return;

    if (voiceReplyPendingRef.current) {
      // For live voice chats, Nerve owns the speech source. The model may still
      // emit hidden markers for cron paths, but voice replies read the visible
      // final answer so they cannot pull in previous bubbles or instructions.
      const fallback = finalData?.text
        ? buildVoiceFallbackText(finalData.text) ?? stripTTSMarkers(finalData.text).trim()
        : '';
      voiceReplyPendingRef.current = false;
      if (!readbackEnabled.current) return;
      if (fallback) speakOrDeferText(fallback, true);
      return;
    }

    if (!readbackEnabled.current) {
      voiceReplyPendingRef.current = false;
      playCompletionCue();
      return;
    }

    if (finalData?.ttsText) {
      const speechText = markSpeechIfNew(finalData.ttsText);
      if (speechText) {
        speakOrDeferText(speechText);
      }
      voiceReplyPendingRef.current = false;
    } else if (isActiveRun && finalData?.text) {
      // Spoken assistant output should match the visible bubble; the fallback
      // cleaner removes UI noise and caps extreme transcripts.
      const fallback = buildVoiceFallbackText(finalData.text) ?? stripTTSMarkers(finalData.text).trim();
      const speechText = fallback ? markSpeechIfNew(fallback) : null;
      if (speechText) {
        speakOrDeferText(speechText);
      } else {
        playCompletionCue();
      }
    } else {
      playCompletionCue();
    }
  }, [markSpeechIfNew, playCompletionCue, readbackEnabled, speakOrDeferText]);

  /** Speak cron/background runs that are not the active chat. */
  const handleBackgroundTTS = useCallback((finalData: FinalMessageData | null) => {
    if (!readbackEnabled.current) return;
    const fallback = finalData?.text
      ? buildVoiceFallbackText(finalData.text)
      : null;
    const speechText = finalData?.ttsText?.trim() || fallback;
    if (!speechText) return;

    const freshSpeechText = markSpeechIfNew(speechText);
    if (!freshSpeechText) return;
    speakOrDeferText(freshSpeechText);
  }, [markSpeechIfNew, readbackEnabled, speakOrDeferText]);

  /** Recovery path: if a cron/background message arrives through history polling, speak only the newest new assistant bubble. */
  const handleHistoryTTS = useCallback((previous: ChatMsg[], next: ChatMsg[]) => {
    if (!readbackEnabled.current) return;
    // While a voice answer is in flight, websocket final owns what gets spoken.
    // History polling can include old assistant bubbles and must not steal TTS.
    if (voiceReplyPendingRef.current) return;

    const previousKeys = new Set(previous.map((msg) => makeHistoryMessageKey(msg)));
    const latestPreviousTs = previous.reduce((latest, msg) => Math.max(latest, msg.timestamp.getTime()), 0);

    const newest = next
      .filter((msg) => msg.role === 'assistant')
      .filter((msg) => !previousKeys.has(makeHistoryMessageKey(msg)))
      .filter((msg) => latestPreviousTs === 0 || msg.timestamp.getTime() >= latestPreviousTs)
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())[0];
    if (!newest) return;

    // History recovery can rehydrate older marker payloads while a new cron
    // bubble arrives. Bind speech to the newest bubble so Safari never reads a
    // previous "can hear you" reply for a later cron update.
    // Cron/history recovery should read the whole visible message. The concise
    // helper is only for active voice replies where a short answer is calmer.
    const fallback = buildVoiceFallbackText(newest.rawText);
    const speechText = newest.ttsText?.trim() || fallback;
    if (!speechText) return;

    const freshSpeechText = markSpeechIfNew(speechText);
    if (!freshSpeechText) return;
    speakOrDeferText(freshSpeechText);
  }, [markSpeechIfNew, readbackEnabled, speakOrDeferText]);

  /** Play the completion ping sound if sound is enabled. */
  const playCompletionPing = useCallback(() => {
    playCompletionCue(true);
  }, [playCompletionCue]);

  return useMemo(() => ({
    trackVoiceMessage,
    resetPlayedSounds,
    handleFinalTTS,
    handleBackgroundTTS,
    handleHistoryTTS,
    playCompletionPing,
  }), [
    trackVoiceMessage,
    resetPlayedSounds,
    handleFinalTTS,
    handleBackgroundTTS,
    handleHistoryTTS,
    playCompletionPing,
  ]);
}

function makeHistoryMessageKey(msg: ChatMsg): string {
  return [
    msg.role,
    msg.rawText.trim().replace(/\s+/g, ' '),
    msg.html.trim().replace(/\s+/g, ' '),
    msg.ttsText ?? '',
  ].join('::');
}
