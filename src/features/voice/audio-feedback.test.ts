import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock AudioContext and related Web Audio API
const mockStart = vi.fn();
const mockConnect = vi.fn();

const mockCreateBufferSource = vi.fn(() => ({
  buffer: null,
  playbackRate: { value: 1 },
  connect: mockConnect,
  start: mockStart,
}));

const mockDecodeAudioData = vi.fn(() =>
  Promise.resolve({ duration: 1, length: 44100, sampleRate: 44100 } as unknown as AudioBuffer),
);

const mockResume = vi.fn(() => Promise.resolve());

class MockAudioContext {
  state = 'running';
  destination = {};
  createBufferSource = mockCreateBufferSource;
  decodeAudioData = mockDecodeAudioData;
  resume = mockResume;
}

vi.stubGlobal('AudioContext', MockAudioContext);

// Mock fetch for preloading
const mockArrayBuffer = new ArrayBuffer(8);
vi.stubGlobal('fetch', vi.fn(() =>
  Promise.resolve({
    ok: true,
    arrayBuffer: () => Promise.resolve(mockArrayBuffer),
  }),
));

describe('audio-feedback', () => {
  let ensureAudioContext: () => void;
  let playWakePing: () => void;
  let playSubmitPing: () => void;
  let playCancelPing: () => void;
  let playPing: () => void;

  beforeEach(async () => {
    mockStart.mockClear();
    mockConnect.mockClear();
    mockCreateBufferSource.mockClear();
    mockDecodeAudioData.mockClear();
    mockResume.mockClear();
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockClear();

    vi.resetModules();
    const mod = await import('./audio-feedback');
    ensureAudioContext = mod.ensureAudioContext;
    playWakePing = mod.playWakePing;
    playSubmitPing = mod.playSubmitPing;
    playCancelPing = mod.playCancelPing;
    playPing = mod.playPing;

    // Wait for preloads to complete
    await new Promise(r => setTimeout(r, 10));
  });

  describe('ensureAudioContext', () => {
    it('should not throw', () => {
      expect(() => ensureAudioContext()).not.toThrow();
    });
  });

  describe('preloading', () => {
    it('should preload only retained sound effects on module load', () => {
      const fetchCalls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
      const urls = fetchCalls.map((c: string[]) => c[0]);
      expect(urls).toEqual(['/sounds/cancel.ogg', '/sounds/notify.ogg']);
    });

    it('should decode audio data for each file', () => {
      expect(mockDecodeAudioData).toHaveBeenCalled();
    });
  });

  describe('playWakePing', () => {
    it('should keep the API callable without playing prerecorded audio', () => {
      playWakePing();
      expect(mockCreateBufferSource).not.toHaveBeenCalled();
    });
  });

  describe('playSubmitPing', () => {
    it('should keep the API callable without playing prerecorded audio', () => {
      playSubmitPing();
      expect(mockCreateBufferSource).not.toHaveBeenCalled();
    });
  });

  describe('playCancelPing', () => {
    it('should create a buffer source and start it', () => {
      playCancelPing();
      expect(mockCreateBufferSource).toHaveBeenCalled();
      expect(mockStart).toHaveBeenCalledWith(0);
    });
  });

  describe('playPing', () => {
    it('should create a buffer source and start it', () => {
      playPing();
      expect(mockCreateBufferSource).toHaveBeenCalled();
      expect(mockStart).toHaveBeenCalledWith(0);
    });
  });

  describe('multiple plays', () => {
    it('should not create audio sources for the disabled wake confirmation', () => {
      playWakePing();
      playWakePing();
      expect(mockCreateBufferSource).not.toHaveBeenCalled();
    });
  });

  describe('error resilience', () => {
    it('should not throw when AudioContext is unavailable', () => {
      // Even if something goes wrong internally, functions should not throw
      expect(() => playWakePing()).not.toThrow();
      expect(() => playSubmitPing()).not.toThrow();
      expect(() => playCancelPing()).not.toThrow();
      expect(() => playPing()).not.toThrow();
    });
  });
});
