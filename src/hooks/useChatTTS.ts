/**
 * useChatTTS — TTS playback logic extracted from ChatContext
 *
 * Manages voice fallback text generation, TTS marker extraction,
 * auto-speak logic, and played-sound deduplication.
 */
import { useRef, useCallback, useMemo } from 'react';
import { playPing } from '@/features/voice/audio-feedback';
import type { FinalMessageData } from '@/features/chat/operations';

// ─── Constants ──────────────────────────────────────────────────────────────────

export const FALLBACK_MAX_CHARS = 300;

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

// ─── Hook ───────────────────────────────────────────────────────────────────────

interface UseChatTTSDeps {
  soundEnabled: React.RefObject<boolean>;
  speak: React.RefObject<(text: string) => void>;
}

export function useChatTTS({ soundEnabled, speak }: UseChatTTSDeps) {
  const voiceReplyPendingRef = useRef(false);
  const playedSoundsRef = useRef<Set<string>>(new Set());

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

    if (finalData?.ttsText && !playedSoundsRef.current.has(finalData.ttsText)) {
      playedSoundsRef.current.add(finalData.ttsText);
      const concise = buildConciseSpeechText(finalData.ttsText) ?? finalData.ttsText;
      speak.current(concise);
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
  }, [soundEnabled, speak]);

  /** Play the completion ping sound if sound is enabled. */
  const playCompletionPing = useCallback(() => {
    if (soundEnabled.current) playPing();
  }, [soundEnabled]);

  return useMemo(() => ({
    trackVoiceMessage,
    resetPlayedSounds,
    handleFinalTTS,
    playCompletionPing,
  }), [
    trackVoiceMessage,
    resetPlayedSounds,
    handleFinalTTS,
    playCompletionPing,
  ]);
}
