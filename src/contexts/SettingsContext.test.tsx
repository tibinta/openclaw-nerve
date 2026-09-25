import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsProvider, useSettings } from './SettingsContext';

vi.mock('@/features/tts/useTTS', () => ({
  migrateTTSProvider: (provider: string) => provider,
  useTTS: () => ({ speak: vi.fn(), stopSpeaking: vi.fn(), isSpeaking: false }),
}));

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
