import type { Session } from '@/types';
import { getSessionKey } from '@/types';

export const PRIMARY_AGENT_SESSION_KEY = 'agent:jane-whitmore---ceo:main';
export const JANE_DIRECT_CHAT_SESSION_KEY = 'agent:jane-whitmore---ceo:imessage:direct:+447494722196';
export const LEGACY_MAIN_SESSION_KEY = 'agent:main:main';
const HEARTBEAT_SUFFIX = ':heartbeat';

const ROOT_AGENT_RE = /^agent:([^:]+):main$/;
const SUBAGENT_RE = /^((?:agent:[^:]+)):subagent:.+$/;
const CRON_RE = /^((?:agent:[^:]+)):cron:[^:]+$/;
const CRON_RUN_RE = /^(.+:cron:[^:]+):run:.+$/;
const DIRECT_RE = /^((?:agent:[^:]+))(?::[^:]+)*:direct:.+$/;
const CHANNEL_RE = /^((?:agent:[^:]+))(?::[^:]+)*:channel:.+$/;

export type SessionType = 'main' | 'subagent' | 'cron' | 'cron-run';

function slugifyPart(value: string): string {
  const trimmed = value.trim().toLowerCase();
  const slug = trimmed
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  return slug || 'agent';
}

/** Strip transient heartbeat suffixes so tree/grouping logic sees the stable session family. */
export function normalizeSessionKey(sessionKey: string): string {
  return sessionKey.endsWith(HEARTBEAT_SUFFIX)
    ? sessionKey.slice(0, -HEARTBEAT_SUFFIX.length)
    : sessionKey;
}

function isHeartbeatLabel(value?: string): boolean {
  return value?.trim().toLowerCase() === 'heartbeat';
}

export function getSessionType(sessionKey: string): SessionType {
  const normalized = normalizeSessionKey(sessionKey);
  if (CRON_RUN_RE.test(normalized)) return 'cron-run';
  if (CRON_RE.test(normalized)) return 'cron';
  if (SUBAGENT_RE.test(normalized)) return 'subagent';
  return 'main';
}

export function isTopLevelAgentSessionKey(sessionKey: string): boolean {
  return ROOT_AGENT_RE.test(normalizeSessionKey(sessionKey));
}

export function isSubagentSessionKey(sessionKey: string): boolean {
  return SUBAGENT_RE.test(normalizeSessionKey(sessionKey));
}

export function isCronSessionKey(sessionKey: string): boolean {
  return CRON_RE.test(normalizeSessionKey(sessionKey));
}

export function isCronRunSessionKey(sessionKey: string): boolean {
  return CRON_RUN_RE.test(normalizeSessionKey(sessionKey));
}

export function getRootAgentId(sessionKey: string): string | null {
  const normalized = normalizeSessionKey(sessionKey);
  const rootMatch = normalized.match(ROOT_AGENT_RE);
  if (rootMatch) return rootMatch[1];

  const subagentMatch = normalized.match(SUBAGENT_RE);
  if (subagentMatch) return subagentMatch[1].split(':')[1] ?? null;

  const cronMatch = normalized.match(CRON_RE);
  if (cronMatch) return cronMatch[1].split(':')[1] ?? null;

  const cronRunMatch = normalized.match(/^((?:agent:[^:]+)):cron:[^:]+:run:.+$/);
  if (cronRunMatch) return cronRunMatch[1].split(':')[1] ?? null;

  const directMatch = normalized.match(DIRECT_RE);
  if (directMatch) return directMatch[1].split(':')[1] ?? null;

  const channelMatch = normalized.match(CHANNEL_RE);
  if (channelMatch) return channelMatch[1].split(':')[1] ?? null;

  return null;
}

export function getRootAgentSessionKey(sessionKey: string): string | null {
  const rootId = getRootAgentId(sessionKey);
  return rootId ? `agent:${rootId}:main` : null;
}

function findSessionByFamilyKey(sessions: Session[], targetKey: string): Session | undefined {
  const normalizedTarget = normalizeSessionKey(targetKey);
  return sessions.find((session) => normalizeSessionKey(getSessionKey(session)) === normalizedTarget);
}

export function inferParentSessionKey(sessionKey: string): string | null {
  const normalized = normalizeSessionKey(sessionKey);
  const cronRunMatch = normalized.match(CRON_RUN_RE);
  if (cronRunMatch) return cronRunMatch[1];

  const subagentMatch = normalized.match(SUBAGENT_RE);
  if (subagentMatch) return `${subagentMatch[1]}:main`;

  const cronMatch = normalized.match(CRON_RE);
  if (cronMatch) return `${cronMatch[1]}:main`;

  const directMatch = normalized.match(DIRECT_RE);
  if (directMatch) return `${directMatch[1]}:main`;

  const channelMatch = normalized.match(CHANNEL_RE);
  if (channelMatch) return `${channelMatch[1]}:main`;

  return null;
}

export function resolveParentSessionKey(session: Session, knownKeys?: Set<string>): string | null {
  const sessionKey = getSessionKey(session);
  if (!sessionKey) return null;

  if (session.parentId) {
    if (!knownKeys || knownKeys.has(session.parentId)) return session.parentId;
  }

  const inferred = inferParentSessionKey(sessionKey);
  if (!inferred) return null;
  if (!knownKeys) return inferred;
  if (knownKeys.has(inferred)) return inferred;

  const normalized = normalizeSessionKey(inferred);
  for (const candidate of knownKeys) {
    if (normalizeSessionKey(candidate) === normalized) return candidate;
  }
  return null;
}

export function isSessionDescendantOf(sessionKey: string, ancestorKey: string): boolean {
  let current = inferParentSessionKey(normalizeSessionKey(sessionKey));
  const normalizedAncestor = normalizeSessionKey(ancestorKey);
  while (current) {
    if (normalizeSessionKey(current) === normalizedAncestor) return true;
    current = inferParentSessionKey(current);
  }
  return false;
}

export function isRootChildSession(sessionKey: string, rootSessionKey: string): boolean {
  return getRootAgentSessionKey(sessionKey) === normalizeSessionKey(rootSessionKey) && normalizeSessionKey(sessionKey) !== normalizeSessionKey(rootSessionKey);
}

export function getTopLevelAgentSessions(sessions: Session[]): Session[] {
  const families = new Map<string, Session>();
  const sortTime = (session: Session): number => {
    const candidates = [session.updatedAt, session.lastActivity];
    for (const value of candidates) {
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      if (typeof value === 'string') {
        const parsed = new Date(value).getTime();
        if (Number.isFinite(parsed)) return parsed;
      }
    }
    return 0;
  };

  for (const session of sessions) {
    const sessionKey = getSessionKey(session);
    if (!isTopLevelAgentSessionKey(sessionKey)) continue;

    const familyKey = normalizeSessionKey(sessionKey);
    const current = families.get(familyKey);
    if (!current) {
      families.set(familyKey, session);
      continue;
    }

    const currentKey = getSessionKey(current);
    const isExactCanonical = currentKey === familyKey;
    const nextIsExactCanonical = sessionKey === familyKey;
    if (isExactCanonical !== nextIsExactCanonical) {
      if (nextIsExactCanonical) families.set(familyKey, session);
      continue;
    }

    if (sortTime(session) > sortTime(current)) {
      families.set(familyKey, session);
    }
  }

  return [...families.values()].sort((a, b) => {
    const keyA = getSessionKey(a);
    const keyB = getSessionKey(b);
    if (keyA === PRIMARY_AGENT_SESSION_KEY) return -1;
    if (keyB === PRIMARY_AGENT_SESSION_KEY) return 1;
    if (keyA === LEGACY_MAIN_SESSION_KEY) return -1;
    if (keyB === LEGACY_MAIN_SESSION_KEY) return 1;

    const labelA = getSessionDisplayLabel(a).toLowerCase();
    const labelB = getSessionDisplayLabel(b).toLowerCase();
    return labelA.localeCompare(labelB);
  });
}

export function getSessionDisplayLabel(session: Session, agentName = 'Agent'): string {
  const sessionKey = getSessionKey(session);
  const normalizedKey = normalizeSessionKey(sessionKey);

  if (normalizedKey === PRIMARY_AGENT_SESSION_KEY || normalizedKey === LEGACY_MAIN_SESSION_KEY) {
    return `${agentName} (main)`;
  }

  if (session.label?.trim() && !isHeartbeatLabel(session.label)) return session.label.trim();
  if (session.displayName?.trim() && !isHeartbeatLabel(session.displayName)) return session.displayName.trim();

  if (isTopLevelAgentSessionKey(normalizedKey)) {
    const rootId = getRootAgentId(normalizedKey);
    if (rootId) return `Agent ${rootId}`;
  }

  if (isCronSessionKey(normalizedKey)) {
    return `Cron ${normalizedKey.split(':')[3]?.slice(0, 8) || ''}`.trim();
  }

  if (isCronRunSessionKey(normalizedKey)) {
    return `Run ${normalizedKey.split(':').pop()?.slice(0, 8) || ''}`.trim();
  }

  if (isSubagentSessionKey(normalizedKey)) {
    return `Subagent ${normalizedKey.split(':').pop()?.slice(0, 8) || ''}`.trim();
  }

  return normalizedKey.split(':').pop() || normalizedKey;
}

export function pickDefaultSessionKey(sessions: Session[], preferredKey?: string): string {
  const janeDirectChatSession = findSessionByFamilyKey(sessions, JANE_DIRECT_CHAT_SESSION_KEY);

  if (preferredKey) {
    const preferred = findSessionByFamilyKey(sessions, preferredKey);
    if (preferred) {
      const preferredRootId = getRootAgentId(preferredKey);
      const janeDirectRootId = getRootAgentId(JANE_DIRECT_CHAT_SESSION_KEY);
      if (
        janeDirectChatSession &&
        preferredRootId &&
        janeDirectRootId &&
        preferredRootId === janeDirectRootId
      ) {
        // Jane's direct iMessage thread is the operator-facing default.
        // If the current selection is any other Jane-family session, switch
        // back to the real direct thread so refreshes and sends stay on the
        // phone-backed conversation instead of a stale sibling row.
        return getSessionKey(janeDirectChatSession);
      }

      return getSessionKey(preferred);
    }

    // If the live list is still empty, keep the caller's preferred key so the
    // UI can stay on the last known good session instead of dropping to blank.
    // This is especially important for the Jane direct thread during startup,
    // where chat should remain usable even before the first sessions poll lands.
    if (sessions.length === 0) {
      return preferredKey;
    }
  }

  if (janeDirectChatSession) {
    // Jane is the operator-facing default chat thread, so prefer it before
    // falling back to the broader agent root list.
    return getSessionKey(janeDirectChatSession);
  }

  const topLevelAgents = getTopLevelAgentSessions(sessions);
  if (topLevelAgents.length > 0) {
    return getSessionKey(topLevelAgents[0]);
  }

  if (sessions.length > 0) {
    return getSessionKey(sessions[0]);
  }

  return JANE_DIRECT_CHAT_SESSION_KEY;
}

export function buildAgentRootSessionKey(
  name: string,
  existingKeys: Iterable<string>,
): string {
  const baseId = slugifyPart(name);
  const existing = new Set(existingKeys);

  let candidate = `agent:${baseId}:main`;
  if (!existing.has(candidate)) return candidate;

  let suffix = 2;
  while (existing.has(candidate)) {
    candidate = `agent:${baseId}-${suffix}:main`;
    suffix += 1;
  }

  return candidate;
}

export function getAgentRegistrationName(name: string, sessionKey: string): string {
  const agentId = getRootAgentId(sessionKey);
  const baseId = slugifyPart(name);

  if (!agentId || agentId === baseId) return name;

  const suffix = agentId.startsWith(`${baseId}-`) ? agentId.slice(baseId.length + 1) : '';
  if (/^\d+$/.test(suffix)) return `${name} ${suffix}`;

  return agentId;
}
