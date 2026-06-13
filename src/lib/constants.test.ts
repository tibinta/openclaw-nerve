import { describe, it, expect } from 'vitest';
import {
  DEFAULT_WAKE_PHRASES,
  WAKE_PHRASES,
  STOP_PHRASES,
  CANCEL_PHRASES,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  DEFAULT_CONTEXT_LIMIT,
  getContextLimit,
  CONTEXT_WARNING_THRESHOLD,
  CONTEXT_CRITICAL_THRESHOLD,
  CONTEXT_AUTO_COMPACT_THRESHOLD,
  buildWakePhrases,
  buildPrimaryWakePhrase,
  buildStopPhrasesRegex,
  WAKE_PREFIXES_BY_LANGUAGE,
} from './constants';

describe('Voice Control Phrases', () => {
  describe('buildWakePhrases', () => {
    it('should generate wake phrases for a given agent name', () => {
      const phrases = buildWakePhrases('Helena');
      expect(phrases).toContain('hey helena');
      expect(phrases).toContain('hey, helena');
    });

    it('should generate wake phrases for Kim (backwards compat)', () => {
      const phrases = buildWakePhrases('Kim');
      expect(phrases).toContain('hey kim');
      expect(phrases).toContain('hey, kim');
    });

    it('should all be lowercase', () => {
      const phrases = buildWakePhrases('TestAgent');
      phrases.forEach(phrase => {
        expect(phrase).toBe(phrase.toLowerCase());
      });
    });

    it('should all be non-empty strings', () => {
      const phrases = buildWakePhrases('Agent');
      phrases.forEach(phrase => {
        expect(typeof phrase).toBe('string');
        expect(phrase.length).toBeGreaterThan(0);
      });
    });

    it('should cover comma variations', () => {
      const phrases = buildWakePhrases('Nova');
      const withComma = phrases.filter(p => p.includes(','));
      const withoutComma = phrases.filter(p => !p.includes(','));
      
      expect(withComma.length).toBeGreaterThan(0);
      expect(withoutComma.length).toBeGreaterThan(0);
    });

    it('should handle empty agent name gracefully', () => {
      const phrases = buildWakePhrases('');
      expect(phrases).toContain('hey agent');
      expect(phrases).toContain('hey, agent');
      expect(phrases.every(p => p.length > 5)).toBe(true); // not just "hey "
    });

    it('should handle whitespace-only agent name', () => {
      const phrases = buildWakePhrases('   ');
      expect(phrases).toContain('hey agent');
    });

    it('should generate wake phrases for every mapped language', () => {
      Object.keys(WAKE_PREFIXES_BY_LANGUAGE).forEach((languageCode) => {
        const phrases = buildWakePhrases('Kim', languageCode);
        expect(phrases.length).toBeGreaterThan(0);
        // English fallback should always exist for backwards compatibility
        expect(phrases).toContain('hey kim');
      });
    });
  });

  describe('buildPrimaryWakePhrase', () => {
    it('should use language-specific default phrase', () => {
      expect(buildPrimaryWakePhrase('Kim', 'tr')).toBe('selam kim');
      expect(buildPrimaryWakePhrase('Kim', 'en')).toBe('hey kim');
    });

    it('should prefer custom wake phrase when provided', () => {
      expect(buildPrimaryWakePhrase('Kim', 'tr', ['merhaba kim'])).toBe('merhaba kim');
    });

    it('should ignore empty custom wake phrases', () => {
      expect(buildPrimaryWakePhrase('Kim', 'tr', ['   '])).toBe('selam kim');
    });
  });

  describe('DEFAULT_WAKE_PHRASES', () => {
    it('should use generic "agent" as the default name', () => {
      expect(DEFAULT_WAKE_PHRASES).toContain('hey agent');
      expect(DEFAULT_WAKE_PHRASES).toContain('hey, agent');
    });

    it('should be the same reference as the deprecated WAKE_PHRASES', () => {
      expect(WAKE_PHRASES).toBe(DEFAULT_WAKE_PHRASES);
    });
  });

  describe('buildStopPhrasesRegex', () => {
    it('should match standard stop phrases', () => {
      const regex = buildStopPhrasesRegex('Helena');
      expect(regex.test('boom')).toBe(true);
      expect(regex.test("that's it")).toBe(true);
      expect(regex.test("i'm done")).toBe(true);
      expect(regex.test('send it')).toBe(true);
    });

    it('should match the agent wake phrase as a stop trigger', () => {
      const regex = buildStopPhrasesRegex('Helena');
      expect(regex.test('hey helena')).toBe(true);
      
      const kimRegex = buildStopPhrasesRegex('Kim');
      expect(kimRegex.test('hey kim')).toBe(true);
    });

    it('should not match random text', () => {
      const regex = buildStopPhrasesRegex('Helena');
      expect(regex.test('hello world')).toBe(false);
      expect(regex.test('this is a test')).toBe(false);
    });

    it('should avoid Latin false positives inside larger words', () => {
      const regex = buildStopPhrasesRegex('Kim', {
        stopPhrases: ['done'],
        cancelPhrases: [],
        wakePhrases: [],
      });

      expect('undone'.replace(regex, '').trim()).toBe('undone');
      expect('all done'.replace(regex, '').trim()).toBe('all');
    });

    it('should handle empty agent name gracefully', () => {
      const regex = buildStopPhrasesRegex('');
      expect(regex.test('hey agent')).toBe(true);
      expect(() => regex.test('test')).not.toThrow();
    });

    it('should escape special regex characters in agent name', () => {
      // Should not throw on special chars
      const regex = buildStopPhrasesRegex('Agent.2');
      expect(() => regex.test('test')).not.toThrow();
      // Dot should be literal, not wildcard
      expect(regex.test('hey agent.2')).toBe(true);
      expect(regex.test('hey agentX2')).toBe(false); // dot shouldn't match X
    });

    it('should strip non-Latin stop phrases at the end of text', () => {
      const regex = buildStopPhrasesRegex('Kim', {
        stopPhrases: ['отправь'],
        cancelPhrases: [],
        wakePhrases: [],
      });

      const cleaned = 'напомни мне завтра отправь'.replace(regex, '').trim();
      expect(cleaned).toBe('напомни мне завтра');
    });

    it('should strip CJK stop phrases even without whitespace boundaries', () => {
      const regex = buildStopPhrasesRegex('Kim', {
        stopPhrases: ['发送'],
        cancelPhrases: [],
        wakePhrases: [],
      });

      const cleaned = '请帮我写邮件发送'.replace(regex, '').trim();
      expect(cleaned).toBe('请帮我写邮件');
    });
  });

  describe('STOP_PHRASES', () => {
    it('should contain expected stop phrases', () => {
      expect(STOP_PHRASES).toContain('boom');
      expect(STOP_PHRASES).toContain("i'm done");
      expect(STOP_PHRASES).toContain('im done');
      expect(STOP_PHRASES).toContain("that's it");
      expect(STOP_PHRASES).toContain('send it');
      expect(STOP_PHRASES).toContain('done');
    });

    it('should all be lowercase', () => {
      STOP_PHRASES.forEach(phrase => {
        expect(phrase).toBe(phrase.toLowerCase());
      });
    });

    it('should all be non-empty strings', () => {
      STOP_PHRASES.forEach(phrase => {
        expect(typeof phrase).toBe('string');
        expect(phrase.length).toBeGreaterThan(0);
      });
    });

    it('should cover contraction variations', () => {
      // Both "i'm done" and "im done" for speech recognition variance
      const withApostrophe = STOP_PHRASES.filter(p => p.includes("'"));
      const similarWithout = STOP_PHRASES.filter(p => 
        p === 'im done' || p === 'thats it' || p === 'alright im done'
      );
      
      expect(withApostrophe.length).toBeGreaterThan(0);
      expect(similarWithout.length).toBeGreaterThan(0);
    });

    it('should include short and long phrases', () => {
      const shortPhrases = STOP_PHRASES.filter(p => p.split(' ').length <= 2);
      const longPhrases = STOP_PHRASES.filter(p => p.split(' ').length > 2);
      
      expect(shortPhrases.length).toBeGreaterThan(0);
      expect(longPhrases.length).toBeGreaterThan(0);
    });
  });

  describe('CANCEL_PHRASES', () => {
    it('should contain expected cancel phrases', () => {
      expect(CANCEL_PHRASES).toContain('cancel');
      expect(CANCEL_PHRASES).toContain('never mind');
      expect(CANCEL_PHRASES).toContain('nevermind');
    });

    it('should all be lowercase', () => {
      CANCEL_PHRASES.forEach(phrase => {
        expect(phrase).toBe(phrase.toLowerCase());
      });
    });

    it('should all be non-empty strings', () => {
      CANCEL_PHRASES.forEach(phrase => {
        expect(typeof phrase).toBe('string');
        expect(phrase.length).toBeGreaterThan(0);
      });
    });

    it('should cover spacing variations (never mind / nevermind)', () => {
      const withSpace = CANCEL_PHRASES.filter(p => p === 'never mind');
      const withoutSpace = CANCEL_PHRASES.filter(p => p === 'nevermind');
      
      expect(withSpace.length).toBe(1);
      expect(withoutSpace.length).toBe(1);
    });
  });

  describe('Phrase Uniqueness', () => {
    it('should have unique wake phrases', () => {
      const unique = new Set(DEFAULT_WAKE_PHRASES);
      expect(unique.size).toBe(DEFAULT_WAKE_PHRASES.length);
    });

    it('should have unique stop phrases', () => {
      const unique = new Set(STOP_PHRASES);
      expect(unique.size).toBe(STOP_PHRASES.length);
    });

    it('should have unique cancel phrases', () => {
      const unique = new Set(CANCEL_PHRASES);
      expect(unique.size).toBe(CANCEL_PHRASES.length);
    });

    it('should not have overlapping phrases between categories', () => {
      // No phrase should be in multiple categories
      const allPhrases = [...DEFAULT_WAKE_PHRASES, ...STOP_PHRASES, ...CANCEL_PHRASES];
      const uniqueTotal = new Set(allPhrases);
      
      expect(uniqueTotal.size).toBe(allPhrases.length);
    });
  });
});

describe('Attachment Limits', () => {
  describe('MAX_ATTACHMENTS', () => {
    it('should be a positive integer', () => {
      expect(Number.isInteger(MAX_ATTACHMENTS)).toBe(true);
      expect(MAX_ATTACHMENTS).toBeGreaterThan(0);
    });

    it('should be 4', () => {
      expect(MAX_ATTACHMENTS).toBe(4);
    });
  });

  describe('MAX_ATTACHMENT_BYTES', () => {
    it('should be a positive integer', () => {
      expect(Number.isInteger(MAX_ATTACHMENT_BYTES)).toBe(true);
      expect(MAX_ATTACHMENT_BYTES).toBeGreaterThan(0);
    });

    it('should be 4MB', () => {
      expect(MAX_ATTACHMENT_BYTES).toBe(4 * 1024 * 1024);
    });
  });
});

describe('Model Context Limits', () => {
  describe('DEFAULT_CONTEXT_LIMIT', () => {
    it('should be 200k', () => {
      expect(DEFAULT_CONTEXT_LIMIT).toBe(200000);
    });
  });

  describe('getContextLimit', () => {
    it('should return default for any model (gateway provides actual limits)', () => {
      expect(getContextLimit('claude-sonnet-4-5')).toBe(200000);
      expect(getContextLimit('gpt-4')).toBe(200000);
      expect(getContextLimit('unknown-model')).toBe(200000);
    });

    it('should handle empty string', () => {
      expect(getContextLimit('')).toBe(200000);
    });
  });
});

describe('Context Thresholds', () => {
  describe('CONTEXT_AUTO_COMPACT_THRESHOLD', () => {
    it('keeps 30 percent context headroom', () => {
      expect(CONTEXT_AUTO_COMPACT_THRESHOLD).toBe(70);
    });
  });

  describe('CONTEXT_WARNING_THRESHOLD', () => {
    it('should be 75%', () => {
      expect(CONTEXT_WARNING_THRESHOLD).toBe(75);
    });

    it('should be less than critical threshold', () => {
      expect(CONTEXT_WARNING_THRESHOLD).toBeLessThan(CONTEXT_CRITICAL_THRESHOLD);
    });
  });

  describe('CONTEXT_CRITICAL_THRESHOLD', () => {
    it('should be 90%', () => {
      expect(CONTEXT_CRITICAL_THRESHOLD).toBe(90);
    });

    it('should be less than 100%', () => {
      expect(CONTEXT_CRITICAL_THRESHOLD).toBeLessThan(100);
    });
  });
});
