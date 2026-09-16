import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { RefObject } from 'react';
import { buildConciseSpeechText, buildVoiceFallbackText, FALLBACK_MAX_CHARS, VOICE_REPLY_SPOKEN_EVENT, useChatTTS } from './useChatTTS';
import { publishVoiceControlSnapshot, type VoiceControlSnapshot } from '@/features/voice/voiceControlBridge';
import { playPing } from '@/features/voice/audio-feedback';

vi.mock('@/features/voice/audio-feedback', () => ({
  playPing: vi.fn(),
}));

function makeRef<T>(value: T) {
  return { current: value } as RefObject<T>;
}

function publishVoiceState(
  voiceState: VoiceControlSnapshot['voiceState'],
  continuousVoiceEnabled = false,
) {
  publishVoiceControlSnapshot({
    voiceState,
    continuousVoiceEnabled,
    wakeWordEnabled: false,
    voiceError: null,
    isMicrophoneMuted: false,
  });
}

describe('useChatTTS', () => {
  it('keeps gateway finals silent while GPT-Live owns the conversation audio', () => {
    const fallbackSpeak = vi.fn();
    publishVoiceState('idle', true);
    const { result } = renderHook(() => useChatTTS({
      soundEnabled: makeRef(false),
      speak: makeRef(fallbackSpeak),
    }));

    act(() => {
      result.current.trackVoiceMessage('send this to the research session');
      result.current.handleFinalTTS({
        message: { role: 'assistant', content: 'I sent it to research.' } as never,
        text: 'I sent it to research.',
        ttsText: null,
        charts: [],
      }, true);
    });

    expect(fallbackSpeak).not.toHaveBeenCalled();
    publishVoiceState('idle');
  });

  it('does not replay a gateway final after a Nerve Live reconnect', () => {
    const fallbackSpeak = vi.fn();
    publishVoiceState('idle', true);
    const { result, unmount } = renderHook(() => useChatTTS({
      soundEnabled: makeRef(false),
      speak: makeRef(fallbackSpeak),
    }));

    act(() => {
      result.current.handleFinalTTS({
        message: { role: 'assistant', content: 'Visible after disconnect.' } as never,
        text: 'Visible after disconnect.',
        ttsText: null,
        charts: [],
      }, true);
    });

    expect(fallbackSpeak).not.toHaveBeenCalled();

    act(() => publishVoiceState('idle', false));
    expect(fallbackSpeak).not.toHaveBeenCalled();
    unmount();
    publishVoiceState('idle');
  });

  it('does not double-ping when final reply and completion events arrive together', () => {
    vi.useFakeTimers();
    const playPingMock = vi.mocked(playPing);
    playPingMock.mockClear();
    const { result } = renderHook(() => useChatTTS({
      soundEnabled: makeRef(true),
      voiceReadbackEnabled: makeRef(false),
      speak: makeRef(vi.fn()),
    }));

    act(() => {
      result.current.handleFinalTTS({
        message: { role: 'assistant', content: 'Done.' } as never,
        text: 'Done.',
        ttsText: null,
        charts: [],
      }, true);
      result.current.playCompletionPing();
    });

    expect(playPingMock).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(2001);
      result.current.playCompletionPing();
    });

    expect(playPingMock).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
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

  it('speaks active visible replies when readback is on even if sound effects are off', () => {
    const speak = vi.fn();
    const { result } = renderHook(() => useChatTTS({
      soundEnabled: makeRef(false),
      voiceReadbackEnabled: makeRef(true),
      speak: makeRef(speak),
    }));

    act(() => {
      result.current.handleFinalTTS({
        message: { role: 'assistant', content: 'Visible reply should be read.' } as never,
        text: 'Visible reply should be read.',
        ttsText: null,
        charts: [],
      }, true);
    });

    expect(speak).toHaveBeenCalledWith('Visible reply should be read.');
  });

  it('speaks approval notices as a short human prompt', () => {
    const approval = [
      '[Approval]',
      '',
      'Approval needed. Codex app-server command approval Method: item/commandExecution/requestApproval Source: Codex app-server Tool: codex_command_approval Severity: warning ID: plugin:aeb7c062-64e1-4f82-b049-b279703cdd80 Reply: /approve plugin:aeb7c062-64e1-4f82-b049-b279703cdd80 allow-once Reply: /approve plugin:aeb7c062-64e1-4f82-b049-b279703cdd80 allow-always Reply: /approve plugin:aeb7c062-64e1-4f82-b049-b279703cdd80 deny',
    ].join('\n');

    expect(buildVoiceFallbackText(approval)).toBe('Approval needed, Alex, can you approve this?');
  });

  it('uses the short approval prompt for active approval readback', () => {
    const speak = vi.fn();
    const { result } = renderHook(() => useChatTTS({
      soundEnabled: makeRef(false),
      voiceReadbackEnabled: makeRef(true),
      speak: makeRef(speak),
    }));
    const approval = '[Approval]\n\nApproval needed. Codex app-server command approval Method: item/commandExecution/requestApproval Source: Codex app-server Tool: codex_command_approval Severity: warning ID: plugin:aeb7c062-64e1-4f82-b049-b279703cdd80 Reply: /approve plugin:aeb7c062-64e1-4f82-b049-b279703cdd80 allow-once';

    act(() => {
      result.current.handleFinalTTS({
        message: { role: 'assistant', content: approval } as never,
        text: approval,
        ttsText: null,
        charts: [],
      }, true);
    });

    expect(speak).toHaveBeenCalledWith('Approval needed, Alex, can you approve this?');
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

  it('defers active voice replies while voice input is transcribing', async () => {
    vi.useFakeTimers();
    const speak = vi.fn(async () => undefined);
    const onSpoken = vi.fn();
    window.addEventListener(VOICE_REPLY_SPOKEN_EVENT, onSpoken);
    const { result, unmount } = renderHook(() => useChatTTS({
      soundEnabled: makeRef(false),
      speak: makeRef(speak),
    }));

    act(() => {
      publishVoiceState('transcribing');
      result.current.trackVoiceMessage('[voice] wake up');
      result.current.handleFinalTTS({
        message: { role: 'assistant', content: 'Board is active.' } as never,
        text: 'Board is active.',
        ttsText: 'Board is active.',
        charts: [],
      }, true);
    });

    expect(speak).not.toHaveBeenCalled();

    act(() => {
      publishVoiceState('idle');
      vi.advanceTimersByTime(1499);
    });
    expect(speak).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(speak).toHaveBeenCalledWith('Board is active.');
    expect(onSpoken).toHaveBeenCalledTimes(1);
    window.removeEventListener(VOICE_REPLY_SPOKEN_EVENT, onSpoken);
    unmount();
    vi.useRealTimers();
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

  it('speaks full active typed replies when voice playback is enabled', () => {
    const speak = vi.fn();
    const { result } = renderHook(() => useChatTTS({
      soundEnabled: makeRef(true),
      speak: makeRef(speak),
    }));
    const reply = [
      'First sentence gives the headline.',
      '',
      'Second sentence gives the useful detail.',
      'Third sentence gives the next action.',
    ].join('\n');

    act(() => {
      result.current.handleFinalTTS({
        message: { role: 'assistant', content: reply } as never,
        text: reply,
        ttsText: null,
        charts: [],
      }, true);
    });

    expect(speak).toHaveBeenCalledWith(
      'First sentence gives the headline. Second sentence gives the useful detail. Third sentence gives the next action.',
    );
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

  it('speaks the full visible status answer for active voice replies', () => {
    const speak = vi.fn();
    const { result } = renderHook(() => useChatTTS({
      soundEnabled: makeRef(false),
      speak: makeRef(speak),
    }));
    const taskStatus = [
      'We’re in a steady but partially blocked state.',
      '',
      '1 active task: Andrew Miles video scripts — still blocked until the script source and send-ready destination are provided.',
      '1 next-up backlog task: Rory video edits.',
      'Other backlog items: John Edwards and Josephine conversion.',
      'Completed: BNI Laura video edits.',
      'So the main thing holding us up is the Andrew Miles unblock.',
    ].join('\n');

    act(() => {
      result.current.trackVoiceMessage('[voice] Jane wanted to know how are we doing with the tasks');
      result.current.handleFinalTTS({
        message: { role: 'assistant', content: taskStatus } as never,
        text: taskStatus,
        ttsText: null,
        charts: [],
      }, false);
    });

    expect(speak).toHaveBeenCalledTimes(1);
    const spoken = speak.mock.calls[0]?.[0] as string;
    expect(spoken).toContain('We’re in a steady but partially blocked state.');
    expect(spoken).toContain('Andrew Miles video scripts');
    expect(spoken).toContain('Rory video edits');
    expect(spoken).toContain('main thing holding us up is the Andrew Miles unblock');
  });

  it('keeps multi-line heartbeat/status updates speakable beyond the first sentence', () => {
    const heartbeat = [
      'Heartbeat check done.',
      '',
      'No unreplied user command showed up in the recent session context for this run.',
      'Live active task: P0-andrew-miles-video-scripts',
      'I re-read the task protocol, checked the live lanes in order, and updated the active task note.',
      'Short accountability update for Alex: Andrew Miles is still the only active item, and it is still blocked on the operator side: the script source/send-ready files and Andrew send channel are not present in the live workspace yet.',
      '',
      'Agent action needed now: None yet. This is not ready for delegation until the script files or their exact location appear. After that, the next clean step is to package and send them, and then Rory video editing becomes next in line.',
    ].join('\n');

    const fallback = buildConciseSpeechText(heartbeat);

    expect(fallback).toContain('Heartbeat check done.');
    expect(fallback).toContain('Live active task: P0 andrew miles video scripts');
    expect(fallback).toContain('still blocked on the operator side');
    expect(fallback).toContain('Agent action needed now: None yet.');
    expect(fallback).toContain('Rory video editing becomes next in line.');
  });

  it('speaks short inline-code task lane labels as natural words', () => {
    const taskStatus = [
      'What I found:',
      '',
      '- `in-progress` has 2 active tasks:',
      '  - Rory video edit',
      '  - Reza terms old site',
      '- `review/` does not exist in the live board right now.',
      '- `todo/` and `backlog/` both have task files, but nothing there is ahead of the in-progress lane.',
    ].join('\n');

    const fallback = buildVoiceFallbackText(taskStatus);

    expect(fallback).toContain('in progress has 2 active tasks');
    expect(fallback).toContain('review does not exist');
    expect(fallback).toContain('todo and backlog both have task files');
    expect(fallback).toContain('ahead of the in progress lane');
  });

  it('speaks inline-code file and task labels without symbol noise', () => {
    const fallback = buildVoiceFallbackText('Live task source is still `P1-edit-rory-videos/task.md`.');

    expect(fallback).toBe('Live task source is still P1 edit rory videos task md.');
  });

  it('speaks short inline-code pricing labels that start with currency symbols', () => {
    const positioning = [
      'The simplest positioning is:',
      '',
      '- `£75/month` = founder records, you edit and post',
      '- `£149-£249/month` = AI avatar version',
      '- `£299+ setup` = build the digital twin once',
    ].join('\n');

    const fallback = buildVoiceFallbackText(positioning);

    expect(fallback).toContain('£75 per month = founder records');
    expect(fallback).toContain('£149 to £249 per month = AI avatar version');
    expect(fallback).toContain('£299 plus setup = build the digital twin once');
  });

  it('speaks compact business labels with percentages, ranges, billing shorthand, and multipliers', () => {
    const summary = [
      '- `20%` growth',
      '- `15-25%` range',
      '- `$99/mo` plan',
      '- `p/m` billing',
      '- `£149–£249/month` range',
      '- `2x` lift',
      '- `10×` increase',
    ].join('\n');

    const fallback = buildVoiceFallbackText(summary);

    expect(fallback).toContain('20 percent growth');
    expect(fallback).toContain('15 to 25 percent range');
    expect(fallback).toContain('$99 per month plan');
    expect(fallback).toContain('per month billing');
    expect(fallback).toContain('£149 to £249 per month range');
    expect(fallback).toContain('2 times lift');
    expect(fallback).toContain('10 times increase');
  });

  it('speaks compact business labels with arrows, ampersands, tags, handles, ratios, and fractions', () => {
    const summary = [
      '- `draft → edit → post` flow',
      '- `SEO & ads` label',
      '- `#leadgen` tag',
      '- `@alex` handle',
      '- `3:1` ratio',
      '- `1/3` split',
    ].join('\n');

    const fallback = buildVoiceFallbackText(summary);

    expect(fallback).toContain('draft to edit to post flow');
    expect(fallback).toContain('SEO and ads label');
    expect(fallback).toContain('leadgen tag');
    expect(fallback).toContain('alex handle');
    expect(fallback).toContain('3 to 1 ratio');
    expect(fallback).toContain('1 over 3 split');
  });

  it('does not read real inline code snippets as status labels', () => {
    const fallback = buildVoiceFallbackText('Use `const value = getTask()` in the patch. Then report back.');

    expect(fallback).toBe('Use in the patch. Then report back.');
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

  it('does not re-speak the same assistant text when history poll metadata changes', () => {
    const speak = vi.fn();
    const { result } = renderHook(() => useChatTTS({
      soundEnabled: makeRef(true),
      speak: makeRef(speak),
    }));

    const previous = [{
      msgId: 'assistant-old-id',
      role: 'assistant',
      html: 'Last sentence to read.',
      rawText: 'Last sentence to read.',
      timestamp: new Date('2026-06-12T19:00:00.000Z'),
    }] as never[];
    const next = [{
      msgId: 'assistant-new-id',
      role: 'assistant',
      html: 'Last sentence to read.',
      rawText: 'Last sentence to read.',
      timestamp: new Date('2026-06-12T19:01:10.000Z'),
    }] as never[];

    act(() => {
      result.current.handleHistoryTTS(previous, next);
    });

    expect(speak).not.toHaveBeenCalled();
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

  it('speaks visible background cron finals when the model omits TTS markers', () => {
    const speak = vi.fn();
    const { result } = renderHook(() => useChatTTS({
      soundEnabled: makeRef(true),
      speak: makeRef(speak),
    }));

    act(() => {
      result.current.handleBackgroundTTS({
        message: { role: 'assistant', content: 'Cron finished cleanly.' } as never,
        text: 'Cron finished cleanly.',
        ttsText: null,
        charts: [],
      });
    });

    expect(speak).toHaveBeenCalledWith('Cron finished cleanly.');
  });

  it('speaks markerless background cron finals even when sound effects are off', () => {
    const speak = vi.fn();
    const { result } = renderHook(() => useChatTTS({
      soundEnabled: makeRef(false),
      speak: makeRef(speak),
    }));
    const message = [
      'Quick check-in: both live tasks are still sitting in progress.',
      '',
      'Rory videos: still the active task, waiting on the next edit step.',
      'ICEX post: still live and waiting to be published.',
      '',
      'I checked the live board and the task trail before this update.',
    ].join('\n');

    act(() => {
      result.current.handleBackgroundTTS({
        message: { role: 'assistant', content: message } as never,
        text: message,
        ttsText: null,
        charts: [],
      });
    });

    expect(speak).toHaveBeenCalledTimes(1);
    const spoken = speak.mock.calls[0]?.[0] as string;
    expect(spoken).toContain('Quick check in');
    expect(spoken).toContain('Rory videos');
    expect(spoken).toContain('ICEX post');
    expect(spoken).toContain('I checked the live board');
  });

  it('does not speak background finals when voice readback is off', () => {
    const speak = vi.fn();
    const { result } = renderHook(() => useChatTTS({
      soundEnabled: makeRef(true),
      voiceReadbackEnabled: makeRef(false),
      speak: makeRef(speak),
    }));

    act(() => {
      result.current.handleBackgroundTTS({
        message: { role: 'assistant', content: 'Cron finished cleanly.' } as never,
        text: 'Cron finished cleanly.',
        ttsText: null,
        charts: [],
      });
    });

    expect(speak).not.toHaveBeenCalled();
  });

  it('stops active readback when voice input starts recording', () => {
    const speak = vi.fn();
    const stopSpeaking = vi.fn();
    const { result } = renderHook(() => useChatTTS({
      soundEnabled: makeRef(false),
      speak: makeRef(speak),
      stopSpeaking: makeRef(stopSpeaking),
    }));

    act(() => {
      result.current.handleBackgroundTTS({
        message: { role: 'assistant', content: 'Cron finished cleanly.' } as never,
        text: 'Cron finished cleanly.',
        ttsText: null,
        charts: [],
      });
    });

    expect(speak).toHaveBeenCalledWith('Cron finished cleanly.');

    act(() => {
      publishVoiceState('recording');
    });

    expect(stopSpeaking).toHaveBeenCalledTimes(1);

    act(() => {
      publishVoiceState('idle');
    });
  });

  it('defers background cron TTS while voice input is recording, then speaks after submit confirmation time', () => {
    vi.useFakeTimers();
    const speak = vi.fn();
    const { result, unmount } = renderHook(() => useChatTTS({
      soundEnabled: makeRef(false),
      speak: makeRef(speak),
    }));

    act(() => {
      publishVoiceState('recording');
      result.current.handleBackgroundTTS({
        message: { role: 'assistant', content: 'Visible [tts: Cron message after voice.]' } as never,
        text: 'Visible [tts: Cron message after voice.]',
        ttsText: 'Cron message after voice.',
        charts: [],
      });
    });

    expect(speak).not.toHaveBeenCalled();

    act(() => {
      publishVoiceState('transcribing');
      vi.advanceTimersByTime(2000);
    });

    expect(speak).not.toHaveBeenCalled();

    act(() => {
      publishVoiceState('idle');
      vi.advanceTimersByTime(1499);
    });

    expect(speak).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });

    expect(speak).toHaveBeenCalledTimes(1);
    expect(speak).toHaveBeenCalledWith('Cron message after voice.');
    unmount();
    vi.useRealTimers();
  });

  it('keeps deferred cron TTS in arrival order after voice input ends', () => {
    vi.useFakeTimers();
    const speak = vi.fn();
    const { result, unmount } = renderHook(() => useChatTTS({
      soundEnabled: makeRef(false),
      speak: makeRef(speak),
    }));

    act(() => {
      publishVoiceState('recording');
      result.current.handleBackgroundTTS({
        message: { role: 'assistant', content: 'First [tts: First cron.]' } as never,
        text: 'First [tts: First cron.]',
        ttsText: 'First cron.',
        charts: [],
      });
      result.current.handleBackgroundTTS({
        message: { role: 'assistant', content: 'Second [tts: Second cron.]' } as never,
        text: 'Second [tts: Second cron.]',
        ttsText: 'Second cron.',
        charts: [],
      });
      publishVoiceState('idle');
      vi.advanceTimersByTime(1500);
    });

    expect(speak.mock.calls.map((call) => call[0])).toEqual(['First cron.', 'Second cron.']);
    unmount();
    vi.useRealTimers();
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
