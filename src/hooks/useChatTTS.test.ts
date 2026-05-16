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
});
