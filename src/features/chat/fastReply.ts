const FAST_REPLY_KEY_PREFIX = 'oc-fast-reply';

function getFastReplyKey(sessionKey?: string | null): string {
  return sessionKey ? `${FAST_REPLY_KEY_PREFIX}-${sessionKey}` : `${FAST_REPLY_KEY_PREFIX}-default`;
}

export function readFastReplyMode(sessionKey?: string | null): boolean {
  try {
    if (typeof localStorage === 'undefined') return false;
    return localStorage.getItem(getFastReplyKey(sessionKey)) === 'true';
  } catch {
    return false;
  }
}

export function writeFastReplyMode(sessionKey: string | null | undefined, enabled: boolean): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(getFastReplyKey(sessionKey), enabled ? 'true' : 'false');
  } catch {
    // Storage is best-effort; the live sessions.patch still carries the setting.
  }
}
