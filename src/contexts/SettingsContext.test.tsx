import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsProvider, useSettings } from './SettingsContext';

vi.mock('@/features/tts/useTTS', () => ({
  migrateTTSProvider: (provider: string) => provider,
  useTTS: () => ({ speak: vi.fn(), stopSpeaking: vi.fn(), isSpeaking: false }),
}));

vi.mock('@/features/voice/audio-feedback', () => ({ unlockBrowserAudio: vi.fn(async () => true) }));

describe('browser voice readback preference', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
  });

  it.each([
    [null, false],
    ['false', false],
    ['true', true],
  ])('respects saved value %s and defaults to off', (saved, expected) => {
    if (saved !== null) localStorage.setItem('nerve:voice-readback-enabled', saved);
    const { result } = renderHook(() => useSettings(), { wrapper: SettingsProvider });
    expect(result.current.voiceReadbackEnabled).toBe(expected);
  });

  it('keeps Read off when browser audio is unlocked', async () => {
    const { result } = renderHook(() => useSettings(), { wrapper: SettingsProvider });
    await act(async () => { await result.current.unlockVoicePlayback(); });
    expect(result.current.voicePlaybackUnlocked).toBe(true);
    expect(result.current.voiceReadbackEnabled).toBe(false);
    expect(localStorage.getItem('nerve:voice-readback-enabled')).not.toBe('true');
  });

  it('allows an explicit opt-in and keeps it for the next mount', () => {
    const first = renderHook(() => useSettings(), { wrapper: SettingsProvider });
    act(() => first.result.current.toggleVoiceReadback());
    expect(first.result.current.voiceReadbackEnabled).toBe(true);
    expect(localStorage.getItem('nerve:voice-readback-enabled')).toBe('true');
    first.unmount();
    const second = renderHook(() => useSettings(), { wrapper: SettingsProvider });
    expect(second.result.current.voiceReadbackEnabled).toBe(true);
  });
});
