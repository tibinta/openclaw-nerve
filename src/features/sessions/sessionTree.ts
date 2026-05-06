import type { Session } from '@/types';
import { getSessionKey } from '@/types';
import {
  getSessionType,
  isTopLevelAgentSessionKey,
  resolveParentSessionKey,
} from './sessionKeys';

export interface TreeNode {
  session: Session;
  key: string;
  parentId: string | null;
  depth: number;
  children: TreeNode[];
  isExpanded: boolean;
}

export { getSessionType } from './sessionKeys';

/** True only for real top-level agent roots that belong in the AGENTS sidebar. */
export function isAgentSidebarRootSessionKey(sessionKey: string): boolean {
  return isTopLevelAgentSessionKey(sessionKey);
}

function buildParentMap(sessions: Session[]): Map<string, string | null> {
  const keyMap = new Map<string, Session>();
  for (const session of sessions) {
    keyMap.set(getSessionKey(session), session);
  }

  const knownKeys = new Set(keyMap.keys());
  const parentMap = new Map<string, string | null>();
  for (const session of sessions) {
    const sessionKey = getSessionKey(session);
    parentMap.set(sessionKey, resolveParentSessionKey(session, knownKeys));
  }

  return parentMap;
}

function hasAgentSidebarEligibleLineage(
  sessionKey: string,
  parentMap: Map<string, string | null>,
  memo: Map<string, boolean>,
  visiting = new Set<string>(),
): boolean {
  if (memo.has(sessionKey)) return memo.get(sessionKey) ?? false;
  if (visiting.has(sessionKey)) return false;

  visiting.add(sessionKey);

  const parentKey = parentMap.get(sessionKey) ?? null;
  const result = parentKey === null
    ? isAgentSidebarRootSessionKey(sessionKey)
    : parentMap.has(parentKey) && hasAgentSidebarEligibleLineage(parentKey, parentMap, memo, visiting);

  visiting.delete(sessionKey);
  memo.set(sessionKey, result);
  return result;
}

function filterAgentSidebarSessions(
  sessions: Session[],
  parentMap: Map<string, string | null>,
): Session[] {
  const memo = new Map<string, boolean>();
  return sessions.filter((session) => hasAgentSidebarEligibleLineage(getSessionKey(session), parentMap, memo));
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
  const getSessionSortTime = (session: Session | undefined): number => {
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
  };
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
        parentId: parentKey,
        depth,
        children: buildNodes(sessionKey, depth + 1),
        isExpanded: true,
      };
    });
  }

  return buildNodes(null, 0);
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
  const parentMap = buildParentMap(sessions);
  return buildTreeNodes(sessions, parentMap);
}

/** Build the AGENTS sidebar tree, limited to real agent roots and their descendants. */
export function buildAgentSidebarTree(sessions: Session[]): TreeNode[] {
  const parentMap = buildParentMap(sessions);
  const eligibleSessions = filterAgentSidebarSessions(sessions, parentMap);
  return buildTreeNodes(eligibleSessions, parentMap);
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
