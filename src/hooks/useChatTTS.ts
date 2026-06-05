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

export const FALLBACK_MAX_CHARS = 12000;
export const VOICE_REPLY_SPOKEN_EVENT = 'nerve:voice-reply-spoken';
const TTS_DEDUPE_WINDOW_MS = 60_000;

// ─── Pure helpers ───────────────────────────────────────────────────────────────

/** Strip code blocks, markdown noise, and validate text is speakable for TTS fallback. */
export function buildVoiceFallbackText(raw: string): string | null {
  // Active voice replies must speak the visible answer, not a model-authored
  // marker payload that can accidentally include older chat context.
  let text = stripTTSMarkers(raw);
  // Strip fenced code blocks
  text = text.replace(/```[\s\S]*?```/g, '');
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
  // Keep cron readback whole for normal messages, but prevent accidental
  // huge logs/transcripts from monopolising the browser TTS queue.
  if (text.length > FALLBACK_MAX_CHARS) {
    text = text.slice(0, FALLBACK_MAX_CHARS).replace(/\s\S*$/, '') + '…';
  }
  return text;
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
  speak: React.RefObject<(text: string) => void | Promise<void>>;
}

export function useChatTTS({ soundEnabled, speak }: UseChatTTSDeps) {
  const voiceReplyPendingRef = useRef(false);
  const playedSoundsRef = useRef<Map<string, number>>(new Map());

  const speakText = useCallback((text: string, voiceReply = false) => {
    const done = Promise.resolve(speak.current(text));
    if (voiceReply) {
      void done.finally(() => {
        window.dispatchEvent(new CustomEvent(VOICE_REPLY_SPOKEN_EVENT));
      });
    }
    return done;
  }, [speak]);

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
        ? buildConciseSpeechText(finalData.text) ?? stripTTSMarkers(finalData.text).trim()
        : '';
      voiceReplyPendingRef.current = false;
      if (fallback) speakText(fallback, true);
      return;
    }

    if (finalData?.ttsText) {
      const speechText = markSpeechIfNew(finalData.ttsText);
      if (speechText) {
        speakText(speechText);
      }
      voiceReplyPendingRef.current = false;
    } else if (isActiveRun && finalData?.text && soundEnabled.current) {
      // Typed sales-chat replies should speak the visible bubble after the
      // browser audio path is unlocked; models no longer need to emit [tts:].
      const fallback = buildConciseSpeechText(finalData.text) ?? stripTTSMarkers(finalData.text).trim();
      const speechText = fallback ? markSpeechIfNew(fallback) : null;
      if (speechText) {
        speakText(speechText);
      } else {
        playPing();
      }
    } else if (soundEnabled.current) {
      playPing();
    }
  }, [markSpeechIfNew, soundEnabled, speakText]);

  /** Speak explicit `[tts: ...]` markers from cron/background runs that are not the active chat. */
  const handleBackgroundTTS = useCallback((finalData: FinalMessageData | null) => {
    const speechText = finalData?.ttsText?.trim();
    if (!speechText) return;

    const freshSpeechText = markSpeechIfNew(speechText);
    if (!freshSpeechText) return;
    speakText(freshSpeechText);
  }, [markSpeechIfNew, speakText]);

  /** Recovery path: if a cron/background message arrives through history polling, speak only the newest new assistant bubble. */
  const handleHistoryTTS = useCallback((previous: ChatMsg[], next: ChatMsg[]) => {
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
    const fallback = soundEnabled.current ? buildVoiceFallbackText(newest.rawText) : null;
    const speechText = newest.ttsText?.trim() || fallback;
    if (!speechText) return;

    const freshSpeechText = markSpeechIfNew(speechText);
    if (!freshSpeechText) return;
    speakText(freshSpeechText);
  }, [markSpeechIfNew, soundEnabled, speakText]);

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
