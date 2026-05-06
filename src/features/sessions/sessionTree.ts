import type { Session } from '@/types';
import { getSessionKey } from '@/types';
import {
  humanizeAgentFamilyId,
  isDirectSessionKey,
  getSessionType,
  getRootAgentId,
  normalizeSessionKey,
  resolveParentSessionKey,
  isTopLevelAgentSessionKey,
} from './sessionKeys';

export interface TreeNode {
  session: Session;
  key: string;
  /** Actual session key to activate when this node is selected. */
  selectKey?: string;
  /** Family identity for synthetic agent rows. */
  familyId?: string | null;
  /** Human-readable label for synthetic rows. */
  displayLabel?: string;
  /** Distinguishes synthetic family rows from live session rows. */
  kind?: 'family' | 'session';
  parentId: string | null;
  depth: number;
  children: TreeNode[];
  isExpanded: boolean;
}

export interface AgentRegistryEntry {
  id: string;
  name?: string;
  identityName?: string;
  label?: string;
}

export { getSessionType } from './sessionKeys';

/** True only for real top-level agent roots that belong in the AGENTS sidebar. */
export function isAgentSidebarRootSessionKey(sessionKey: string): boolean {
  return isTopLevelAgentSessionKey(sessionKey);
}

function getSessionSortTime(session: Session | undefined): number {
  if (!session) return 0;
  const candidates = [session.updatedAt, session.lastActivity];
  for (const value of candidates) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const parsed = new Date(value).getTime();
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return 0;
}

function pickRepresentativeSession(familyKey: string, members: Session[]): Session {
  const exact = members.find((session) => getSessionKey(session) === familyKey);
  if (exact) return exact;

  return members.reduce((best, candidate) => (
    getSessionSortTime(candidate) > getSessionSortTime(best) ? candidate : best
  ));
}

function buildFamilyRepresentatives(sessions: Session[]): Map<string, Session> {
  const families = new Map<string, Session[]>();
  for (const session of sessions) {
    const familyKey = normalizeSessionKey(getSessionKey(session));
    const list = families.get(familyKey);
    if (list) {
      list.push(session);
    } else {
      families.set(familyKey, [session]);
    }
  }

  const representatives = new Map<string, Session>();
  for (const [familyKey, members] of families) {
    representatives.set(familyKey, pickRepresentativeSession(familyKey, members));
  }
  return representatives;
}

function inferParentFamilyKey(familyKey: string): string | null {
  const cronRunMatch = familyKey.match(/^(.+:cron:[^:]+):run:.+$/);
  if (cronRunMatch) return cronRunMatch[1];

  const subagentMatch = familyKey.match(/^((?:agent:[^:]+)):subagent:.+$/);
  if (subagentMatch) return `${subagentMatch[1]}:main`;

  const cronMatch = familyKey.match(/^((?:agent:[^:]+)):cron:[^:]+$/);
  if (cronMatch) return `${cronMatch[1]}:main`;

  const directMatch = familyKey.match(/^((?:agent:[^:]+))(?::[^:]+)*:direct:.+$/);
  if (directMatch) return `${directMatch[1]}:main`;

  const channelMatch = familyKey.match(/^((?:agent:[^:]+))(?::[^:]+)*:channel:.+$/);
  if (channelMatch) return `${channelMatch[1]}:main`;

  return null;
}

function buildParentMap(representatives: Map<string, Session>): Map<string, string | null> {
  const parentMap = new Map<string, string | null>();
  const representativesByRawKey = new Map<string, Session>();
  for (const session of representatives.values()) {
    representativesByRawKey.set(getSessionKey(session), session);
  }

  for (const [familyKey, session] of representatives) {
    const rawKey = getSessionKey(session);
    const explicitParent = session.parentId?.trim();
    if (explicitParent) {
      const parentRepresentative = representativesByRawKey.get(explicitParent)
        || [...representativesByRawKey.entries()].find(([, candidate]) => normalizeSessionKey(getSessionKey(candidate)) === normalizeSessionKey(explicitParent))?.[1];

      if (parentRepresentative) {
        parentMap.set(rawKey, getSessionKey(parentRepresentative));
        continue;
      }
    }

    const inferredParentFamily = inferParentFamilyKey(familyKey);

    if (!inferredParentFamily) {
      parentMap.set(getSessionKey(session), null);
      continue;
    }

    const parentRepresentative = representatives.get(inferredParentFamily);
    parentMap.set(getSessionKey(session), parentRepresentative ? getSessionKey(parentRepresentative) : null);
  }

  return parentMap;
}

function buildTreeNodes(
  renderSessions: Session[],
  parentMap: Map<string, string | null>,
): TreeNode[] {
  if (renderSessions.length === 0) return [];

  const sessionsByKey = new Map<string, Session>();
  const childrenOf = new Map<string | null, Session[]>();
  for (const session of renderSessions) {
    const sessionKey = getSessionKey(session);
    sessionsByKey.set(sessionKey, session);
    const parentKey = parentMap.get(sessionKey) ?? null;
    const list = childrenOf.get(parentKey);
    if (list) {
      list.push(session);
    } else {
      childrenOf.set(parentKey, [session]);
    }
  }

  const typeOrder = { main: 0, subagent: 1, cron: 2, 'cron-run': 3 };
  const familySortTimeMemo = new Map<string, number>();
  const familySortTimeStack = new Set<string>();

  const getFamilySortTime = (sessionKey: string): number => {
    const cached = familySortTimeMemo.get(sessionKey);
    if (cached !== undefined) return cached;
    if (familySortTimeStack.has(sessionKey)) {
      return getSessionSortTime(sessionsByKey.get(sessionKey));
    }

    familySortTimeStack.add(sessionKey);
    let maxTime = getSessionSortTime(sessionsByKey.get(sessionKey));
    const children = childrenOf.get(sessionKey) ?? [];
    for (const child of children) {
      maxTime = Math.max(maxTime, getFamilySortTime(getSessionKey(child)));
    }
    familySortTimeStack.delete(sessionKey);
    familySortTimeMemo.set(sessionKey, maxTime);
    return maxTime;
  };

  function buildNodes(parentKey: string | null, depth: number): TreeNode[] {
    const children = childrenOf.get(parentKey);
    if (!children) return [];

    const sorted = [...children].sort((a, b) => {
      const keyA = getSessionKey(a);
      const keyB = getSessionKey(b);

      if (parentKey === null) {
        const familyTimeA = getFamilySortTime(keyA);
        const familyTimeB = getFamilySortTime(keyB);
        if (familyTimeA !== familyTimeB) return familyTimeB - familyTimeA;
      }

      const timeA = getSessionSortTime(a);
      const timeB = getSessionSortTime(b);
      if (timeA !== timeB) return timeB - timeA;

      if (parentKey === null) {
        const isAgentRootA = isTopLevelAgentSessionKey(keyA);
        const isAgentRootB = isTopLevelAgentSessionKey(keyB);
        if (isAgentRootA !== isAgentRootB) return isAgentRootA ? -1 : 1;
      }

      const ta = typeOrder[getSessionType(keyA)] ?? 9;
      const tb = typeOrder[getSessionType(keyB)] ?? 9;
      if (ta !== tb) return ta - tb;

      const labelA = (a.displayName || a.label || keyA).toLowerCase();
      const labelB = (b.displayName || b.label || keyB).toLowerCase();
      return labelA.localeCompare(labelB);
    });

    return sorted.map((session) => {
      const sessionKey = getSessionKey(session);
      return {
        session,
        key: sessionKey,
        selectKey: sessionKey,
        kind: 'session',
        parentId: parentKey,
        depth,
        children: buildNodes(sessionKey, depth + 1),
        isExpanded: true,
      };
    });
  }

  return buildNodes(null, 0);
}

function getSessionFamilyId(
  session: Session,
  sessionsByKey: Map<string, Session>,
  normalizedSessionsByKey: Map<string, Session>,
  knownKeys: Set<string>,
  cache: Map<string, string | null>,
  activeStack: Set<string>,
): string | null {
  const sessionKey = getSessionKey(session);
  if (!sessionKey) return null;

  const normalizedKey = normalizeSessionKey(sessionKey);
  const cached = cache.get(normalizedKey);
  if (cached !== undefined) return cached;

  const directRootId = getRootAgentId(normalizedKey);
  if (directRootId) {
    cache.set(normalizedKey, directRootId);
    return directRootId;
  }

  if (activeStack.has(normalizedKey)) {
    cache.set(normalizedKey, null);
    return null;
  }

  activeStack.add(normalizedKey);

  const parentKey = resolveParentSessionKey(session, knownKeys);
  if (parentKey) {
    const parentSession = sessionsByKey.get(parentKey) || normalizedSessionsByKey.get(normalizeSessionKey(parentKey));
    if (parentSession) {
      const parentFamilyId = getSessionFamilyId(
        parentSession,
        sessionsByKey,
        normalizedSessionsByKey,
        knownKeys,
        cache,
        activeStack,
      );
      if (parentFamilyId) {
        cache.set(normalizedKey, parentFamilyId);
        activeStack.delete(normalizedKey);
        return parentFamilyId;
      }
    }
  }

  activeStack.delete(normalizedKey);
  cache.set(normalizedKey, null);
  return null;
}

function pickFamilySelectionKey(familyId: string, members: Session[]): string {
  const janeFamilyId = getRootAgentId('agent:jane-whitmore---ceo:main');
  if (familyId === janeFamilyId) {
    const janeDirect = members.find((session) => getSessionKey(session) === 'agent:jane-whitmore---ceo:imessage:direct:+447494722196');
    if (janeDirect) return getSessionKey(janeDirect);
  }

  const canonicalRootKey = `agent:${familyId}:main`;
  const exactRoot = members.find((session) => normalizeSessionKey(getSessionKey(session)) === canonicalRootKey);
  if (exactRoot) return getSessionKey(exactRoot);

  const directSession = members.find((session) => isDirectSessionKey(getSessionKey(session)));
  if (directSession) return getSessionKey(directSession);

  return getSessionKey(pickRepresentativeSession(canonicalRootKey, members));
}

function resolveFamilyLabel(familyId: string, members: Session[], agents: AgentRegistryEntry[]): string {
  const registryEntry = agents.find((agent) => agent.id.trim() === familyId.trim());
  const registryLabel = registryEntry?.identityName?.trim() || registryEntry?.name?.trim() || registryEntry?.label?.trim();
  if (registryLabel) return registryLabel;

  const exactRoot = members.find((session) => normalizeSessionKey(getSessionKey(session)) === `agent:${familyId}:main`);
  if (exactRoot?.displayName?.trim()) return exactRoot.displayName.trim();
  if (exactRoot?.label?.trim() && exactRoot.label.trim().toLowerCase() !== 'heartbeat') return exactRoot.label.trim();

  return humanizeAgentFamilyId(familyId);
}

function pickFamilySummarySession(members: Session[]): Session {
  return members.reduce((best, candidate) => (
    getSessionSortTime(candidate) > getSessionSortTime(best) ? candidate : best
  ));
}

/**
 * Build a hierarchical tree from a flat list of sessions.
 *
 * Dual strategy:
 * 1. If sessions have `parentId` (gateway v2026.2.9+), use that.
 * 2. Fallback: parse session key structure to infer parent-child relationships.
 *
 * Returns an array of root-level TreeNodes (usually just one).
 */
export function buildSessionTree(sessions: Session[]): TreeNode[] {
  const representatives = buildFamilyRepresentatives(sessions);
  const parentMap = buildParentMap(representatives);
  return buildTreeNodes([...representatives.values()], parentMap);
}

/** Build the AGENTS sidebar tree, limited to real agent roots and their descendants. */
export function buildAgentSidebarTree(sessions: Session[], agents: AgentRegistryEntry[] = []): TreeNode[] {
  if (sessions.length === 0) return [];

  const sessionsByKey = new Map<string, Session>();
  const normalizedSessionsByKey = new Map<string, Session>();
  const knownKeys = new Set<string>();
  for (const session of sessions) {
    const key = getSessionKey(session);
    if (!key) continue;
    sessionsByKey.set(key, session);
    normalizedSessionsByKey.set(normalizeSessionKey(key), session);
    knownKeys.add(key);
  }

  const familyCache = new Map<string, string | null>();
  const familyGroups = new Map<string, Session[]>();
  for (const session of sessions) {
    const familyId = getSessionFamilyId(
      session,
      sessionsByKey,
      normalizedSessionsByKey,
      knownKeys,
      familyCache,
      new Set<string>(),
    );

    if (!familyId) continue;

    const list = familyGroups.get(familyId);
    if (list) {
      list.push(session);
    } else {
      familyGroups.set(familyId, [session]);
    }
  }

  const familyNodes: Array<TreeNode & { _sortTime: number }> = [...familyGroups.entries()].map(([familyId, members]) => {
    const summarySession = pickFamilySummarySession(members);
    const summaryTime = getSessionSortTime(summarySession);
    const familyLabel = resolveFamilyLabel(familyId, members, agents);
    const selectKey = pickFamilySelectionKey(familyId, members);
    const wrapperSession: Session = {
      ...summarySession,
      sessionKey: `family:${familyId}`,
      key: `family:${familyId}`,
      label: familyLabel,
      displayName: familyLabel,
      updatedAt: summaryTime,
      lastActivity: summarySession.lastActivity ?? summaryTime,
    };

    const childNodes = [...members]
      .sort((a, b) => {
        const timeA = getSessionSortTime(a);
        const timeB = getSessionSortTime(b);
        if (timeA !== timeB) return timeB - timeA;

        const typeA = getSessionType(getSessionKey(a));
        const typeB = getSessionType(getSessionKey(b));
        const typeOrder = { main: 0, subagent: 1, cron: 2, 'cron-run': 3 };
        const orderA = typeOrder[typeA] ?? 9;
        const orderB = typeOrder[typeB] ?? 9;
        if (orderA !== orderB) return orderA - orderB;

        const labelA = (a.displayName || a.label || getSessionKey(a)).toLowerCase();
        const labelB = (b.displayName || b.label || getSessionKey(b)).toLowerCase();
        return labelA.localeCompare(labelB);
      })
      .map((session): TreeNode => {
        const sessionKey = getSessionKey(session);
        return {
          session,
          key: sessionKey,
          selectKey: sessionKey,
          familyId,
          parentId: `family:${familyId}`,
          depth: 1,
          children: [],
          isExpanded: true,
          kind: 'session',
        };
      });

    return {
      session: wrapperSession,
      key: `family:${familyId}`,
      selectKey,
      familyId,
      displayLabel: familyLabel,
      parentId: null,
      depth: 0,
      children: childNodes,
      isExpanded: true,
      kind: 'family',
      _sortTime: summaryTime,
    } as TreeNode & { _sortTime: number };
  });

  return familyNodes
    .sort((a, b) => b._sortTime - a._sortTime)
    .map(({ _sortTime: _discard, ...node }) => node);
}

/** Flatten a tree into an ordered list, respecting collapsed state. */
export function flattenTree(
  roots: TreeNode[],
  expandedState: Record<string, boolean>,
): TreeNode[] {
  const result: TreeNode[] = [];

  function walk(nodes: TreeNode[]) {
    for (const node of nodes) {
      result.push(node);
      const isExpanded = expandedState[node.key] ?? node.isExpanded;
      if (isExpanded && node.children.length > 0) {
        walk(node.children);
      }
    }
  }

  walk(roots);
  return result;
}
