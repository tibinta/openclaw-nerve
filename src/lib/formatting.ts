/** Escape HTML special characters to prevent XSS in interpolated strings. */
export function esc(s: string | null | undefined): string {
  if (!s) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Format a timestamp as a human-readable relative time (e.g. "5m", "2h", "3d"). */
export function timeAgo(ts: string | number | Date): string {
  const diff = (Date.now() - new Date(ts).getTime()) / 1000;
  if (diff < 60) return 'now';
  if (diff < 3600) return Math.floor(diff / 60) + 'm';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h';
  return Math.floor(diff / 86400) + 'd';
}

function parseDateLike(value: string | number | Date): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === 'number') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const trimmed = value.trim();
  if (!trimmed) return null;

  if (/^-?\d+$/.test(trimmed)) {
    const parsed = new Date(Number(trimmed));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Format a timestamp for UI display while tolerating legacy string values.
 * If parsing fails, return the original value so the UI never shows "Invalid Date".
 */
export function formatDateTime(value: string | number | Date | null | undefined, fallback = '—'): string {
  if (value == null || value === '') return fallback;
  const parsed = parseDateLike(value);
  if (parsed) return parsed.toLocaleString();
  return typeof value === 'string' ? value : fallback;
}

/** Format a token count with SI suffixes (K, M, B). */
export function fmtTokens(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

/** Format a dollar cost to two decimal places (e.g. "$1.23"). */
export function fmtCost(n: number): string {
  return '$' + n.toFixed(2);
}

/** Format a number with "k" suffix for thousands (e.g. 1500 → "2k"). */
export function fmtK(n: number): string {
  return n >= 1000 ? (n / 1000).toFixed(0) + 'k' : String(n);
}

/** Decode common HTML entities back to their literal characters. */
export function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}
