import { describe, it, expect } from 'vitest';
import { normalizeVoiceTranscript } from './voiceTranscript';

describe('normalizeVoiceTranscript', () => {
  it.each([
    '',
    '   ',
    '[BLANK_AUDIO]',
    '[NO_SPEECH]',
    '[SILENCE]',
    '[blank audio]',
    '[no speech]',
    'blank audio',
    'no speech',
    'blank_audio',
    'no-speech',
    'NO_SPEECH',
    'NO SPEECH',
    'SILENCE',
  ])('normalizes "%s" to empty', (input) => {
    expect(normalizeVoiceTranscript(input)).toBe('');
  });

  it('keeps real speech intact', () => {
    expect(normalizeVoiceTranscript('no speech please')).toBe('no speech please');
    expect(normalizeVoiceTranscript('hello world')).toBe('hello world');
  });
});
