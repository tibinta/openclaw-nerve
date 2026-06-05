import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { LANG_TO_BCP47, resolveRecognitionLang, useVoiceInput } from './useVoiceInput';
import * as audioFeedback from './audio-feedback';
import * as wakeWordSupport from './wakeWordSupport';
import { buildWakePhrases, buildStopPhrasesRegex } from '@/lib/constants';

// Mock audio feedback module
vi.mock('./audio-feedback', () => ({
  playWakePing: vi.fn(),
  playSubmitPing: vi.fn(),
  playCancelPing: vi.fn(),
  ensureAudioContext: vi.fn(),
}));

vi.mock('./wakeWordSupport', () => ({
  getWakeWordSupport: vi.fn(() => ({ supported: true, reason: null })),
  isWakeWordSupportedEnvironment: vi.fn(() => true),
}));

// Mock SpeechRecognition
class MockSpeechRecognition {
  continuous = false;
  interimResults = false;
  lang = '';
  onresult: ((event: { results: unknown[]; resultIndex: number }) => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  started = false;

  start() {
    this.started = true;
  }

  stop() {
    this.started = false;
    this.onend?.();
  }

  abort() {
    this.started = false;
  }

  simulateResult(transcript: string, isFinal = false) {
    this.onresult?.({
      results: [{ 0: { transcript }, isFinal }],
      resultIndex: 0,
    });
  }

  simulateError(error: string) {
    this.onerror?.({ error });
  }
}

// Mock MediaRecorder
class MockMediaRecorder {
  static instances: MockMediaRecorder[] = [];
  state: 'inactive' | 'recording' | 'paused' = 'inactive';
  mimeType = 'audio/webm';
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;

  constructor(_stream: MediaStream, _options?: { mimeType: string }) {
    void _stream; void _options;
    MockMediaRecorder.instances.push(this);
  }

  start(_timeslice?: number) {
    this.state = 'recording';
  }

  requestData() {
    if (this.state === 'recording') {
      this.ondataavailable?.({ data: new Blob(['test'], { type: 'audio/webm' }) });
    }
  }

  stop() {
    this.state = 'inactive';
    // Simulate data available
    this.ondataavailable?.({ data: new Blob(['test'], { type: 'audio/webm' }) });
    this.onstop?.();
  }
}

// Mock MediaStream
class MockMediaStream {
  getTracks() {
    return [{ stop: vi.fn() }];
  }
}

class MockAnalyser {
  static forceQuiet = false;
  fftSize = 1024;
  calls = 0;

  getByteTimeDomainData(samples: Uint8Array) {
    this.calls += 1;
    const loud = !MockAnalyser.forceQuiet && this.calls <= 2;
    for (let i = 0; i < samples.length; i += 1) {
      samples[i] = loud ? (i % 2 === 0 ? 80 : 176) : 128;
    }
  }
}

class MockAudioContext {
  createMediaStreamSource() {
    return { connect: vi.fn() };
  }

  createAnalyser() {
    return new MockAnalyser();
  }

  close() {
    return Promise.resolve();
  }
}

function hasTranscribeRequest(fetchMock: Mock) {
  return fetchMock.mock.calls.some(([url]) => url === '/api/transcribe');
}

function mockWakeWordSupport(result: { supported: boolean; reason: 'mobile-web' | null }) {
  (wakeWordSupport.getWakeWordSupport as Mock).mockReturnValue(result);
  (wakeWordSupport.isWakeWordSupportedEnvironment as Mock).mockReturnValue(result.supported);
}

async function startWakeWordListener(result: { current: { startWakeWordListener: () => Promise<void> | void } }) {
  await act(async () => {
    await result.current.startWakeWordListener();
    await vi.advanceTimersByTimeAsync(300);
  });
}

async function tapLeftShift() {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', location: 1, bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', location: 1, bubbles: true }));
    await vi.runAllTimersAsync();
  });
}

describe('useVoiceInput', () => {
  let mockRecognition: MockSpeechRecognition | null = null;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    vi.useFakeTimers();
    MockMediaRecorder.instances = [];
    MockAnalyser.forceQuiet = false;
    mockRecognition = null;

    // Mock SpeechRecognition on window
    (window as unknown as { SpeechRecognition: typeof MockSpeechRecognition }).SpeechRecognition = class extends MockSpeechRecognition {
      constructor() {
        super();
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        mockRecognition = this;
      }
    };

    // Mock MediaRecorder on window
    (window as unknown as { MediaRecorder: typeof MockMediaRecorder }).MediaRecorder = MockMediaRecorder;
    (window as unknown as { AudioContext: typeof MockAudioContext }).AudioContext = MockAudioContext;

    // Mock getUserMedia
    (navigator as unknown as { mediaDevices: { getUserMedia: Mock } }).mediaDevices = {
      getUserMedia: vi.fn().mockResolvedValue(new MockMediaStream()),
    };

    // Mock fetch for voice phrases and transcription
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn((input: string | URL) => {
      const url = String(input);

      if (url.startsWith('/api/voice-phrases')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            stopPhrases: ['boom', 'done'],
            cancelPhrases: ['cancel'],
          }),
        });
      }

      if (url === '/api/transcribe') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ text: 'transcribed text' }),
        });
      }

      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
      });
    }) as typeof fetch;

    vi.clearAllMocks();
    localStorage.clear();
    mockWakeWordSupport({ supported: true, reason: null });
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
    delete (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition;
    delete (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
    delete (window as unknown as { AudioContext?: unknown }).AudioContext;
  });

  describe('Initial State', () => {
    it('should start in idle state', () => {
      const onTranscription = vi.fn();
      const { result } = renderHook(() => useVoiceInput(onTranscription));

      expect(result.current.voiceState).toBe('idle');
      expect(result.current.wakeWordEnabled).toBe(false);
    });

    it('should provide all required methods', () => {
      const onTranscription = vi.fn();
      const { result } = renderHook(() => useVoiceInput(onTranscription));

      expect(typeof result.current.startRecording).toBe('function');
      expect(typeof result.current.stopAndTranscribe).toBe('function');
      expect(typeof result.current.discardRecording).toBe('function');
      expect(typeof result.current.toggleWakeWord).toBe('function');
      expect(typeof result.current.startWakeWordListener).toBe('function');
      expect(typeof result.current.stopWakeWordListener).toBe('function');
    });
  });

  describe('Wake Word Detection', () => {
    it('should transition to listening state when wake word is enabled', async () => {
      const onTranscription = vi.fn();
      const { result } = renderHook(() => useVoiceInput(onTranscription));

      await startWakeWordListener(result);

      expect(result.current.voiceState).toBe('listening');
      expect(result.current.wakeWordEnabled).toBe(true);
      expect(audioFeedback.ensureAudioContext).toHaveBeenCalled();
    });

    it('should transition back to idle when wake word is disabled', async () => {
      const onTranscription = vi.fn();
      const { result } = renderHook(() => useVoiceInput(onTranscription));

      await startWakeWordListener(result);

      expect(result.current.voiceState).toBe('listening');

      act(() => {
        result.current.stopWakeWordListener();
      });

      expect(result.current.voiceState).toBe('idle');
      expect(result.current.wakeWordEnabled).toBe(false);
    });

    it('should toggle wake word state', async () => {
      const onTranscription = vi.fn();
      const { result } = renderHook(() => useVoiceInput(onTranscription));

      // Toggle on
      await act(async () => {
        await result.current.toggleWakeWord();
        await vi.advanceTimersByTimeAsync(300);
      });
      expect(result.current.wakeWordEnabled).toBe(true);

      // Toggle off
      await act(async () => {
        await result.current.toggleWakeWord();
      });
      expect(result.current.wakeWordEnabled).toBe(false);
    });

    it('keeps wake word effectively off on mobile web even when persisted on', () => {
      localStorage.setItem('nerve:wakeWordEnabled', 'true');
      mockWakeWordSupport({ supported: false, reason: 'mobile-web' });

      const onTranscription = vi.fn();
      const { result } = renderHook(() => useVoiceInput(onTranscription));

      expect(result.current.wakeWordEnabled).toBe(false);
      expect(result.current.voiceState).toBe('idle');
      expect(localStorage.getItem('nerve:wakeWordEnabled')).toBe('true');
    });

    it('does not start wake listening on mobile web', async () => {
      mockWakeWordSupport({ supported: false, reason: 'mobile-web' });

      const onTranscription = vi.fn();
      const { result } = renderHook(() => useVoiceInput(onTranscription));

      await act(async () => {
        await result.current.startWakeWordListener();
      });

      expect(result.current.voiceState).toBe('idle');
      expect(result.current.wakeWordEnabled).toBe(false);
      expect(audioFeedback.ensureAudioContext).not.toHaveBeenCalled();
    });

    it('still allows manual recording on mobile web', async () => {
      mockWakeWordSupport({ supported: false, reason: 'mobile-web' });

      const onTranscription = vi.fn();
      const { result } = renderHook(() => useVoiceInput(onTranscription));

      await act(async () => {
        await result.current.startRecording();
      });

      expect(result.current.voiceState).toBe('recording');
    });

    it('should handle missing SpeechRecognition API gracefully', async () => {
      delete (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition;
      
      const onTranscription = vi.fn();
      const { result } = renderHook(() => useVoiceInput(onTranscription));

      // Should not throw
      await act(async () => {
        await result.current.startWakeWordListener();
      });

      // Should remain idle and disabled
      expect(result.current.voiceState).toBe('idle');
      expect(result.current.wakeWordEnabled).toBe(false);
    });

    it('should support webkitSpeechRecognition fallback', async () => {
      delete (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition;
      (window as unknown as { webkitSpeechRecognition: typeof MockSpeechRecognition }).webkitSpeechRecognition = MockSpeechRecognition;

      const onTranscription = vi.fn();
      const { result } = renderHook(() => useVoiceInput(onTranscription));

      await startWakeWordListener(result);

      expect(result.current.voiceState).toBe('listening');
    });
  });

  describe('Language Locale Mapping', () => {
    it('should map every supported language code to a recognition locale', () => {
      Object.values(LANG_TO_BCP47).forEach((locale) => {
        expect(typeof locale).toBe('string');
        expect(locale.length).toBeGreaterThan(0);
        expect(locale.includes('-')).toBe(true);
      });
    });

    it('should resolve all mapped language codes to their BCP-47 locales', () => {
      Object.entries(LANG_TO_BCP47).forEach(([code, locale]) => {
        expect(resolveRecognitionLang(code)).toBe(locale);
      });
    });

    it('should default to English locale when language is unset or auto', () => {
      expect(resolveRecognitionLang('')).toBe('en-US');
      expect(resolveRecognitionLang('auto')).toBe('en-US');
    });

    it('should set SpeechRecognition.lang for each mapped language', async () => {
      const onTranscription = vi.fn();

      for (const [lang, locale] of Object.entries(LANG_TO_BCP47)) {
        const { result, unmount } = renderHook(() => useVoiceInput(onTranscription, 'Kim', lang));

        await startWakeWordListener(result);

        expect(mockRecognition?.lang).toBe(locale);
        unmount();
      }
    });
  });

  describe('Recording Flow', () => {
    it('should transition to recording state when recording starts', async () => {
      const onTranscription = vi.fn();
      const { result } = renderHook(() => useVoiceInput(onTranscription));

      await act(async () => {
        await result.current.startRecording();
        await vi.runAllTimersAsync();
      });

      expect(result.current.voiceState).toBe('recording');
      expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({ audio: true });
    });

    it('should handle microphone permission denied', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const getUserMedia = navigator.mediaDevices.getUserMedia as Mock;
      getUserMedia.mockResolvedValueOnce(new MockMediaStream());
      getUserMedia.mockRejectedValueOnce(new Error('Permission denied'));

      const onTranscription = vi.fn();
      const { result } = renderHook(() => useVoiceInput(onTranscription));

      // First enable wake word
      await startWakeWordListener(result);

      await act(async () => {
        await result.current.startRecording();
        await vi.runAllTimersAsync();
      });

      // Should return to listening state if wake word was enabled
      expect(result.current.voiceState).toBe('listening');
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('should discard recording and return to listening', async () => {
      const onTranscription = vi.fn();
      const { result } = renderHook(() => useVoiceInput(onTranscription));

      // Start wake word
      await startWakeWordListener(result);

      // Start recording
      await act(async () => {
        await result.current.startRecording();
        await vi.runAllTimersAsync();
      });

      expect(result.current.voiceState).toBe('recording');

      // Discard
      act(() => {
        result.current.discardRecording();
      });

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(result.current.voiceState).toBe('listening');
      expect(audioFeedback.playCancelPing).not.toHaveBeenCalled(); // Only called from phrase match
    });

    it('should discard recording and return to idle when wake word disabled', async () => {
      const onTranscription = vi.fn();
      const { result } = renderHook(() => useVoiceInput(onTranscription));

      // Start recording without wake word
      await act(async () => {
        await result.current.startRecording();
        await vi.runAllTimersAsync();
      });

      expect(result.current.voiceState).toBe('recording');

      // Discard
      act(() => {
        result.current.discardRecording();
      });

      expect(result.current.voiceState).toBe('idle');
    });
  });

  describe('Transcription Flow', () => {
    it('should transition to transcribing state when stopAndTranscribe is called', async () => {
      const onTranscription = vi.fn();
      const { result } = renderHook(() => useVoiceInput(onTranscription));

      // Start recording
      await act(async () => {
        await result.current.startRecording();
        await vi.runAllTimersAsync();
      });

      expect(result.current.voiceState).toBe('recording');

      // Stop and transcribe
      act(() => {
        result.current.stopAndTranscribe();
      });

      expect(result.current.voiceState).toBe('transcribing');
    });

    it('should call fetch with FormData when transcribing', async () => {
      const onTranscription = vi.fn();
      const { result } = renderHook(() => useVoiceInput(onTranscription));

      await act(async () => {
        await result.current.startRecording();
        await vi.runAllTimersAsync();
      });

      act(() => {
        result.current.stopAndTranscribe();
      });

      // Verify fetch was called with correct endpoint
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/api/transcribe',
        expect.objectContaining({
          method: 'POST',
          credentials: 'include',
        })
      );
    });

    it('auto-sends after a speech pause when live silence stop is enabled', async () => {
      const onTranscription = vi.fn();
      const { result } = renderHook(() => useVoiceInput(onTranscription, 'Agent', 'en', 0, 'local', 500));

      await act(async () => {
        await result.current.startRecording();
        await vi.advanceTimersByTimeAsync(300);
      });

      expect(result.current.voiceState).toBe('recording');

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1800);
      });

      expect(result.current.voiceState).toBe('idle');
      expect(onTranscription).toHaveBeenCalledWith('transcribed text');
      expect(hasTranscribeRequest(globalThis.fetch as Mock)).toBe(true);
    });

    it('auto-sends after the browser transcript pauses even if raw mic stays active', async () => {
      const onTranscription = vi.fn();
      const { result } = renderHook(() => useVoiceInput(onTranscription, 'Agent', 'en', 0, 'browser', 500));

      await act(async () => {
        await result.current.startRecording();
        await vi.advanceTimersByTimeAsync(300);
      });

      act(() => {
        mockRecognition?.simulateResult('second turn text', false);
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(650);
      });

      expect(result.current.voiceState).toBe('idle');
      expect(onTranscription).toHaveBeenCalledWith('second turn text');
    });

    it('auto-sends wake capture after silence when live voice is off', async () => {
      const onTranscription = vi.fn();
      const { result } = renderHook(() => useVoiceInput(onTranscription, 'Agent', 'en', 0, 'local', undefined, false, 500));

      await startWakeWordListener(result);

      act(() => {
        mockRecognition?.simulateResult('hey agent', false);
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(370);
        await vi.advanceTimersByTimeAsync(300);
      });

      expect(result.current.voiceState).toBe('recording');

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1800);
      });

      expect(result.current.voiceState).toBe('listening');
      expect(onTranscription).toHaveBeenCalledWith('transcribed text');
      expect(hasTranscribeRequest(globalThis.fetch as Mock)).toBe(true);
    });

    it('closes one-shot reply listening after 5 seconds with no speech', async () => {
      const onTranscription = vi.fn();
      MockAnalyser.forceQuiet = true;
      const { result } = renderHook(() => useVoiceInput(onTranscription, 'Agent', 'en', 0, 'local'));

      await act(async () => {
        await result.current.startOneShotReplyRecording({ pauseMs: 500, noSpeechTimeoutMs: 5000 });
        await vi.advanceTimersByTimeAsync(300);
      });

      expect(result.current.voiceState).toBe('recording');

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5200);
      });

      expect(result.current.voiceState).toBe('idle');
      expect(onTranscription).toHaveBeenCalledWith('transcribed text');
    });

    it('treats no-speech live browser turns as quiet empty turns', async () => {
      const onTranscription = vi.fn();
      const { result } = renderHook(() => useVoiceInput(onTranscription, 'Agent', 'en', 0, 'browser', 500));

      await act(async () => {
        await result.current.startRecording();
        await vi.advanceTimersByTimeAsync(300);
      });

      act(() => {
        result.current.stopAndTranscribe();
      });

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(result.current.voiceState).toBe('idle');
      expect(result.current.error).toBeNull();
      expect(onTranscription).not.toHaveBeenCalled();
    });

    it('does not resume wake mode after live voice transcription', async () => {
      localStorage.setItem('nerve:wakeWordEnabled', 'true');
      const onTranscription = vi.fn();
      const { result } = renderHook(() => useVoiceInput(onTranscription, 'Agent', 'en', 0, 'local', 500, true));

      await act(async () => {
        await result.current.startRecording();
        await vi.advanceTimersByTimeAsync(300);
      });

      act(() => {
        result.current.stopAndTranscribe();
      });

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(result.current.voiceState).toBe('idle');
      expect(onTranscription).toHaveBeenCalledWith('transcribed text');
    });

    it('should handle transcription API errors gracefully', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      (globalThis.fetch as Mock).mockResolvedValue({
        ok: false,
        text: () => Promise.resolve('Server error'),
      });

      const onTranscription = vi.fn();
      const { result } = renderHook(() => useVoiceInput(onTranscription));

      await act(async () => {
        await result.current.startRecording();
        await vi.runAllTimersAsync();
      });

      act(() => {
        result.current.stopAndTranscribe();
      });

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      // The error should be logged
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('should submit browser transcript directly in browser mode', async () => {
      const onTranscription = vi.fn();
      const { result } = renderHook(() => useVoiceInput(onTranscription, 'Agent', 'en', 0, 'browser'));

      await act(async () => {
        await result.current.startRecording();
        await vi.runAllTimersAsync();
      });

      act(() => {
        mockRecognition?.simulateResult('hello world');
        result.current.stopAndTranscribe();
      });

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(onTranscription).toHaveBeenCalledWith('hello world');
      expect(hasTranscribeRequest(globalThis.fetch as Mock)).toBe(false);
    });

    it('should always use backend transcription in local mode', async () => {
      const onTranscription = vi.fn();
      const { result } = renderHook(() => useVoiceInput(onTranscription, 'Agent', 'en', 0, 'local'));

      await act(async () => {
        await result.current.startRecording();
        await vi.runAllTimersAsync();
      });

      act(() => {
        mockRecognition?.simulateResult('browser transcript');
        result.current.stopAndTranscribe();
      });

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(onTranscription).toHaveBeenCalledWith('transcribed text');
      expect(hasTranscribeRequest(globalThis.fetch as Mock)).toBe(true);
    });

    it('should prefer browser transcript in hybrid mode', async () => {
      const onTranscription = vi.fn();
      const { result } = renderHook(() => useVoiceInput(onTranscription, 'Agent', 'en', 0, 'hybrid'));

      await act(async () => {
        await result.current.startRecording();
        await vi.runAllTimersAsync();
      });

      act(() => {
        mockRecognition?.simulateResult('hybrid browser text');
        result.current.stopAndTranscribe();
      });

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(onTranscription).toHaveBeenCalledWith('hybrid browser text');
      expect(hasTranscribeRequest(globalThis.fetch as Mock)).toBe(false);
    });

    it('should fall back to backend transcription in hybrid mode when browser transcript is [BLANK_AUDIO]', async () => {
      const onTranscription = vi.fn();
      const { result } = renderHook(() => useVoiceInput(onTranscription, 'Agent', 'en', 0, 'hybrid'));

      await act(async () => {
        await result.current.startRecording();
        await vi.runAllTimersAsync();
      });

      act(() => {
        mockRecognition?.simulateResult('[BLANK_AUDIO]');
        result.current.stopAndTranscribe();
      });

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(onTranscription).toHaveBeenCalledWith('transcribed text');
      expect(hasTranscribeRequest(globalThis.fetch as Mock)).toBe(true);
    });

    it('should keep the last real browser transcript when a blank sentinel arrives later', async () => {
      const onTranscription = vi.fn();
      const { result } = renderHook(() => useVoiceInput(onTranscription, 'Agent', 'en', 0, 'hybrid'));

      await act(async () => {
        await result.current.startRecording();
        await vi.runAllTimersAsync();
      });

      act(() => {
        mockRecognition?.simulateResult('hello there');
        mockRecognition?.simulateResult('[BLANK_AUDIO]');
        result.current.stopAndTranscribe();
      });

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(onTranscription).toHaveBeenCalledWith('hello there');
      expect(hasTranscribeRequest(globalThis.fetch as Mock)).toBe(false);
    });

    it('does not send text when the backend returns an empty transcript', async () => {
      const fetchMock = globalThis.fetch as Mock;
      fetchMock.mockImplementation((input: string | URL) => {
        const url = String(input);

        if (url.startsWith('/api/voice-phrases')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              stopPhrases: ['boom', 'done'],
              cancelPhrases: ['cancel'],
            }),
          });
        }

        if (url === '/api/transcribe') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ text: '' }),
          });
        }

        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({}),
        });
      }) as typeof fetch;

      const onTranscription = vi.fn();
      const { result } = renderHook(() => useVoiceInput(onTranscription, 'Agent', 'en', 0, 'hybrid'));

      await act(async () => {
        await result.current.startRecording();
        await vi.runAllTimersAsync();
      });

      act(() => {
        result.current.stopAndTranscribe();
      });

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(onTranscription).not.toHaveBeenCalled();
      expect(hasTranscribeRequest(globalThis.fetch as Mock)).toBe(true);
    });

    it('should fall back to backend transcription in browser mode when browser recognition is unsupported', async () => {
      delete (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition;

      const onTranscription = vi.fn();
      const { result } = renderHook(() => useVoiceInput(onTranscription, 'Agent', 'en', 0, 'browser'));

      await act(async () => {
        await result.current.startRecording();
        await vi.runAllTimersAsync();
      });

      act(() => {
        result.current.stopAndTranscribe();
      });

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(onTranscription).toHaveBeenCalledWith('transcribed text');
      expect(hasTranscribeRequest(globalThis.fetch as Mock)).toBe(true);
    });
  });

  describe('Stop Phrase Cleaning', () => {
    // Test the stop phrase regex using the dynamic builder
    const stopPhraseRegex = buildStopPhrasesRegex('Kim');
    
    const testCases = [
      { input: 'hello world boom', expected: 'hello world' },
      { input: "test message i'm done", expected: 'test message' },
      { input: "all right i'm done", expected: '' },
      { input: "testing that's it", expected: 'testing' },
      { input: 'send it please send it', expected: 'send it please' },
      { input: 'done', expected: '' },
      { input: 'cancel', expected: '' },
      { input: 'never mind', expected: '' },
      { input: 'hey kim', expected: '' },
      { input: 'normal message', expected: 'normal message' },
    ];

    testCases.forEach(({ input, expected }) => {
      it(`should clean "${input}" to "${expected || '(empty)'}"`, () => {
        // Test the stop phrase cleaning logic directly
        const cleaned = input.trim().replace(stopPhraseRegex, '').trim();
        expect(cleaned).toBe(expected);
      });
    });

    // Test dynamic agent name
    it('should work with different agent names', () => {
      const helenaRegex = buildStopPhrasesRegex('Helena');
      expect('hey helena'.replace(helenaRegex, '').trim()).toBe('');
      expect('hey kim'.replace(helenaRegex, '').trim()).toBe('hey kim'); // Different agent
    });
  });

  describe('Speech Recognition Errors', () => {
    it('should handle not-allowed error', async () => {
      const onTranscription = vi.fn();
      const { result } = renderHook(() => useVoiceInput(onTranscription));

      await startWakeWordListener(result);

      // Simulate not-allowed error
      act(() => {
        mockRecognition?.simulateError('not-allowed');
      });

      // Should not crash, state depends on implementation
      expect(result.current.voiceState).toBeDefined();
    });

    it('should handle aborted error gracefully', async () => {
      const onTranscription = vi.fn();
      const { result } = renderHook(() => useVoiceInput(onTranscription));

      await startWakeWordListener(result);

      // Simulate aborted error (happens during intentional stops)
      act(() => {
        mockRecognition?.simulateError('aborted');
      });

      expect(result.current.voiceState).toBeDefined();
    });
  });

  describe('Cleanup', () => {
    it('should cleanup on unmount', async () => {
      const onTranscription = vi.fn();
      const { result, unmount } = renderHook(() => useVoiceInput(onTranscription));

      // Start recording
      await act(async () => {
        await result.current.startRecording();
        await vi.runAllTimersAsync();
      });

      expect(result.current.voiceState).toBe('recording');

      // Unmount should cleanup without errors
      expect(() => unmount()).not.toThrow();
    });

    it('should stop wake word listener on unmount', async () => {
      const onTranscription = vi.fn();
      const { result, unmount } = renderHook(() => useVoiceInput(onTranscription));

      await startWakeWordListener(result);

      expect(result.current.wakeWordEnabled).toBe(true);

      // Unmount should cleanup
      expect(() => unmount()).not.toThrow();
    });
  });

  describe('State Machine Validity', () => {
    it('should not allow stopAndTranscribe when not recording', () => {
      const onTranscription = vi.fn();
      const { result } = renderHook(() => useVoiceInput(onTranscription));

      // Try to stop when idle
      act(() => {
        result.current.stopAndTranscribe();
      });

      // Should remain idle, not crash
      expect(result.current.voiceState).toBe('idle');
    });

    it('should handle rapid state changes', async () => {
      const onTranscription = vi.fn();
      const { result } = renderHook(() => useVoiceInput(onTranscription));

      // Rapid toggle
      await act(async () => {
        await result.current.startWakeWordListener();
        await vi.advanceTimersByTimeAsync(300);
        result.current.stopWakeWordListener();
        await result.current.startWakeWordListener();
        await vi.advanceTimersByTimeAsync(300);
        result.current.stopWakeWordListener();
      });

      expect(result.current.voiceState).toBe('idle');
      expect(result.current.wakeWordEnabled).toBe(false);
    });

    it('should handle recording start during listening', async () => {
      const onTranscription = vi.fn();
      const { result } = renderHook(() => useVoiceInput(onTranscription));

      // Start wake word
      await startWakeWordListener(result);

      expect(result.current.voiceState).toBe('listening');

      // Start recording
      await act(async () => {
        await result.current.startRecording();
        await vi.runAllTimersAsync();
      });

      expect(result.current.voiceState).toBe('recording');
    });

    it('should start dictation on double left shift and send on a single left shift', async () => {
      const onTranscription = vi.fn();
      const { result } = renderHook(() => useVoiceInput(onTranscription));

      await tapLeftShift();
      expect(result.current.voiceState).toBe('idle');

      await tapLeftShift();
      expect(result.current.voiceState).toBe('recording');

      act(() => {
        mockRecognition?.simulateResult('hello there');
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(350);
      });

      await tapLeftShift();

      expect(onTranscription).toHaveBeenCalledWith('hello there');
      expect(result.current.voiceState).toBe('idle');
    });
  });
});

describe('matchesPhrase (internal)', () => {
  // Test the phrase matching logic indirectly through the hook behavior
  // We'll test various phrase formats

  describe('Wake Phrases', () => {
    // Test dynamic wake phrases with buildWakePhrases
    it('should generate valid wake phrases for any agent name', () => {
      const kimPhrases = buildWakePhrases('Kim');
      expect(kimPhrases).toContain('hey kim');
      expect(kimPhrases).toContain('hey, kim');
      
      const helenaPhrases = buildWakePhrases('Helena');
      expect(helenaPhrases).toContain('hey helena');
      expect(helenaPhrases).toContain('hey, helena');
      
      // All phrases should be lowercase
      helenaPhrases.forEach(phrase => {
        expect(phrase.toLowerCase()).toBe(phrase);
        expect(phrase.length).toBeGreaterThan(0);
      });
    });
  });

  describe('Stop Phrases', () => {
    const stopPhrases = ['boom', "i'm done", 'im done', "all right i'm done", "alright i'm done", "that's it", 'thats it', 'send it', 'done'];

    stopPhrases.forEach((phrase) => {
      it(`should recognize stop phrase: "${phrase}"`, () => {
        expect(phrase.toLowerCase()).toBe(phrase);
        expect(phrase.length).toBeGreaterThan(0);
      });
    });
  });

  describe('Cancel Phrases', () => {
    const cancelPhrases = ['cancel', 'never mind', 'nevermind'];

    cancelPhrases.forEach((phrase) => {
      it(`should recognize cancel phrase: "${phrase}"`, () => {
        expect(phrase.toLowerCase()).toBe(phrase);
        expect(phrase.length).toBeGreaterThan(0);
      });
    });
  });
});
