import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { buildTTSRequestBody, extractTTSMarkers, findAudioSpeechBounds, migrateTTSProvider, splitSpeechIntoTTSChunks, useTTS } from './useTTS';

describe('extractTTSMarkers', () => {
  it('should extract a single TTS marker', () => {
    const result = extractTTSMarkers('Hello [tts: world] there');
    expect(result.cleaned).toBe('Hello  there');
    expect(result.ttsText).toBe('world');
  });

  it('should extract only the first TTS marker text', () => {
    const result = extractTTSMarkers('[tts: first] and [tts: second]');
    expect(result.ttsText).toBe('first');
  });

  it('should remove all TTS markers from cleaned text', () => {
    const result = extractTTSMarkers('[tts: one] some [tts: two] text');
    expect(result.cleaned).toBe('some  text');
  });

  it('should return null ttsText when no markers present', () => {
    const result = extractTTSMarkers('No markers here');
    expect(result.cleaned).toBe('No markers here');
    expect(result.ttsText).toBeNull();
  });

  it('should handle empty string', () => {
    const result = extractTTSMarkers('');
    expect(result.cleaned).toBe('');
    expect(result.ttsText).toBeNull();
  });

  it('should handle marker at start of string', () => {
    const result = extractTTSMarkers('[tts: hello] world');
    expect(result.cleaned).toBe('world');
    expect(result.ttsText).toBe('hello');
  });

  it('should handle marker at end of string', () => {
    const result = extractTTSMarkers('hello [tts: world]');
    expect(result.cleaned).toBe('hello');
    expect(result.ttsText).toBe('world');
  });

  it('should handle marker with spaces in content', () => {
    const result = extractTTSMarkers('[tts: hello world] text');
    expect(result.ttsText).toBe('hello world');
  });

  it('should handle marker with special characters', () => {
    const result = extractTTSMarkers('[tts: say "hello!"] text');
    expect(result.ttsText).toBe('say "hello!"');
  });

  it('should handle brackets inside the TTS payload', () => {
    const result = extractTTSMarkers('Hello [tts: Use [brackets] safely] there');
    expect(result.cleaned).toBe('Hello  there');
    expect(result.ttsText).toBe('Use [brackets] safely');
  });

  it('should not match incomplete brackets', () => {
    const result = extractTTSMarkers('[tts: unclosed text');
    expect(result.cleaned).toBe('[tts: unclosed text');
    expect(result.ttsText).toBeNull();
  });

  it('should handle string that is only a marker', () => {
    const result = extractTTSMarkers('[tts: entire string]');
    expect(result.cleaned).toBe('');
    expect(result.ttsText).toBe('entire string');
  });

  it('ignores non-canonical markers without a space after the colon', () => {
    const result = extractTTSMarkers('[tts:jfdkjfldjfdjfdjfkldjlkfdjklfd]');
    expect(result.cleaned).toBe('[tts:jfdkjfldjfdjfdjfkldjlkfdjklfd]');
    expect(result.ttsText).toBeNull();
  });

  it('ignores empty canonical markers', () => {
    const result = extractTTSMarkers('Text [tts: ]');
    expect(result.cleaned).toBe('Text');
    expect(result.ttsText).toBeNull();
  });
});

describe('migrateTTSProvider', () => {
  it('should migrate "qwen" to "replicate"', () => {
    expect(migrateTTSProvider('qwen')).toBe('replicate');
  });

  it('should keep "openai" as-is', () => {
    expect(migrateTTSProvider('openai')).toBe('openai');
  });

  it('should keep "replicate" as-is', () => {
    expect(migrateTTSProvider('replicate')).toBe('replicate');
  });

  it('should keep "edge" as-is', () => {
    expect(migrateTTSProvider('edge')).toBe('edge');
  });

  it('should keep "xiaomi" as-is', () => {
    expect(migrateTTSProvider('xiaomi')).toBe('xiaomi');
  });

  it('should keep "holler" as-is', () => {
    expect(migrateTTSProvider('holler')).toBe('holler');
  });

  it('should default unknown values to "holler"', () => {
    expect(migrateTTSProvider('unknown')).toBe('holler');
    expect(migrateTTSProvider('')).toBe('holler');
  });
});

describe('buildTTSRequestBody', () => {
  it('includes provider and text by default', () => {
    expect(buildTTSRequestBody('Hello', 'edge')).toEqual({
      text: 'Hello',
      provider: 'edge',
    });
  });

  it('includes selected model and voice when provided', () => {
    expect(buildTTSRequestBody('Hello', 'openai', { model: 'gpt-4o-mini-tts', voice: 'marin' })).toEqual({
      text: 'Hello',
      provider: 'openai',
      model: 'gpt-4o-mini-tts',
      voice: 'marin',
    });
  });
});

describe('splitSpeechIntoTTSChunks', () => {
  it('splits natural sentences for faster first playback', () => {
    expect(splitSpeechIntoTTSChunks('First thing. Second thing! Third thing?')).toEqual([
      'First thing.',
      'Second thing!',
      'Third thing?',
    ]);
  });

  it('keeps short fragments together until they sound like a real sentence', () => {
    expect(splitSpeechIntoTTSChunks('Yes. OK. Do this next.')).toEqual([
      'Yes. OK. Do this next.',
    ]);
  });

  it('force-splits very long text even without punctuation', () => {
    const longText = Array.from({ length: 120 }, (_, index) => `word${index}`).join(' ');
    const chunks = splitSpeechIntoTTSChunks(longText);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join(' ')).toBe(longText);
  });
});

describe('findAudioSpeechBounds', () => {
  it('trims leading and trailing silence while preserving a small speech pad', () => {
    const channel = new Float32Array(1000);
    channel[300] = 0.02;
    channel[700] = -0.02;

    expect(findAudioSpeechBounds([channel], 1000, 0.004, 0.035)).toEqual({
      start: 265,
      end: 736,
    });
  });

  it('keeps all-silent buffers intact so bad audio is not reduced to nothing', () => {
    const channel = new Float32Array(1000);

    expect(findAudioSpeechBounds([channel], 1000, 0.004, 0.035)).toEqual({
      start: 0,
      end: 1000,
    });
  });
});

describe('useTTS queued playback', () => {
  const originalFetch = globalThis.fetch;
  const originalAudio = globalThis.Audio;
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  const playCalls: string[] = [];
  const requestedTexts: string[] = [];
  const requestedUrls: string[] = [];
  const pendingAudio: MockAudio[] = [];

  async function flushSpeechQueue() {
    for (let i = 0; i < 8; i++) {
      await Promise.resolve();
    }
  }

  class MockAudio extends EventTarget {
    src = '';
    ended = false;

    constructor(src?: string) {
      super();
      this.src = src ?? '';
    }

    async play() {
      playCalls.push(this.src);
      pendingAudio.push(this);
    }

    pause() {
      this.ended = true;
    }

    finish() {
      this.ended = true;
      this.dispatchEvent(new Event('ended'));
    }
  }

  beforeEach(() => {
    vi.useFakeTimers();
    playCalls.length = 0;
    requestedTexts.length = 0;
    requestedUrls.length = 0;
    pendingAudio.length = 0;
    let urlIndex = 0;

    globalThis.fetch = vi.fn(async (url, init) => {
      requestedUrls.push(String(url));
      const body = JSON.parse(String(init?.body ?? '{}')) as { text?: string };
      requestedTexts.push(body.text ?? '');
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'Content-Type': 'audio/mpeg' },
      });
    }) as typeof fetch;

    globalThis.Audio = MockAudio as unknown as typeof Audio;
    URL.createObjectURL = vi.fn(() => `blob:tts-${++urlIndex}`);
    URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
    globalThis.Audio = originalAudio;
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
  });

  it('renders sentence chunks immediately while playback stays ordered with a 200ms gap', async () => {
    const { result } = renderHook(() => useTTS(true, 'edge'));

    await act(async () => {
      void result.current.speak('First sentence is ready. Second sentence follows.');
      await flushSpeechQueue();
    });

    expect(requestedTexts).toEqual([
      'First sentence is ready.',
      'Second sentence follows.',
    ]);
    expect(playCalls).toEqual(['blob:tts-1']);

    await act(async () => {
      pendingAudio[0]?.finish();
      await flushSpeechQueue();
    });
    expect(playCalls).toEqual(['blob:tts-1']);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(199);
      await flushSpeechQueue();
    });
    expect(playCalls).toEqual(['blob:tts-1']);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
      await flushSpeechQueue();
    });
    expect(playCalls).toEqual(['blob:tts-1', 'blob:tts-2']);
  });

  it('uses the pre-rendered audio queue for multi-sentence Holler replies', async () => {
    const { result } = renderHook(() => useTTS(true, 'holler'));

    await act(async () => {
      void result.current.speak('First Holler sentence is ready. Second Holler sentence follows.');
      await flushSpeechQueue();
    });

    expect(requestedUrls).toEqual(['/api/tts', '/api/tts']);
    expect(requestedTexts).toEqual([
      'First Holler sentence is ready.',
      'Second Holler sentence follows.',
    ]);
    expect(playCalls).toEqual(['blob:tts-1']);

    await act(async () => {
      pendingAudio[0]?.finish();
      await vi.advanceTimersByTimeAsync(200);
      await flushSpeechQueue();
    });

    expect(playCalls).toEqual(['blob:tts-1', 'blob:tts-2']);
  });

  it('queues a newer speak call until the current answer finishes', async () => {
    const { result } = renderHook(() => useTTS(true, 'edge'));

    await act(async () => {
      void result.current.speak('Old first sentence is ready. Old second sentence follows.');
      await flushSpeechQueue();
    });
    expect(requestedTexts[0]).toBe('Old first sentence is ready.');
    expect(requestedTexts[1]).toBe('Old second sentence follows.');

    await act(async () => {
      void result.current.speak('New sentence wins.');
      await flushSpeechQueue();
    });

    expect(playCalls).toEqual(['blob:tts-1']);

    await act(async () => {
      pendingAudio[0]?.finish();
      await vi.advanceTimersByTimeAsync(200);
      await flushSpeechQueue();
    });

    expect(playCalls).toEqual(['blob:tts-1', 'blob:tts-2']);
    expect(requestedTexts).not.toContain('New sentence wins.');

    await act(async () => {
      pendingAudio[1]?.finish();
      await flushSpeechQueue();
    });

    expect(requestedTexts).toContain('New sentence wins.');
    expect(playCalls).toEqual(['blob:tts-1', 'blob:tts-2', 'blob:tts-3']);
  });

  it('pre-decodes later sentence chunks before the first chunk finishes', async () => {
    const originalWindowAudioContext = window.AudioContext;
    const originalBlob = globalThis.Blob;
    const decodeCalls: number[] = [];
    const startedSources: Array<EventTarget & { start: () => void; finish: () => void }> = [];

    class MockBuffer {
      numberOfChannels = 1;
      sampleRate = 1000;
      length = 120;
      duration = 0.12;
      private channel = Float32Array.from({ length: 120 }, (_, index) => (index >= 10 && index <= 80 ? 0.02 : 0));

      getChannelData() {
        return this.channel;
      }

      copyToChannel(data: Float32Array) {
        this.channel.set(data.slice(0, this.channel.length));
      }
    }

    class MockBlob {
      type: string;

      constructor(_parts: BlobPart[], options?: BlobPropertyBag) {
        this.type = options?.type ?? '';
      }

      async arrayBuffer() {
        return new ArrayBuffer(8);
      }
    }

    class MockSource extends EventTarget {
      buffer: MockBuffer | null = null;
      connect = vi.fn();

      start() {
        startedSources.push(this);
      }

      finish() {
        this.dispatchEvent(new Event('ended'));
      }
    }

    class MockAudioContext {
      state: AudioContextState = 'running';
      destination = {};
      currentTime = 0;
      decodeAudioData = vi.fn(async () => {
        decodeCalls.push(decodeCalls.length + 1);
        return new MockBuffer();
      });
      resume = vi.fn(async () => undefined);
      close = vi.fn(async () => undefined);
      createBufferSource = vi.fn(() => new MockSource());
      createBuffer = vi.fn(() => new MockBuffer());
    }

    window.AudioContext = MockAudioContext as unknown as typeof AudioContext;
    globalThis.Blob = MockBlob as unknown as typeof Blob;
    try {
      const { result } = renderHook(() => useTTS(true, 'edge'));

      await act(async () => {
        void result.current.speak('First sentence is ready. Second sentence follows.');
        await flushSpeechQueue();
      });

      expect(requestedTexts).toEqual([
        'First sentence is ready.',
        'Second sentence follows.',
      ]);
      expect(decodeCalls).toEqual([1, 2]);
      expect(startedSources).toHaveLength(1);

      await act(async () => {
        startedSources[0]?.finish();
        await vi.advanceTimersByTimeAsync(200);
        await flushSpeechQueue();
      });

      expect(startedSources).toHaveLength(2);
      expect(playCalls).toEqual([]);
    } finally {
      window.AudioContext = originalWindowAudioContext;
      globalThis.Blob = originalBlob;
    }
  });
});
