import { useRef, useEffect, useMemo, useState, useCallback } from 'react';
import type { Session } from '@/types';
import { getSessionKey } from '@/types';
import type { SpawnSessionOpts, GatewayAgentRegistration } from '@/contexts/SessionContext';
import { SessionSkeletonGroup } from '@/components/skeletons';
import { buildAgentSidebarTree, flattenTree, getSessionType, type TreeNode } from './sessionTree';
import {
  getRootAgentId,
  getSessionDisplayLabel,
  getSessionTailSegment,
  humanizeAgentFamilyId,
  isDirectSessionKey,
  isTopLevelAgentSessionKey,
  normalizeSessionKey,
} from './sessionKeys';
import { SessionNode } from './SessionNode';
import type { GranularAgentState } from '@/types';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { AlertTriangle, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { SpawnAgentDialog } from './SpawnAgentDialog';

const INITIAL_SESSION_VISIBILITY = 3;
const SESSION_VISIBILITY_INCREMENT = 5;

function isSessionRunning(
  session: Session,
  sessionKey: string,
  busyState: Record<string, boolean>,
  isGrowingSubagent: boolean,
): boolean {
  if (session.hasActiveRun === false) {
    // The gateway can leave old sessions labelled "running" after model
    // timeout or overload. hasActiveRun=false is the recovery signal.
    return false;
  }

  return Boolean(
    busyState[sessionKey]
    || session.state === 'running'
    || session.agentState === 'running'
    || session.busy
    || session.processing
    || session.status === 'running'
    || session.status === 'busy'
    || isGrowingSubagent,
  );
}

function getSessionTokenTotal(session: Session): number {
  if (typeof session.totalTokens === 'number' && session.totalTokens > 0) {
    return session.totalTokens;
  }

  const inputTokens = typeof session.inputTokens === 'number' ? session.inputTokens : 0;
  const outputTokens = typeof session.outputTokens === 'number' ? session.outputTokens : 0;
  return inputTokens + outputTokens;
}

interface SessionListProps {
  sessions: Session[];
  currentSession: string;
  busyState: Record<string, boolean>;
  agentStatus?: Record<string, GranularAgentState>;
  unreadSessions?: Record<string, boolean>;
  onSelect: (key: string) => void;
  onRefresh: () => void;
  onDelete?: (sessionKey: string) => Promise<void>;
  onDeleteAllSessions?: () => Promise<void>;
  onSpawn?: (opts: SpawnSessionOpts) => Promise<void | boolean>;
  onRename?: (sessionKey: string, label: string) => Promise<void>;
  onAbort?: (sessionKey: string) => Promise<void>;
  isLoading?: boolean;
  agentName?: string;
  agents?: GatewayAgentRegistration[];
  /** Render in compact dropdown mode (chat-first topbar panel). */
  compact?: boolean;
  hideTitle?: boolean;
}

function countDescendants(node: TreeNode): number {
  return node.children.reduce((total, child) => total + 1 + countDescendants(child), 0);
}

function findNodeByKey(nodes: TreeNode[], key: string): TreeNode | null {
  const queue = [...nodes];
  while (queue.length > 0) {
    const node = queue.shift()!;
    if (node.key === key) return node;
    queue.push(...node.children);
  }
  return null;
}

function resolveFamilyLabel(
  familyId: string | null | undefined,
  agents: GatewayAgentRegistration[],
  session?: Session,
): string {
  if (!familyId) {
    return session?.displayName?.trim() || session?.label?.trim() || 'Agent';
  }

  const registryEntry = agents.find((agent) => agent.id.trim() === familyId.trim());
  const registryLabel = registryEntry?.identityName?.trim() || registryEntry?.name?.trim() || registryEntry?.label?.trim();
  if (registryLabel) return registryLabel;

  return humanizeAgentFamilyId(familyId);
}

function resolveSidebarLabel(
  session: Session,
  agentName: string,
  agents: GatewayAgentRegistration[],
  kind?: TreeNode['kind'],
  familyId?: string | null,
): string {
  if (kind === 'family') {
    return resolveFamilyLabel(familyId, agents, session);
  }

  const sessionKey = normalizeSessionKey(getSessionKey(session));
  if (isDirectSessionKey(sessionKey)) {
    const peer = getSessionTailSegment(sessionKey).trim();
    if (peer) return peer;
  }

  if (familyId) {
    if (session.label?.trim() && session.label.trim().toLowerCase() !== 'heartbeat') return session.label.trim();
    if (session.displayName?.trim() && session.displayName.trim().toLowerCase() !== 'heartbeat') return session.displayName.trim();
    if (session.label?.trim()) return session.label.trim();
    if (session.displayName?.trim()) return session.displayName.trim();
    return getSessionTailSegment(sessionKey);
  }

  if (!isTopLevelAgentSessionKey(sessionKey)) {
    return getSessionDisplayLabel(session, agentName);
  }

  const rootId = getRootAgentId(sessionKey);
  if (rootId === 'main') {
    return getSessionDisplayLabel(session, agentName);
  }

  const registryEntry = agents.find((agent) => agent.id.trim() === rootId);
  const registryLabel = registryEntry?.identityName?.trim() || registryEntry?.name?.trim() || registryEntry?.label?.trim();
  if (registryLabel) return registryLabel;

  if (session.displayName?.trim()) return session.displayName.trim();
  if (session.label?.trim()) return session.label.trim();

  return getSessionDisplayLabel(session, agentName);
}

/** Sidebar list of agent sessions with tree structure and context menus. */
export function SessionList({ sessions, currentSession, busyState, agentStatus, unreadSessions, onSelect, onRefresh, onDelete, onDeleteAllSessions, onSpawn, onRename, onAbort, isLoading, agentName = 'Agent', agents = [], compact = false, hideTitle = false }: SessionListProps) {
  const [deleteTarget, setDeleteTarget] = useState<{ key: string; label: string; descendantCount: number; isRootAgent: boolean } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteAllOpen, setDeleteAllOpen] = useState(false);
  const [deletingAll, setDeletingAll] = useState(false);
  const [spawnOpen, setSpawnOpen] = useState(false);
  const [renamingKey, setRenamingKey] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);
  const [expandedState, setExpandedState] = useState<Record<string, boolean>>({});
  const [visibleSessionLimit, setVisibleSessionLimit] = useState(INITIAL_SESSION_VISIBILITY);

  const startRename = useCallback((sessionKey: string, currentLabel: string) => {
    setRenamingKey(sessionKey);
    setRenameValue(currentLabel);
    setTimeout(() => renameInputRef.current?.focus(), 0);
  }, []);

  const commitRename = useCallback(async () => {
    if (!renamingKey || !onRename) return;
    const trimmed = renameValue.trim();
    if (trimmed) {
      try { await onRename(renamingKey, trimmed); } catch (err) { console.error('Failed to rename session:', err); }
    }
    setRenamingKey(null);
  }, [renamingKey, renameValue, onRename]);

  const cancelRename = useCallback(() => {
    setRenamingKey(null);
  }, []);

  const handleRenameChange = useCallback((value: string) => {
    setRenameValue(value);
  }, []);

  const handleToggleExpand = useCallback((key: string) => {
    setExpandedState((prev) => ({ ...prev, [key]: !(prev[key] ?? true) }));
  }, []);

  const prevPercentsRef = useRef<Record<string, number>>({});
  const prevTokensRef = useRef<Record<string, number>>({});
  const liveSessionKeys = useMemo(() => new Set(sessions.map((session) => normalizeSessionKey(getSessionKey(session)))), [sessions]);

  // Calculate which sessions are growing (compare to previous render via ref)
  const growingSessions = useMemo(() => {
    const result: Record<string, boolean> = {};
    sessions.forEach(s => {
      const sessionKey = getSessionKey(s);
      const used = getSessionTokenTotal(s);
      const max = s.contextTokens || 200000;
      const pct = Math.min(100, Math.round((used / max) * 100));
      const prevPct = prevPercentsRef.current[sessionKey];
      result[sessionKey] = prevPct !== undefined && pct > prevPct;
    });
    return result;
  }, [sessions]);

  // Update refs AFTER render
  useEffect(() => {
    sessions.forEach(s => {
      const sessionKey = getSessionKey(s);
      const used = getSessionTokenTotal(s);
      const max = s.contextTokens || 200000;
      const pct = Math.min(100, Math.round((used / max) * 100));
      prevPercentsRef.current[sessionKey] = pct;
      if (used > 0) {
        prevTokensRef.current[sessionKey] = used;
      }
    });
  }, [sessions]);

  // The AGENTS panel is agent-first: keep only agent roots and their descendants.
  const liveTree = useMemo(() => buildAgentSidebarTree(sessions, agents), [agents, sessions]);
  const liveFlatNodes = useMemo(() => flattenTree(liveTree, expandedState), [liveTree, expandedState]);
  const selectedSessionNormalized = useMemo(() => normalizeSessionKey(currentSession), [currentSession]);
  const selectedSessionIndex = useMemo(
    () => liveFlatNodes.findIndex((node) => normalizeSessionKey(node.selectKey || node.key) === selectedSessionNormalized),
    [liveFlatNodes, selectedSessionNormalized],
  );
  const visibleSessionLimitWithSelection = useMemo(
    () => Math.min(
      Math.max(
        visibleSessionLimit,
        selectedSessionIndex >= 0 ? selectedSessionIndex + 1 : INITIAL_SESSION_VISIBILITY,
      ),
      liveFlatNodes.length,
    ),
    [liveFlatNodes.length, selectedSessionIndex, visibleSessionLimit],
  );
  const visibleLiveFlatNodes = useMemo(
    () => liveFlatNodes.slice(0, visibleSessionLimitWithSelection),
    [liveFlatNodes, visibleSessionLimitWithSelection],
  );
  const hasMoreLiveSessions = visibleLiveFlatNodes.length < liveFlatNodes.length;
  const liveFamilyIds = useMemo(
    () => new Set(liveTree.map((node) => node.familyId).filter((familyId): familyId is string => Boolean(familyId))),
    [liveTree],
  );
  const configuredFallbackSessions = useMemo<Session[]>(() => agents.flatMap((agent) => {
    const id = agent.id.trim();
    if (!id || id === 'main' || liveFamilyIds.has(id)) return [];

    const sessionKey = `agent:${id}:main`;
    if (liveSessionKeys.has(normalizeSessionKey(sessionKey))) return [];

    return [{
      sessionKey,
      label: agent.name?.trim() || agent.label?.trim() || `Agent ${id}`,
      displayName: agent.identityName?.trim() || agent.name?.trim() || agent.label?.trim() || undefined,
      state: 'idle',
      agentState: 'idle',
      status: 'idle',
    } as Session];
  }), [agents, liveFamilyIds, liveSessionKeys]);
  const fallbackTree = useMemo(() => buildAgentSidebarTree(configuredFallbackSessions, agents), [agents, configuredFallbackSessions]);
  const fallbackFlatNodes = useMemo(() => flattenTree(fallbackTree, expandedState), [fallbackTree, expandedState]);
  // Count the visible live agent rows, not the raw gateway payload, so the
  // bulk-delete confirmation matches what the user actually sees.
  const liveSessionCount = liveFlatNodes.length;

  useEffect(() => {
    setVisibleSessionLimit((prev) => Math.min(Math.max(prev, INITIAL_SESSION_VISIBILITY), liveFlatNodes.length));
  }, [liveFlatNodes.length]);

  const loadMoreSessions = useCallback(() => {
    setVisibleSessionLimit((prev) => Math.min(prev + SESSION_VISIBILITY_INCREMENT, liveFlatNodes.length));
  }, [liveFlatNodes.length]);

  const handleDelete = useCallback(async () => {
    if (!deleteTarget || !onDelete) return;
    setDeleting(true);
    try {
      await onDelete(deleteTarget.key);
    } catch (err) {
      console.error('Failed to delete session:', err);
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
    }
  }, [deleteTarget, onDelete]);

  const handleDeleteAll = useCallback(async () => {
    if (!onDeleteAllSessions || liveSessionCount === 0) return;
    setDeletingAll(true);
    try {
      await onDeleteAllSessions();
    } catch (err) {
      console.error('Failed to delete all sessions:', err);
    } finally {
      setDeletingAll(false);
      setDeleteAllOpen(false);
    }
  }, [liveSessionCount, onDeleteAllSessions]);

  const handleSetDeleteTarget = useCallback((key: string, label: string) => {
    const targetNode = findNodeByKey(liveTree, key);
    setDeleteTarget({
      key,
      label,
      descendantCount: targetNode ? countDescendants(targetNode) : 0,
      isRootAgent: isTopLevelAgentSessionKey(key),
    });
  }, [liveTree]);

  const renderSessionNode = useCallback((node: TreeNode, allowActions: boolean) => {
    const sessionKey = node.key;
    const sessionType = getSessionType(sessionKey);
    const isSubagent = sessionType === 'subagent';
    const isCron = sessionType === 'cron';
    const isCronRun = sessionType === 'cron-run';
    const isRootAgent = node.kind === 'family' || isTopLevelAgentSessionKey(sessionKey);
    const label = node.displayLabel?.trim() || resolveSidebarLabel(node.session, agentName, agents, node.kind, node.familyId);
    const isGrowing = growingSessions[sessionKey] ?? false;
    const running = isSessionRunning(node.session, sessionKey, busyState, isGrowing && isSubagent);
    const granularStatus = node.session.hasActiveRun === false ? undefined : agentStatus?.[sessionKey];
    const activationKey = normalizeSessionKey(node.selectKey || sessionKey);
    const isActive = activationKey === normalizeSessionKey(currentSession);
    const currentTokens = getSessionTokenTotal(node.session);
    const prevTokens = prevTokensRef.current[sessionKey] || 0;
    const displayTokens = Math.max(currentTokens, prevTokens);
    const isExpanded = expandedState[sessionKey] ?? !isCron;

    return (
      <SessionNode
        key={sessionKey}
        node={node}
        isActive={isActive}
        isGrowing={isGrowing}
        running={running}
        displayTokens={displayTokens}
        label={label}
        selectKey={node.selectKey}
        isExpanded={isExpanded}
        hasChildren={node.children.length > 0}
        isRootAgent={isRootAgent}
        isSubagent={isSubagent}
        isCron={isCron}
        isCronRun={isCronRun}
        isUnread={unreadSessions?.[sessionKey] ?? false}
        isRenaming={allowActions && renamingKey === sessionKey}
        renameValue={renameValue}
        renameInputRef={renameInputRef}
        granularStatus={allowActions ? granularStatus : undefined}
        onSelect={onSelect}
        onToggleExpand={handleToggleExpand}
        onDelete={allowActions && onDelete ? handleSetDeleteTarget : undefined}
        onStartRename={allowActions && onRename ? startRename : undefined}
        onAbort={allowActions ? onAbort : undefined}
        onRenameChange={handleRenameChange}
        onRenameCommit={commitRename}
        onRenameCancel={cancelRename}
        compact={compact}
      />
    );
  }, [
    agentName,
    agentStatus,
    busyState,
    cancelRename,
    commitRename,
    compact,
    currentSession,
    expandedState,
    handleRenameChange,
    handleSetDeleteTarget,
    handleToggleExpand,
    growingSessions,
    onAbort,
    onDelete,
    onRename,
    onSelect,
    renameInputRef,
    renameValue,
    renamingKey,
    unreadSessions,
    startRename,
  ]);

  return (
    <div className={compact ? 'flex flex-col max-h-[65vh]' : 'h-full flex flex-col min-h-0'}>
      <div className="panel-header border-l-[3px] border-l-info">
        {!hideTitle && (
          <span className="panel-label text-info">
            <span className="panel-diamond">◆</span>
            AGENTS
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {onSpawn && (
            <button
              type="button"
              onClick={() => setSpawnOpen(true)}
              aria-label="Create session"
              title="Create session"
              className="shell-icon-button size-10 px-0"
            >
              <Plus size={16} />
            </button>
          )}
          {onDeleteAllSessions && (
            <>
              {/* Keep the bulk reset in the header, but gate it behind a confirm dialog. */}
              <button
                type="button"
                onClick={() => setDeleteAllOpen(true)}
                aria-label="Delete all sessions"
                title="Delete all sessions"
                className="shell-icon-button size-10 px-0 text-red"
              >
                <Trash2 size={16} aria-hidden="true" />
              </button>
            </>
          )}
          <button
            type="button"
            onClick={onRefresh}
            aria-label="Refresh sessions"
            title="Refresh sessions"
            className="shell-icon-button size-10 px-0"
          >
            <RefreshCw size={16} aria-hidden="true" className={isLoading ? 'animate-spin' : undefined} />
          </button>
        </div>
      </div>
      <div className={compact ? 'overflow-y-auto' : 'flex-1 overflow-y-auto'}>
        {isLoading && liveFlatNodes.length === 0 ? (
          <SessionSkeletonGroup count={4} />
        ) : (
          <>
            {liveFlatNodes.length === 0 ? (
              <div className="text-muted-foreground px-3 py-2 text-[0.733rem]">No active sessions</div>
            ) : (
              <>
                {visibleLiveFlatNodes.map((node) => renderSessionNode(node, true))}
                {hasMoreLiveSessions && (
                  <div className="px-3 py-2">
                    <button
                      type="button"
                      onClick={loadMoreSessions}
                      className="w-full rounded border border-border/60 px-2 py-2 text-left text-[0.667rem] text-muted-foreground hover:text-foreground"
                      aria-label="Load more sessions"
                    >
                      Load {Math.min(SESSION_VISIBILITY_INCREMENT, liveFlatNodes.length - visibleSessionLimitWithSelection)} more sessions
                    </button>
                  </div>
                )}
              </>
            )}

            {fallbackFlatNodes.length > 0 && (
              <section className="mt-3 border-t border-border/40 pt-3">
                <div className="px-3 pb-2 text-[0.667rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground/80">
                  Configured agents
                </div>
                {fallbackFlatNodes.map((node) => renderSessionNode(node, false))}
              </section>
            )}
          </>
        )}
      </div>

      {/* Bulk delete confirmation dialog */}
      <Dialog open={deleteAllOpen} onOpenChange={(open) => !open && !deletingAll && setDeleteAllOpen(false)}>
        <DialogContent className="bg-card border-border max-w-md">
          <DialogHeader>
            <DialogTitle className="text-red font-mono text-sm tracking-wider uppercase flex items-center gap-2">
              <AlertTriangle size={16} />
              Delete All Sessions
            </DialogTitle>
            <DialogDescription className="text-muted-foreground text-xs">
              This will permanently delete every loaded session and transcript, then reset the current session to a fresh blank state.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <div className="bg-background border border-border/60 px-3 py-2">
              <p className="text-[0.733rem] text-muted-foreground uppercase tracking-wider mb-1">Visible agent sessions:</p>
              <p data-testid="loaded-session-count" className="text-[0.8rem] text-foreground font-mono">{liveSessionCount}</p>
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setDeleteAllOpen(false)}
              disabled={deletingAll}
              className="font-mono text-xs"
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={handleDeleteAll}
              disabled={deletingAll || liveSessionCount === 0}
              className="font-mono text-xs bg-red text-foreground hover:bg-red/90"
            >
              {deletingAll ? 'Deleting...' : 'Delete All'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation dialog */}
      <Dialog open={!!deleteTarget} onOpenChange={(open) => !open && !deleting && setDeleteTarget(null)}>
        <DialogContent className="bg-card border-border max-w-md">
          <DialogHeader>
            <DialogTitle className="text-red font-mono text-sm tracking-wider uppercase flex items-center gap-2">
              <AlertTriangle size={16} />
              {deleteTarget?.descendantCount ? 'Delete Session Tree' : 'Delete Session'}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground text-xs">
              {deleteTarget?.isRootAgent
                ? 'This will permanently delete this root session and any nested child sessions attached to it.'
                : deleteTarget?.descendantCount
                ? `This will permanently delete this session and ${deleteTarget.descendantCount} nested child session${deleteTarget.descendantCount === 1 ? '' : 's'}.`
                : 'This will permanently delete the session and archive its transcript.'}
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <div className="bg-background border border-border/60 px-3 py-2">
              <p className="text-[0.733rem] text-muted-foreground uppercase tracking-wider mb-1">Session:</p>
              <p className="text-[0.8rem] text-foreground font-mono">{deleteTarget?.label}</p>
              <p className="text-[0.667rem] text-muted-foreground font-mono mt-1 break-all">{deleteTarget?.key}</p>
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setDeleteTarget(null)}
              disabled={deleting}
              className="font-mono text-xs"
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={handleDelete}
              disabled={deleting}
              className="font-mono text-xs bg-red text-foreground hover:bg-red/90"
            >
              {deleting ? 'Deleting...' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Session creation dialog */}
      {onSpawn && (
        <SpawnAgentDialog
          open={spawnOpen}
          onOpenChange={setSpawnOpen}
          onSpawn={onSpawn}
        />
      )}
    </div>
  );
}
