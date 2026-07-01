/** Tests for the local Holler TTS provider service. */
import { describe, expect, it } from 'vitest';

import { getHollerSynthesisTimeoutMs } from './holler-tts.js';

describe('getHollerSynthesisTimeoutMs', () => {
  it('allows long Nerve speech lines to finish instead of aborting at 15s', () => {
    expect(getHollerSynthesisTimeoutMs('Short line.')).toBeGreaterThanOrEqual(30_000);
    expect(getHollerSynthesisTimeoutMs('x'.repeat(300))).toBeGreaterThan(45_000);
    expect(getHollerSynthesisTimeoutMs('x'.repeat(2_000))).toBe(90_000);
  });
});
