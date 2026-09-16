import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { RefObject } from 'react';
import { buildVoiceFallbackText, FALLBACK_MAX_CHARS, VOICE_REPLY_SPOKEN_EVENT, useChatTTS } from './useChatTTS';

const voiceControlMockState = vi.hoisted(() => ({ continuousVoiceEnabled: false }));
vi.mock('@/features/voice/voiceControlBridge', () => ({
  getLatestVoiceControlSnapshot: () => ({ ...voiceControlMockState }),
}));

function makeRef<T>(value: T) {
  return { current: value } as RefObject<T>;
}

describe('useChatTTS', () => {
  it('does not replay gateway speech while GPT-Live owns audio', () => {
    const speak = vi.fn();
    voiceControlMockState.continuousVoiceEnabled = true;
    const { result } = renderHook(() => useChatTTS({ soundEnabled: makeRef(true), speak: makeRef(speak) }));
    act(() => result.current.handleFinalTTS({ text: 'duplicate', ttsText: 'duplicate' } as never, true));
    expect(speak).not.toHaveBeenCalled();
    voiceControlMockState.continuousVoiceEnabled = false;
  });

  it('speaks an explicit marker even when sound effects are off', () => {
    const speak = vi.fn();
    const { result } = renderHook(() => useChatTTS({
      soundEnabled: makeRef(false),
      speak: makeRef(speak),
    }));

    act(() => {
      result.current.handleFinalTTS({
        message: { role: 'assistant', content: 'Visible [tts: Spoken answer.]' } as never,
        text: 'Visible [tts: Spoken answer.]',
        ttsText: 'Spoken answer.',
        charts: [],
      }, true);
    });

    expect(speak).toHaveBeenCalledWith('Spoken answer.');
  });

  it('auto-speaks the next assistant reply for a voice message even without a TTS marker', () => {
    const speak = vi.fn();
    const { result } = renderHook(() => useChatTTS({
      soundEnabled: makeRef(false),
      speak: makeRef(speak),
    }));

    act(() => {
      result.current.trackVoiceMessage('[voice] please answer');
      result.current.handleFinalTTS({
        message: { role: 'assistant', content: 'OK' } as never,
        text: 'OK',
        ttsText: null,
        charts: [],
      }, false);
    });

    expect(speak).toHaveBeenCalledWith('OK');
  });

  it('does not let history recovery speak an older answer while a voice reply is pending', () => {
    const speak = vi.fn();
    const { result } = renderHook(() => useChatTTS({
      soundEnabled: makeRef(true),
      speak: makeRef(speak),
    }));

    const previous = [{
      msgId: 'old-user',
      role: 'user',
      html: 'How is the weather?',
      rawText: '[voice] How is the weather?',
      timestamp: new Date('2026-06-05T12:13:00.000Z'),
    }] as never[];
    const next = [
      ...previous,
      {
        msgId: 'old-answer',
        role: 'assistant',
        html: 'Which city should I check for tomorrow’s weather?',
        rawText: 'Which city should I check for tomorrow’s weather?',
        timestamp: new Date('2026-06-05T12:13:16.000Z'),
      },
    ] as never[];

    act(() => {
      result.current.trackVoiceMessage('[voice] How is the weather tomorrow in London?');
      result.current.handleHistoryTTS(previous, next);
    });

    expect(speak).not.toHaveBeenCalled();
  });

  it('announces voice reply completion after the queued speech finishes', async () => {
    const speak = vi.fn(async () => undefined);
    const onSpoken = vi.fn();
    window.addEventListener(VOICE_REPLY_SPOKEN_EVENT, onSpoken);
    const { result } = renderHook(() => useChatTTS({
      soundEnabled: makeRef(false),
      speak: makeRef(speak),
    }));

    await act(async () => {
      result.current.trackVoiceMessage('[voice] please answer');
      result.current.handleFinalTTS({
        message: { role: 'assistant', content: 'Ready.' } as never,
        text: 'Ready.',
        ttsText: null,
        charts: [],
      }, false);
      await Promise.resolve();
    });

    expect(speak).toHaveBeenCalledWith('Ready.');
    expect(onSpoken).toHaveBeenCalledTimes(1);
    window.removeEventListener(VOICE_REPLY_SPOKEN_EVENT, onSpoken);
  });

  it('speaks active typed replies when voice playback is enabled', () => {
    const speak = vi.fn();
    const { result } = renderHook(() => useChatTTS({
      soundEnabled: makeRef(true),
      speak: makeRef(speak),
    }));

    act(() => {
      result.current.handleFinalTTS({
        message: { role: 'assistant', content: 'Visible answer.' } as never,
        text: 'Visible answer.',
        ttsText: null,
        charts: [],
      }, true);
    });

    expect(speak).toHaveBeenCalledWith('Visible answer.');
  });

  it('prefers cleaned fallback text when the response is longer', () => {
    const speak = vi.fn();
    const { result } = renderHook(() => useChatTTS({
      soundEnabled: makeRef(false),
      speak: makeRef(speak),
    }));

    act(() => {
      result.current.trackVoiceMessage('[voice] summarize this');
      result.current.handleFinalTTS({
        message: { role: 'assistant', content: '**bold** reply' } as never,
        text: '**bold** reply',
        ttsText: null,
        charts: [],
      }, true);
    });

    expect(speak).toHaveBeenCalledWith('bold reply');
  });

  it('uses visible final text for voice replies even when a TTS marker exists', () => {
    const speak = vi.fn();
    const { result } = renderHook(() => useChatTTS({
      soundEnabled: makeRef(false),
      speak: makeRef(speak),
    }));

    act(() => {
      result.current.trackVoiceMessage('[voice] summarize this');
      result.current.handleFinalTTS({
        message: { role: 'assistant', content: 'Long reply' } as never,
        text: 'Long reply',
        ttsText: 'First sentence explains the answer. Second sentence adds detail that should stay in chat.',
        charts: [],
      }, false);
    });

    expect(speak).toHaveBeenCalledWith('Long reply');
  });

  it('drops COPY noise from spoken fallback text', () => {
    const speak = vi.fn();
    const { result } = renderHook(() => useChatTTS({
      soundEnabled: makeRef(false),
      speak: makeRef(speak),
    }));

    act(() => {
      result.current.trackVoiceMessage('[voice] answer this');
      result.current.handleFinalTTS({
        message: { role: 'assistant', content: 'COPY\nI will do that.' } as never,
        text: 'COPY\nI will do that.',
        ttsText: null,
        charts: [],
      }, false);
    });

    expect(speak).toHaveBeenCalledWith('I will do that.');
  });

  it('speaks the visible voice reply instead of a model-written TTS marker payload', () => {
    const speak = vi.fn();
    const { result } = renderHook(() => useChatTTS({
      soundEnabled: makeRef(false),
      speak: makeRef(speak),
    }));

    act(() => {
      result.current.trackVoiceMessage('[voice] what changed?');
      result.current.handleFinalTTS({
        message: { role: 'assistant', content: 'New answer only. [tts: New answer only. Previous bubble above.]' } as never,
        text: 'New answer only. [tts: New answer only. Previous bubble above.]',
        ttsText: 'New answer only. Previous bubble above.',
        charts: [],
      }, true);
    });

    expect(speak).toHaveBeenCalledTimes(1);
    expect(speak).toHaveBeenCalledWith('New answer only.');
  });

  it('speaks new history messages that carry hidden TTS text', () => {
    const speak = vi.fn();
    const { result } = renderHook(() => useChatTTS({
      soundEnabled: makeRef(false),
      speak: makeRef(speak),
    }));

    const previous = [{
      msgId: 'old',
      role: 'assistant',
      html: 'Old',
      rawText: 'Old',
      timestamp: new Date('2026-06-04T16:00:00.000Z'),
    }] as never[];
    const next = [
      ...previous,
      {
        msgId: 'cron-voice',
        role: 'assistant',
        html: 'Cron visible text',
        rawText: 'Cron visible text',
        ttsText: 'Alex, cron voice is live.',
        timestamp: new Date('2026-06-04T16:00:05.000Z'),
      },
    ] as never[];

    act(() => {
      result.current.handleHistoryTTS(previous, next);
      result.current.handleHistoryTTS(previous, next);
    });

    expect(speak).toHaveBeenCalledTimes(1);
    expect(speak).toHaveBeenCalledWith('Alex, cron voice is live.');
  });

  it('speaks the newest visible history reply instead of an older voice reply', () => {
    const speak = vi.fn();
    const { result } = renderHook(() => useChatTTS({
      soundEnabled: makeRef(true),
      speak: makeRef(speak),
    }));

    const previous = [{
      msgId: 'old-voice',
      role: 'assistant',
      html: 'Yes, I can hear you.',
      rawText: 'Yes, I can hear you.',
      ttsText: 'Yes, I can hear you.',
      timestamp: new Date('2026-06-04T23:40:00.000Z'),
    }] as never[];
    const next = [
      {
        msgId: 'replayed-old-voice',
        role: 'assistant',
        html: 'Yes, I can hear you.',
        rawText: 'Yes, I can hear you.',
        ttsText: 'Yes, I can hear you.',
        timestamp: new Date('2026-06-04T23:40:00.000Z'),
      },
      {
        msgId: 'cron-understood',
        role: 'assistant',
        html: 'Understood.',
        rawText: 'Understood.',
        timestamp: new Date('2026-06-04T23:42:00.000Z'),
      },
    ] as never[];

    act(() => {
      result.current.handleHistoryTTS(previous, next);
    });

    expect(speak).toHaveBeenCalledTimes(1);
    expect(speak).toHaveBeenCalledWith('Understood.');
  });

  it('keeps normal long cron history readback intact instead of clipping at a short preview length', () => {
    const speak = vi.fn();
    const { result } = renderHook(() => useChatTTS({
      soundEnabled: makeRef(true),
      speak: makeRef(speak),
    }));
    const longMessage = Array.from({ length: 36 }, (_, index) => `Sentence ${index + 1} explains the cron result clearly.`).join(' ');
    const previous = [] as never[];
    const next = [{
      msgId: 'cron-long-readback',
      role: 'assistant',
      html: longMessage,
      rawText: longMessage,
      timestamp: new Date('2026-06-05T00:20:00.000Z'),
    }] as never[];

    act(() => {
      result.current.handleHistoryTTS(previous, next);
    });

    expect(longMessage.length).toBeGreaterThan(300);
    expect(speak).toHaveBeenCalledWith(longMessage);
  });

  it('still caps extreme fallback text so a bad transcript cannot block the browser voice queue', () => {
    const veryLongMessage = `${'Clear sentence. '.repeat(1400)}Done.`;
    const fallback = buildVoiceFallbackText(veryLongMessage);

    expect(fallback).not.toBeNull();
    expect(fallback!.length).toBeLessThanOrEqual(FALLBACK_MAX_CHARS + 1);
    expect(fallback).toMatch(/…$/);
  });

  it('speaks explicit TTS markers from background cron finals', () => {
    const speak = vi.fn();
    const { result } = renderHook(() => useChatTTS({
      soundEnabled: makeRef(false),
      speak: makeRef(speak),
    }));

    act(() => {
      result.current.handleBackgroundTTS({
        message: { role: 'assistant', content: 'Visible [tts: Browser cron speech.]' } as never,
        text: 'Visible [tts: Browser cron speech.]',
        ttsText: 'Browser cron speech.',
        charts: [],
      });
    });

    expect(speak).toHaveBeenCalledWith('Browser cron speech.');
  });

  it('does not replay a cron marker when history recovery sees the same speech text', () => {
    const speak = vi.fn();
    const { result } = renderHook(() => useChatTTS({
      soundEnabled: makeRef(false),
      speak: makeRef(speak),
    }));

    const previous = [] as never[];
    const next = [{
      msgId: 'cron-voice-recovery',
      role: 'assistant',
      html: 'Cron visible text',
      rawText: 'Cron visible text',
      ttsText: 'Alex, finish the Laura videos cleanly.',
      timestamp: new Date('2026-06-04T16:00:05.000Z'),
    }] as never[];

    act(() => {
      result.current.handleBackgroundTTS({
        message: { role: 'assistant', content: 'Visible [tts: Alex, finish the Laura videos cleanly.]' } as never,
        text: 'Visible [tts: Alex, finish the Laura videos cleanly.]',
        ttsText: 'Alex, finish the Laura videos cleanly.',
        charts: [],
      });
      result.current.handleHistoryTTS(previous, next);
    });

    expect(speak).toHaveBeenCalledTimes(1);
    expect(speak).toHaveBeenCalledWith('Alex, finish the Laura videos cleanly.');
  });
});
