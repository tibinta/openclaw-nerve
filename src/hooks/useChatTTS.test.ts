import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { RefObject } from 'react';
import { useChatTTS } from './useChatTTS';

function makeRef<T>(value: T) {
  return { current: value } as RefObject<T>;
}

describe('useChatTTS', () => {
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
