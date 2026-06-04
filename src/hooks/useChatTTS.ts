/**
 * useChatTTS — TTS playback logic extracted from ChatContext
 *
 * Manages voice fallback text generation, TTS marker extraction,
 * auto-speak logic, and played-sound deduplication.
 */
import { useRef, useCallback, useMemo } from 'react';
import { playPing } from '@/features/voice/audio-feedback';
import type { FinalMessageData } from '@/features/chat/operations';
import type { ChatMsg } from '@/features/chat/types';

// ─── Constants ──────────────────────────────────────────────────────────────────

export const FALLBACK_MAX_CHARS = 300;
const TTS_DEDUPE_WINDOW_MS = 60_000;

// ─── Pure helpers ───────────────────────────────────────────────────────────────

/** Strip code blocks, markdown noise, and validate text is speakable for TTS fallback. */
export function buildVoiceFallbackText(raw: string): string | null {
  // Strip fenced code blocks
  let text = raw.replace(/```[\s\S]*?```/g, '');
  // Strip inline code
  text = text.replace(/`[^`]+`/g, '');
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
  // Collapse whitespace
  text = text.replace(/\n{2,}/g, '. ').replace(/\n/g, ' ').replace(/\s{2,}/g, ' ').trim();
  // Must have at least 3 letter characters (unicode-aware for non-Latin scripts)
  if (!/\p{L}{3,}/u.test(text)) return null;
  // Cap length
  if (text.length > FALLBACK_MAX_CHARS) {
    text = text.slice(0, FALLBACK_MAX_CHARS).replace(/\s\S*$/, '') + '…';
  }
  return text;
}

/** Reduce a reply to a short spoken summary for ADHD/dyslexia-friendly playback. */
export function buildConciseSpeechText(raw: string): string | null {
  const cleaned = buildVoiceFallbackText(raw);
  if (!cleaned) return null;

  const sentenceMatch = cleaned.match(/^(.{1,180}?[.!?])(?:\s|$)/);
  if (sentenceMatch?.[1]) return sentenceMatch[1].trim();

  if (cleaned.length <= 140) return cleaned;

  const clipped = cleaned.slice(0, 180).replace(/\s+\S*$/, '').trim();
  return clipped ? `${clipped}…` : cleaned;
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

// ─── Hook ───────────────────────────────────────────────────────────────────────

interface UseChatTTSDeps {
  soundEnabled: React.RefObject<boolean>;
  speak: React.RefObject<(text: string) => void>;
}

export function useChatTTS({ soundEnabled, speak }: UseChatTTSDeps) {
  const voiceReplyPendingRef = useRef(false);
  const playedSoundsRef = useRef<Map<string, number>>(new Map());

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
    voiceReplyPendingRef.current = false;
  }, []);

  /**
   * Handle TTS for a completed assistant turn.
   * Called from chat_final processing when the run is the active run.
   */
  const handleFinalTTS = useCallback((finalData: FinalMessageData | null, isActiveRun: boolean) => {
    if (!isActiveRun && !voiceReplyPendingRef.current) return;

    if (finalData?.ttsText) {
      const speechText = markSpeechIfNew(finalData.ttsText);
      if (speechText) {
        speak.current(speechText);
      }
      voiceReplyPendingRef.current = false;
    } else if (!finalData?.ttsText && voiceReplyPendingRef.current) {
      // Voice fallback: agent forgot [tts:...] marker — auto-speak a cleaned response,
      // and fall back to the raw text if sanitizing strips it too aggressively.
      const fallback = finalData?.text
        ? buildConciseSpeechText(finalData.text) ?? finalData.text.trim()
        : '';
      if (fallback) speak.current(fallback);
      voiceReplyPendingRef.current = false;
    } else if (soundEnabled.current) {
      playPing();
    }
  }, [markSpeechIfNew, soundEnabled, speak]);

  /** Speak explicit `[tts: ...]` markers from cron/background runs that are not the active chat. */
  const handleBackgroundTTS = useCallback((finalData: FinalMessageData | null) => {
    const speechText = finalData?.ttsText?.trim();
    if (!speechText) return;

    const freshSpeechText = markSpeechIfNew(speechText);
    if (!freshSpeechText) return;
    speak.current(freshSpeechText);
  }, [markSpeechIfNew, speak]);

  /** Recovery path: if a cron message arrives through history polling, speak its hidden marker once. */
  const handleHistoryTTS = useCallback((previous: ChatMsg[], next: ChatMsg[]) => {
    const previousKeys = new Set(previous.map((msg) => makeHistoryMessageKey(msg)));
    const latestPreviousTs = previous.reduce((latest, msg) => Math.max(latest, msg.timestamp.getTime()), 0);

    for (const msg of next) {
      const speechText = msg.ttsText?.trim();
      if (!speechText) continue;
      if (previousKeys.has(makeHistoryMessageKey(msg))) continue;
      if (latestPreviousTs > 0 && msg.timestamp.getTime() < latestPreviousTs) continue;

      const freshSpeechText = markSpeechIfNew(speechText);
      if (!freshSpeechText) continue;
      speak.current(freshSpeechText);
    }
  }, [markSpeechIfNew, speak]);

  /** Play the completion ping sound if sound is enabled. */
  const playCompletionPing = useCallback(() => {
    if (soundEnabled.current) playPing();
  }, [soundEnabled]);

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
  if (msg.msgId) return `id:${msg.msgId}`;
  return [
    msg.role,
    msg.timestamp.getTime(),
    msg.rawText,
    msg.ttsText ?? '',
  ].join('::');
}
