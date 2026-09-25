import { memo, useCallback, useMemo, useState } from 'react';
import { Archive, LayoutGrid, RotateCcw } from 'lucide-react';
import { DndContext, DragOverlay } from '@dnd-kit/core';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { Button } from '@/components/ui/button';
import type { KanbanTask, TaskStatus } from './types';
import { COLUMN_LABELS, WORKFLOW_VISIBLE_STATUSES } from './types';
import { KanbanCard } from './KanbanCard';
import { useKanbanDragDrop } from './hooks/useKanbanDragDrop';
import { compareTaskPriority } from './hooks/useKanban';
import { TASK_STATUS_TONE } from './tone';

interface KanbanBoardProps {
  tasksByStatus: (status: TaskStatus) => KanbanTask[];
  onCardClick: (task: KanbanTask) => void;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  hasAnyTasks: boolean;
  onCreateTask: () => void;
  reorderTask: (id: string, version: number, targetStatus: TaskStatus, targetIndex: number) => Promise<KanbanTask>;
  archivedTasks?: KanbanTask[];
  archiveLoaded?: boolean;
  onLoadArchive?: () => Promise<void>;
  onRestoreArchivedTask?: (id: string) => Promise<KanbanTask>;
  onArchiveDone?: () => void;
  currentActiveTask?: KanbanTask | null;
  /** Back-compat prop; the board now defaults to the split-lane workflow statuses. */
  boardColumns?: TaskStatus[];
}

/* ── Loading skeleton ── */
function SkeletonLane({ title }: { title: string }) {
  return (
    <div className="shell-panel flex min-h-[420px] flex-col overflow-hidden rounded-[28px] border border-border/60 bg-background/55">
      <div className="border-b border-border/50 px-4 py-3">
        <div className="h-3 w-20 rounded bg-muted animate-pulse" />
        <div className="mt-2 h-2 w-32 rounded bg-muted/80 animate-pulse" />
      </div>
      <div className="px-4 py-3 space-y-3">
        <div className="text-[0.667rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">{title}</div>
        {[72, 88, 64].map((h, i) => (
          <div key={i} className="rounded-[18px] border border-border/50 bg-muted/35 animate-pulse" style={{ height: `${h}px` }} />
        ))}
      </div>
    </div>
  );
}

function labelFromKey(key: string): string {
  return key.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function sectionTone(status: TaskStatus) {
  return TASK_STATUS_TONE[status] ?? TASK_STATUS_TONE.todo;
}

function TaskStack({
  status,
  tasks,
  onCardClick,
  featuredTaskId,
}: {
  status: TaskStatus;
  tasks: KanbanTask[];
  onCardClick: (task: KanbanTask) => void;
  featuredTaskId?: string | null;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  const taskIds = useMemo(() => tasks.map((task) => task.id), [tasks]);
  const tone = sectionTone(status);
  const displayLabel = COLUMN_LABELS[status] ?? labelFromKey(status);

  return (
    <section className={`rounded-[22px] border transition-colors ${isOver ? 'border-primary/45 bg-primary/[0.05]' : 'border-border/60 bg-background/35'}`}>
      <div className="flex items-center justify-between gap-3 border-b border-border/40 px-3 py-2.5">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`text-[0.667rem] font-semibold uppercase tracking-[0.16em] ${tone.textClass}`}>
            {displayLabel}
          </span>
          {featuredTaskId && featuredTaskId && status === 'in-progress' && (
            <span className="cockpit-badge" data-tone="primary">Current</span>
          )}
        </div>
        <span className={`inline-flex min-w-[28px] items-center justify-center rounded-full border px-2 py-0.5 text-[0.667rem] font-semibold tabular-nums ${tone.badgeClass}`}>
          {tasks.length}
        </span>
      </div>

      <SortableContext items={taskIds} strategy={verticalListSortingStrategy}>
        <div ref={setNodeRef} className="flex min-h-[92px] flex-col gap-2 p-2.5">
          {tasks.length === 0 ? (
            <div className="flex flex-1 items-center justify-center rounded-[18px] border border-dashed border-border/40 px-4 py-5 text-center text-[0.733rem] text-muted-foreground/65 select-none">
              No tasks
            </div>
          ) : tasks.map((task) => {
            const featured = task.id === featuredTaskId;
            return (
              <div
                key={task.id}
                className={featured ? 'rounded-[22px] border border-primary/40 bg-primary/[0.06] p-1 shadow-[0_14px_28px_rgba(0,0,0,0.18)]' : ''}
              >
                <KanbanCard task={task} onClick={onCardClick} />
              </div>
            );
          })}
        </div>
      </SortableContext>
    </section>
  );
}

function ArchiveRow({
  task,
  onRestore,
}: {
  task: KanbanTask;
  onRestore?: (id: string) => Promise<KanbanTask>;
}) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-[18px] border border-border/55 bg-background/55 px-3 py-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="cockpit-badge" data-tone="success">Archived</span>
          <span className="text-[0.667rem] text-muted-foreground">{new Date(task.updatedAt).toLocaleDateString()}</span>
        </div>
        <div className="mt-1 truncate text-sm font-medium text-foreground">{task.title}</div>
        <div className="mt-0.5 text-[0.733rem] text-muted-foreground truncate">{task.result || task.description || 'No extra details'}</div>
      </div>
      {onRestore && (
        <Button variant="outline" size="sm" onClick={() => { void onRestore(task.id); }}>
          <RotateCcw size={14} />
          Restore
        </Button>
      )}
    </div>
  );
}

export const KanbanBoard = memo(function KanbanBoard({
  tasksByStatus,
  onCardClick,
  loading,
  error,
  onRetry,
  hasAnyTasks,
  onCreateTask,
  reorderTask,
  archivedTasks = [],
  archiveLoaded = false,
  onLoadArchive,
  onRestoreArchivedTask,
  onArchiveDone,
  currentActiveTask = null,
  boardColumns: boardColumnsProp,
}: KanbanBoardProps) {
  const activeColumns = useMemo(() => {
    const source = boardColumnsProp ?? WORKFLOW_VISIBLE_STATUSES;
    return source.filter((status) => status !== 'done');
  }, [boardColumnsProp]);

  const propTasks = useMemo(() => {
    const all: KanbanTask[] = [];
    for (const col of activeColumns) {
      all.push(...tasksByStatus(col));
    }
    return all;
  }, [tasksByStatus, activeColumns]);

  const pendingArchiveTasks = useMemo(() => tasksByStatus('done'), [tasksByStatus]);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiveLoading, setArchiveLoading] = useState(false);

  const [dragOverride, setDragOverride] = useState<KanbanTask[] | null>(null);

  const localTasks = dragOverride ?? propTasks;

  const setTasksWithDragTracking = useCallback(
    (updater: (prev: KanbanTask[]) => KanbanTask[]) => {
      setDragOverride(prev => updater(prev ?? propTasks));
    },
    [propTasks],
  );

  const { sensors, collisionDetection, activeTask, onDragStart, onDragOver, onDragEnd, onDragCancel } = useKanbanDragDrop({
    tasks: localTasks,
    setTasksOptimistic: setTasksWithDragTracking,
    reorderTask,
    activeColumns,
    onError: (msg) => {
      setDragOverride(null);
      console.warn('[Kanban DnD]', msg);
    },
  });

  const handleDragStart = useCallback(
    (event: Parameters<typeof onDragStart>[0]) => {
      setDragOverride(propTasks);
      onDragStart(event);
    },
    [onDragStart, propTasks],
  );

  const handleDragEnd = useCallback(
    async (event: Parameters<typeof onDragEnd>[0]) => {
      await onDragEnd(event);
      setDragOverride(null);
    },
    [onDragEnd],
  );

  const handleDragCancel = useCallback(() => {
    onDragCancel();
    setDragOverride(null);
  }, [onDragCancel]);

  const handleToggleArchive = useCallback(async () => {
    const nextOpen = !archiveOpen;
    setArchiveOpen(nextOpen);
    if (nextOpen && !archiveLoaded && onLoadArchive) {
      setArchiveLoading(true);
      try {
        await onLoadArchive();
      } finally {
        setArchiveLoading(false);
      }
    }
  }, [archiveLoaded, archiveOpen, onLoadArchive]);

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="max-w-[420px] text-center">
          <p className="text-sm text-destructive font-semibold mb-2">Couldn't load tasks</p>
          <p className="text-xs text-muted-foreground mb-4">{error}</p>
          <Button size="sm" onClick={onRetry} className="text-[0.733rem] uppercase tracking-[0.16em]">
            Retry
          </Button>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="h-full overflow-hidden">
        <div className="grid h-full gap-3 xl:grid-cols-3">
          <SkeletonLane title="Queue" />
          <SkeletonLane title="Active" />
          <SkeletonLane title="Archive" />
        </div>
      </div>
    );
  }

  if (!hasAnyTasks) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="max-w-[420px] text-center select-none">
          <LayoutGrid size={28} className="mx-auto mb-3 text-primary opacity-60" />
          <h3 className="text-[1.067rem] font-bold text-foreground mb-1.5">No tasks yet</h3>
          <p className="text-[0.867rem] text-muted-foreground mb-5">
            Create your first task or ask an agent to propose one.
          </p>
          <Button size="sm" onClick={onCreateTask} className="min-w-[132px] text-[0.733rem] uppercase tracking-[0.16em]">
            Create Task
          </Button>
        </div>
      </div>
    );
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      onDragStart={handleDragStart}
      onDragOver={onDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <div className="h-full overflow-hidden">
        <div className="grid h-full gap-3 xl:grid-cols-[1.35fr_1.65fr]">
          <section className="shell-panel flex min-h-0 flex-col overflow-hidden rounded-[28px] border border-border/60 bg-background/55">
            <div className="border-b border-border/50 px-4 py-3">
              <div className="cockpit-kicker text-[0.6rem]">
                <span className="text-primary">◆</span>
                Queue
              </div>
              <div className="mt-1 text-sm text-muted-foreground">Ready list first. Backlog below.</div>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3 space-y-3">
              <TaskStack status="todo" tasks={localTasks.filter(task => task.status === 'todo').sort(compareTaskPriority)} onCardClick={onCardClick} />
              <TaskStack status="backlog" tasks={localTasks.filter(task => task.status === 'backlog').sort(compareTaskPriority)} onCardClick={onCardClick} />
            </div>
          </section>

          <section className="shell-panel flex min-h-0 flex-col overflow-hidden rounded-[28px] border border-border/60 bg-background/55">
            <div className="border-b border-border/50 px-4 py-3">
              <div className="cockpit-kicker text-[0.6rem]">
                <span className="text-primary">◆</span>
                Active
              </div>
              <div className="mt-1 text-sm text-muted-foreground">Live work surface. Review stays here until it is done.</div>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3 space-y-3">
              <TaskStack
                status="in-progress"
                tasks={localTasks.filter(task => task.status === 'in-progress').sort(compareTaskPriority)}
                onCardClick={onCardClick}
                featuredTaskId={currentActiveTask?.id ?? null}
              />
              <TaskStack status="review" tasks={localTasks.filter(task => task.status === 'review').sort(compareTaskPriority)} onCardClick={onCardClick} />
            </div>
          </section>

          <div className="xl:col-span-2">
            <div className="mt-3 rounded-[18px] border border-border/55 bg-background/45 px-3 py-2">
              <div className="flex items-center justify-between gap-3">
                <button
                  type="button"
                  onClick={() => { void handleToggleArchive(); }}
                  className="inline-flex items-center gap-2 text-[0.733rem] font-semibold uppercase tracking-[0.14em] text-muted-foreground hover:text-foreground"
                >
                  <Archive size={14} />
                  Archive
                  <span className="cockpit-badge">{pendingArchiveTasks.length + (archiveLoaded ? archivedTasks.length : 0)}</span>
                </button>
                {onArchiveDone && pendingArchiveTasks.length > 0 && (
                  <Button variant="outline" size="sm" onClick={onArchiveDone} title="Move done tasks into archive">
                    <Archive size={14} />
                    Archive Done
                  </Button>
                )}
              </div>
              {archiveOpen && (
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  {pendingArchiveTasks.length > 0 && (
                    <div className="space-y-2 rounded-[14px] border border-dashed border-border/50 bg-background/35 p-3">
                      <div className="cockpit-kicker text-[0.6rem]">Ready</div>
                      {pendingArchiveTasks.map((task) => (
                        <ArchiveRow key={task.id} task={task} />
                      ))}
                    </div>
                  )}
                  <div className="space-y-2 rounded-[14px] border border-border/50 bg-background/35 p-3">
                    <div className="cockpit-kicker text-[0.6rem]">Saved</div>
                    {archiveLoading ? (
                      <div className="py-4 text-center text-[0.733rem] text-muted-foreground">Loading…</div>
                    ) : archivedTasks.length === 0 ? (
                      <div className="py-4 text-center text-[0.733rem] text-muted-foreground">No archived tasks.</div>
                    ) : (
                      archivedTasks.map((task) => (
                        <ArchiveRow key={task.id} task={task} onRestore={onRestoreArchivedTask} />
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <DragOverlay dropAnimation={null}>
        {activeTask ? (
          <div className="w-[320px] opacity-90 rotate-[2deg]">
            <KanbanCard task={activeTask} onClick={() => {}} isDragOverlay />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
});
