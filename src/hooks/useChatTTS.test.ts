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

  it('shortens long tts text into a concise spoken summary', () => {
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

    expect(speak).toHaveBeenCalledWith('First sentence explains the answer. Second sentence adds detail that should stay in chat.');
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
});
