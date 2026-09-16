export const CODEX_REALTIME_VOICE_STORAGE_KEY = 'nerve:codex-realtime-voice';
export const CODEX_REALTIME_CONTEXT_DELIVERED_STORAGE_KEY = 'nerve:codex-realtime-context-delivered-v2';
export const CODEX_REALTIME_BOOTSTRAP_STORAGE_KEY = 'nerve:codex-realtime-bootstrap-v2';
export const CODEX_REALTIME_VOICES = [
  { value: 'sol', label: 'Sol' },
  { value: 'cove', label: 'Cove' },
  { value: 'ember', label: 'Ember' },
  { value: 'juniper', label: 'Juniper' },
] as const;

export type CodexRealtimeVoice = typeof CODEX_REALTIME_VOICES[number]['value'];

export interface CodexRealtimeApproval {
  id: string | number;
  method: 'item/commandExecution/requestApproval' | 'item/fileChange/requestApproval';
  params: Record<string, unknown>;
}

type ApprovalListener = (approval: CodexRealtimeApproval | null) => void;
const approvalListeners = new Set<ApprovalListener>();
let approvalResolver: ((id: string | number, decision: string) => void) | null = null;

export function subscribeCodexRealtimeApprovals(listener: ApprovalListener): () => void {
  approvalListeners.add(listener);
  return () => approvalListeners.delete(listener);
}

export function publishCodexRealtimeApproval(approval: CodexRealtimeApproval | null): void {
  approvalListeners.forEach((listener) => listener(approval));
}

export function setCodexRealtimeApprovalResolver(
  resolver: ((id: string | number, decision: string) => void) | null,
): void {
  approvalResolver = resolver;
}

export function resolveCodexRealtimeApproval(id: string | number, decision: string): void {
  if (!approvalResolver) throw new Error('GPT-Live approval connection is unavailable');
  approvalResolver(id, decision);
}

export function readCodexRealtimeVoice(): CodexRealtimeVoice {
  const saved = window.localStorage.getItem(CODEX_REALTIME_VOICE_STORAGE_KEY);
  return CODEX_REALTIME_VOICES.some(({ value }) => value === saved)
    ? saved as CodexRealtimeVoice
    : 'juniper';
}

export function saveCodexRealtimeVoice(voice: CodexRealtimeVoice): void {
  window.localStorage.setItem(CODEX_REALTIME_VOICE_STORAGE_KEY, voice);
}

function readStringArray(key: string): string[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export function readCodexRealtimeDeliveredContextIds(): string[] {
  return readStringArray(CODEX_REALTIME_CONTEXT_DELIVERED_STORAGE_KEY);
}

export function markCodexRealtimeContextDelivered(ids: string[]): void {
  if (ids.length === 0) return;
  const delivered = [...new Set([...readCodexRealtimeDeliveredContextIds(), ...ids])].slice(-64);
  try {
    window.localStorage.setItem(CODEX_REALTIME_CONTEXT_DELIVERED_STORAGE_KEY, JSON.stringify(delivered));
  } catch {
    // The next turn may resend a small bounded delta if storage is unavailable.
  }
}

export function isCodexRealtimeBootstrapDelivered(): boolean {
  try {
    return window.localStorage.getItem(CODEX_REALTIME_BOOTSTRAP_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function markCodexRealtimeBootstrapDelivered(): void {
  try {
    window.localStorage.setItem(CODEX_REALTIME_BOOTSTRAP_STORAGE_KEY, '1');
  } catch {
    // A repeated bootstrap after reload is safe if storage is unavailable.
  }
}

export function resetCodexRealtimeSessionSync(): void {
  try {
    window.localStorage.removeItem(CODEX_REALTIME_CONTEXT_DELIVERED_STORAGE_KEY);
    window.localStorage.removeItem(CODEX_REALTIME_BOOTSTRAP_STORAGE_KEY);
  } catch {
    // The fresh session still starts normally if storage is unavailable.
  }
}
