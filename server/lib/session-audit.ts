/**
 * Shared session audit helpers.
 *
 * The helper keeps a short source window, classifies repeated identical
 * failures, and marks stale child sessions so pollers can stop instead of
 * rescheduling forever.
 */

export const SESSION_AUDIT_WINDOW_MS = 3 * 60 * 60 * 1000;

export type SessionAuditSourceKind = 'store' | 'transcript' | 'gateway' | 'poll';

export interface SessionAuditObservation {
  sessionKey: string;
  source: SessionAuditSourceKind;
  updatedAt: number;
  label?: string;
  displayName?: string;
  status?: string;
  error?: string;
  detail?: string;
  pinned?: boolean;
  waiting?: boolean;
  childSessionKey?: string;
  runId?: string;
  sessionId?: string;
}

export type SessionAuditBlocker =
  | {
      type: 'repeated_identical_failure';
      message: string;
      signature: string;
      count: number;
      firstSeenAt: number;
      lastSeenAt: number;
    }
  | {
      type: 'stale_child_session';
      message: string;
      lastSeenAt: number;
      ageMs: number;
    }
  | {
      type: 'pinned_waiting';
      message: string;
      lastSeenAt: number;
    };

export interface SessionAuditSummary extends SessionAuditObservation {
  sources: SessionAuditObservation[];
  blocker: SessionAuditBlocker | null;
}

function normalizeText(value?: string): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeLowerText(value?: string): string {
  return normalizeText(value).toLowerCase();
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isTerminalState(status?: string): boolean {
  const normalized = normalizeLowerText(status);
  return normalized === 'done'
    || normalized === 'error'
    || normalized === 'failed'
    || normalized === 'aborted'
    || normalized === 'cancelled'
    || normalized === 'complete'
    || normalized === 'completed';
}

export function buildSessionAuditFailureSignature(observation: Pick<SessionAuditObservation, 'status' | 'error' | 'detail' | 'label' | 'childSessionKey' | 'runId'>): string {
  const pieces = [
    normalizeLowerText(observation.status),
    normalizeLowerText(observation.error || observation.detail),
    normalizeLowerText(observation.label),
    normalizeLowerText(observation.childSessionKey),
    normalizeLowerText(observation.runId),
  ].filter(Boolean);

  return pieces.join('|') || 'unknown-failure';
}

function getRelevantUpdatedAt(observation: SessionAuditObservation): number {
  return isFiniteNumber(observation.updatedAt) ? observation.updatedAt : 0;
}

function sortNewestFirst(a: SessionAuditObservation, b: SessionAuditObservation): number {
  return getRelevantUpdatedAt(b) - getRelevantUpdatedAt(a);
}

function getLatestObservation(observations: SessionAuditObservation[]): SessionAuditObservation | null {
  if (observations.length === 0) return null;
  return [...observations].sort(sortNewestFirst)[0] ?? null;
}

export function classifySessionAuditBlocker(
  observations: SessionAuditObservation[],
  options: { now?: number; windowMs?: number } = {},
): SessionAuditBlocker | null {
  if (observations.length === 0) return null;

  const now = options.now ?? Date.now();
  const windowMs = options.windowMs ?? SESSION_AUDIT_WINDOW_MS;
  const latest = getLatestObservation(observations);
  if (!latest) return null;

  if (latest.pinned && latest.waiting) {
    return null;
  }

  const failureGroups = new Map<string, SessionAuditObservation[]>();
  for (const observation of observations) {
    const status = normalizeLowerText(observation.status);
    const hasFailureSignal = status === 'error'
      || status === 'failed'
      || Boolean(normalizeText(observation.error));
    if (!hasFailureSignal) continue;

    const signature = buildSessionAuditFailureSignature(observation);
    const group = failureGroups.get(signature);
    if (group) {
      group.push(observation);
    } else {
      failureGroups.set(signature, [observation]);
    }
  }

  let repeatedFailure: { signature: string; count: number; firstSeenAt: number; lastSeenAt: number } | null = null;
  for (const [signature, group] of failureGroups) {
    if (group.length < 2) continue;
    const firstSeenAt = Math.min(...group.map(getRelevantUpdatedAt));
    const lastSeenAt = Math.max(...group.map(getRelevantUpdatedAt));
    if (!repeatedFailure || group.length > repeatedFailure.count || (group.length === repeatedFailure.count && lastSeenAt > repeatedFailure.lastSeenAt)) {
      repeatedFailure = { signature, count: group.length, firstSeenAt, lastSeenAt };
    }
  }

  if (repeatedFailure) {
    return {
      type: 'repeated_identical_failure',
      message: `Repeated identical failure: ${repeatedFailure.signature}`,
      signature: repeatedFailure.signature,
      count: repeatedFailure.count,
      firstSeenAt: repeatedFailure.firstSeenAt,
      lastSeenAt: repeatedFailure.lastSeenAt,
    };
  }

  const ageMs = now - getRelevantUpdatedAt(latest);
  if (ageMs >= windowMs && !isTerminalState(latest.status)) {
    return {
      type: 'stale_child_session',
      message: `stale child session: no new activity for ${Math.round(ageMs / 1000)}s`,
      lastSeenAt: getRelevantUpdatedAt(latest),
      ageMs,
    };
  }

  if (latest.waiting && !latest.pinned) {
    return {
      type: 'stale_child_session',
      message: 'waiting session is stale and not pinned',
      lastSeenAt: getRelevantUpdatedAt(latest),
      ageMs,
    };
  }

  return null;
}

export function aggregateSessionAudit(
  observations: SessionAuditObservation[],
  options: { now?: number; windowMs?: number } = {},
): SessionAuditSummary[] {
  if (observations.length === 0) return [];

  const now = options.now ?? Date.now();
  const windowMs = options.windowMs ?? SESSION_AUDIT_WINDOW_MS;
  const cutoff = now - windowMs;
  const grouped = new Map<string, SessionAuditObservation[]>();

  for (const observation of observations) {
    if (!observation.sessionKey || !isFiniteNumber(observation.updatedAt)) continue;
    const next = grouped.get(observation.sessionKey);
    if (next) {
      next.push(observation);
    } else {
      grouped.set(observation.sessionKey, [observation]);
    }
  }

  return [...grouped.entries()]
    .map(([sessionKey, group]) => {
      const ordered = [...group].sort(sortNewestFirst);
      const latest = ordered[0];
      const sources = ordered.filter((observation) => observation.updatedAt >= cutoff);
      const blocker = classifySessionAuditBlocker(ordered, { now, windowMs });

      return {
        ...latest,
        sessionKey,
        sources: sources.sort(sortNewestFirst),
        blocker,
      };
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}
