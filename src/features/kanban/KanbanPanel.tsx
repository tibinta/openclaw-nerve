import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import type { KanbanTask } from './types';
import { WORKFLOW_ACTIVE_STATUSES, WORKFLOW_QUEUE_STATUSES } from './types';
import { useKanban } from './hooks/useKanban';
import { useProposals } from './hooks/useProposals';
import { KanbanHeader } from './KanbanHeader';
import { KanbanBoard } from './KanbanBoard';
import { CreateTaskDialog } from './CreateTaskDialog';
import { TaskDetailDrawer } from './TaskDetailDrawer';
import { useSessionContext } from '@/contexts/SessionContext';
import { getRootAgentSessionKey } from '@/features/sessions/sessionKeys';
import { Button } from '@/components/ui/button';

interface KanbanPanelProps {
  /** If set, auto-open the drawer for this task ID on mount. */
  initialTaskId?: string | null;
  /** Called after the initial task drawer has been opened (to clear the ID). */
  onInitialTaskConsumed?: () => void;
}

function resolveTaskOwnerSessionKey(assignee?: string | null): string | null {
  if (!assignee || assignee === 'operator') return null;
  return getRootAgentSessionKey(assignee);
}

/**
 * Main Kanban panel — split lanes for Queue, Active, and Archive.
 */
export function KanbanPanel({ initialTaskId, onInitialTaskConsumed }: KanbanPanelProps = {}) {
  const {
    tasks,
    loading,
    error,
    filters,
    setFilters,
    fetchTasks,
    createTask,
    updateTask,
    deleteTask,
    reorderTask,
    tasksByStatus,
    statusCounts,
    executeTask,
    approveTask,
    rejectTask,
    abortTask,
    archivedTasks,
    archiveDoneTasks,
    restoreArchivedTask,
  } = useKanban();

  const {
    proposals,
    pendingCount: pendingProposalCount,
    approveProposal,
    rejectProposal,
  } = useProposals();

  const { currentSession } = useSessionContext();

  const [createOpen, setCreateOpen] = useState(false);
  const [selectedTask, setSelectedTask] = useState<KanbanTask | null>(null);
  const consumedRef = useRef<string | null>(null);

  const currentSessionRootKey = useMemo(
    () => getRootAgentSessionKey(currentSession) ?? null,
    [currentSession],
  );

  const currentActiveTask = useMemo(() => {
    const inProgressTasks = tasks.filter((task) => task.status === 'in-progress');
    const ownedInProgressTasks = inProgressTasks
      .map((task) => ({ task, ownerSessionKey: resolveTaskOwnerSessionKey(task.assignee) }))
      .filter((entry): entry is { task: KanbanTask; ownerSessionKey: string } => entry.ownerSessionKey != null);

    if (currentSessionRootKey) {
      const exactCurrentSessionTask = ownedInProgressTasks.find(
        ({ ownerSessionKey }) => ownerSessionKey === currentSessionRootKey,
      );
      if (exactCurrentSessionTask) return exactCurrentSessionTask.task;
    }

    if (ownedInProgressTasks.length > 0) {
      const ownerCounts = new Map<string, number>();
      for (const { ownerSessionKey } of ownedInProgressTasks) {
        ownerCounts.set(ownerSessionKey, (ownerCounts.get(ownerSessionKey) ?? 0) + 1);
      }

      const uniqueOwnedTask = ownedInProgressTasks.find(({ ownerSessionKey }) => ownerCounts.get(ownerSessionKey) === 1);
      if (uniqueOwnedTask) return uniqueOwnedTask.task;

      return ownedInProgressTasks[0]?.task ?? null;
    }

    return inProgressTasks[0]
      ?? tasks.find((task) => task.status === 'review')
      ?? null;
  }, [currentSessionRootKey, tasks]);

  const currentActiveOwnerSessionKey = useMemo(
    () => resolveTaskOwnerSessionKey(currentActiveTask?.assignee ?? null),
    [currentActiveTask?.assignee],
  );

  const workflowCounts = useMemo(() => ({
    queue: WORKFLOW_QUEUE_STATUSES.reduce((sum, status) => sum + tasksByStatus(status).length, 0),
    active: WORKFLOW_ACTIVE_STATUSES.reduce((sum, status) => sum + tasksByStatus(status).length, 0),
    archive: archivedTasks.length + tasksByStatus('done').length,
  }), [archivedTasks.length, tasksByStatus]);

  const hasVisibleBoardContent = useMemo(
    () => workflowCounts.queue > 0 || workflowCounts.active > 0 || workflowCounts.archive > 0,
    [workflowCounts],
  );

  // Auto-open drawer for initialTaskId
  useEffect(() => {
    if (!initialTaskId || initialTaskId === consumedRef.current) return;
    const match = tasks.find((t) => t.id === initialTaskId);
    if (match) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional one-time sync from prop
      setSelectedTask(match);
      consumedRef.current = initialTaskId;
      onInitialTaskConsumed?.();
    }
  }, [initialTaskId, tasks, onInitialTaskConsumed]);

  /* ── Card click → open drawer ── */
  const handleCardClick = useCallback((task: KanbanTask) => {
    setSelectedTask(task);
  }, []);

  /* ── Close drawer ── */
  const handleCloseDrawer = useCallback(() => {
    setSelectedTask(null);
  }, []);

  /* ── Create handler ── */
  const handleCreate = useCallback(async (payload: Parameters<typeof createTask>[0]) => {
    await createTask(payload);
  }, [createTask]);

  /* ── Update handler (refreshes selected task) ── */
  const handleUpdate = useCallback(async (...args: Parameters<typeof updateTask>) => {
    const updated = await updateTask(...args);
    setSelectedTask(updated);
    return updated;
  }, [updateTask]);

  /* ── Delete handler ── */
  const handleDelete = useCallback(async (id: string) => {
    await deleteTask(id);
  }, [deleteTask]);

  /* ── Open create dialog ── */
  const openCreateDialog = useCallback(() => {
    setCreateOpen(true);
  }, []);

  const handleArchive = useCallback(async () => {
    await archiveDoneTasks();
  }, [archiveDoneTasks]);

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-background">
      <KanbanHeader
        filters={filters}
        onFiltersChange={setFilters}
        statusCounts={statusCounts}
        workflowCounts={workflowCounts}
        onCreateTask={openCreateDialog}
        proposals={proposals}
        pendingProposalCount={pendingProposalCount}
        onApproveProposal={async (id) => { await approveProposal(id); await fetchTasks(); }}
        onRejectProposal={async (id) => { await rejectProposal(id); }}
        onArchiveDone={handleArchive}
      />

      <div className="px-4 pb-3">
        <div
          className="cockpit-note flex items-center justify-between gap-3 border border-primary/15 bg-primary/[0.05]"
          data-heartbeat-owner-session={currentActiveOwnerSessionKey ?? undefined}
          data-tone="primary"
        >
          <div className="min-w-0">
            <div className="cockpit-kicker text-[0.6rem]">
              <span className="text-primary">◆</span>
              Current active task
            </div>
            {currentActiveTask ? (
              <button
                type="button"
                onClick={() => setSelectedTask(currentActiveTask)}
                className="mt-1 block min-w-0 text-left text-sm font-semibold text-foreground underline-offset-4 hover:underline"
              >
                {currentActiveTask.title}
              </button>
            ) : (
              <div className="mt-1 text-sm text-muted-foreground">No task is currently active.</div>
            )}
            <div className="mt-1 text-[0.733rem] text-muted-foreground">
              Queue feeds Active. Archive stays visible, but out of the main work lane.
            </div>
            {currentActiveOwnerSessionKey ? (
              <div className="mt-1 text-[0.733rem] text-muted-foreground">
                Owner session: {currentActiveOwnerSessionKey}
              </div>
            ) : null}
            {currentActiveTask?.swarmSummary ? (
              <div className="mt-1 text-[0.733rem] text-primary">
                Swarm: {currentActiveTask.swarmSummary.packetsTotal} packets, {currentActiveTask.swarmSummary.packetsRunning} running, {currentActiveTask.swarmSummary.packetsBlocked} blocked
              </div>
            ) : null}
            {currentActiveTask?.swarmPacket ? (
              <div className="mt-1 text-[0.733rem] text-muted-foreground">
                Packet: {currentActiveTask.swarmPacket.cluster} / {currentActiveTask.swarmPacket.packetStatus}
              </div>
            ) : null}
          </div>
          {currentActiveTask && (
            <Button variant="outline" size="sm" onClick={() => setSelectedTask(currentActiveTask)}>
              Open
            </Button>
          )}
        </div>
      </div>

      {/* Board body */}
      <div className="flex-1 flex flex-col min-h-0 overflow-hidden px-4 pb-4">
        <KanbanBoard
          tasksByStatus={tasksByStatus}
          onCardClick={handleCardClick}
          loading={loading}
          error={error}
          onRetry={() => fetchTasks()}
          hasAnyTasks={hasVisibleBoardContent}
          onCreateTask={openCreateDialog}
          reorderTask={reorderTask}
          archivedTasks={archivedTasks}
          onRestoreArchivedTask={restoreArchivedTask}
          onArchiveDone={handleArchive}
          currentActiveTask={currentActiveTask}
        />
      </div>

      {/* Create Task Modal */}
      <CreateTaskDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreate={handleCreate}
      />

      {/* Task Detail Drawer */}
      <TaskDetailDrawer
        task={selectedTask}
        onClose={handleCloseDrawer}
        onUpdate={handleUpdate}
        onDelete={handleDelete}
        onExecute={executeTask}
        onApprove={approveTask}
        onReject={rejectTask}
        onAbort={abortTask}
      />
    </div>
  );
}
