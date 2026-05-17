const NO_SPEECH_PLACEHOLDERS = new Set([
  'BLANKAUDIO',
  'NOSPEECH',
  'NOAUDIO',
  'NOSOUND',
  'NOVOICE',
  'SILENCE',
  'SILENT',
]);

const PLACEHOLDER_WRAPPER_RE = /^[\s"'`([{<]+(.+?)[\s"'`)\]}>]+$/u;

function normalizeSurface(text: string): string {
  return (text || '')
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim();
}

function unwrapPlaceholder(text: string): { candidate: string; wrapped: boolean } {
  const match = text.match(PLACEHOLDER_WRAPPER_RE);
  if (!match) return { candidate: text, wrapped: false };
  return { candidate: match[1].trim(), wrapped: true };
}

/**
 * Collapse STT no-speech sentinels into empty text so callers can recover cleanly.
 */
export function normalizeVoiceTranscript(text: string): string {
  const surface = normalizeSurface(text);
  if (!surface) return '';

  const { candidate, wrapped } = unwrapPlaceholder(surface);
  const compact = candidate.replace(/[\s_-]+/g, '').toUpperCase();
  if (!NO_SPEECH_PLACEHOLDERS.has(compact)) return surface;

  if (wrapped || candidate === candidate.toUpperCase() || /[_-]/.test(candidate)) return '';

  return surface;
}
