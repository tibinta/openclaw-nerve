/**
 * KanbanQuickView — Compact read-only overview of active Kanban tasks.
 * Shows To Do, In Progress, and Review columns as mini-lists inside the workspace panel.
 * Self-contained: manages its own data via useKanban hook.
 */

import { useMemo, useState, useCallback } from 'react';
import { ArrowRight } from 'lucide-react';
import type { KanbanTask, TaskStatus } from './types';
import { COLUMN_LABELS } from './types';
import { useKanban } from './hooks/useKanban';
import { TaskDetailDrawer } from './TaskDetailDrawer';
import { getTaskPriorityTone, getTaskStatusTone } from './tone';

/* ── Statuses shown in quick view ── */
const QUICK_STATUSES: TaskStatus[] = ['in-progress', 'review', 'todo'];
const MAX_ROWS = 5;

interface KanbanQuickViewProps {
  onOpenBoard: () => void;
}

function TaskRow({ task, onClick }: { task: KanbanTask; onClick: () => void }) {
  const priorityTone = getTaskPriorityTone(task.priority);
  return (
    <button
      onClick={onClick}
      className="group flex w-full items-center gap-2 rounded-2xl border border-transparent px-2 py-2 text-left text-xs transition-colors cursor-pointer hover:border-primary/16 hover:bg-primary/[0.05]"
    >
      <span
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${priorityTone.dotClass}`}
        title={task.priority}
      />
      <span className="truncate flex-1 text-foreground/80 group-hover:text-foreground">
        {task.title}
      </span>
      {task.assignee && (
        <span className="shrink-0 text-[0.667rem] text-muted-foreground truncate max-w-[60px]">
          {task.assignee.replace(/^agent:/, '')}
        </span>
      )}
    </button>
  );
}

function StatusSection({
  status,
  tasks,
  onOpenTask,
}: {
  status: TaskStatus;
  tasks: KanbanTask[];
  onOpenTask: (task: KanbanTask) => void;
}) {
  const tone = getTaskStatusTone(status);
  const visible = tasks.slice(0, MAX_ROWS);
  const overflow = tasks.length - MAX_ROWS;

  return (
    <div className="mb-2 last:mb-0">
      <div className="mb-1 flex items-center gap-2 px-2">
        <span className={`text-[0.667rem] font-medium uppercase tracking-[0.16em] ${tone.textClass}`}>
          {COLUMN_LABELS[status]}
        </span>
        <span className="font-mono text-[0.667rem] text-muted-foreground/60">{tasks.length}</span>
      </div>
      {visible.map(task => (
        <TaskRow key={task.id} task={task} onClick={() => onOpenTask(task)} />
      ))}
      {overflow > 0 && (
        <span className="block px-1.5 text-[0.667rem] text-muted-foreground/50">
          +{overflow} more
        </span>
      )}
    </div>
  );
}

export function KanbanQuickView({ onOpenBoard }: KanbanQuickViewProps) {
  const {
    tasks,
    tasksByStatus,
    statusCounts,
    loading,
    error,
    updateTask,
    deleteTask,
    executeTask,
    approveTask,
    rejectTask,
    abortTask,
  } = useKanban();
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const selectedTask = useMemo(
    () => tasks.find((task) => task.id === selectedTaskId) ?? null,
    [selectedTaskId, tasks],
  );
  const subtasks = useMemo(
    () => selectedTask ? tasks.filter((task) => task.parentTaskId === selectedTask.id) : [],
    [selectedTask, tasks],
  );
  const parentTask = useMemo(
    () => selectedTask?.parentTaskId ? tasks.find((task) => task.id === selectedTask.parentTaskId) ?? null : null,
    [selectedTask, tasks],
  );
  const handleDeleteTask = useCallback(async (id: string) => {
    await deleteTask(id);
    setSelectedTaskId(null);
  }, [deleteTask]);

  const sections = useMemo(() => {
    return QUICK_STATUSES.map(s => ({
      status: s,
      tasks: tasksByStatus(s),
    }));
  }, [tasksByStatus]);

  const totalActive = (statusCounts.todo || 0) + (statusCounts['in-progress'] || 0) + (statusCounts.review || 0);
  const allEmpty = totalActive === 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="border-b border-border/40 px-3 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="cockpit-kicker text-[0.6rem]">
              <span className="text-primary">◆</span>
              Kanban
            </span>
          {totalActive > 0 && (
            <span className="cockpit-badge" data-tone="primary">
              {totalActive}
            </span>
          )}
        </div>
        <button
          onClick={onOpenBoard}
          className="cockpit-toolbar-button px-3 text-[0.733rem]"
        >
          Open Board
          <ArrowRight size={11} />
        </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-y-auto px-2 py-3">
        {error && (
          <p className="text-[0.733rem] text-destructive px-1.5">{error}</p>
        )}
        {loading && !error && (
          <p className="px-2 text-[0.733rem] text-muted-foreground/60 animate-pulse">Loading tasks…</p>
        )}
        {!loading && allEmpty && !error && (
          <div className="px-2 py-5 text-center">
            <div className="cockpit-badge mx-auto w-fit">Quiet board</div>
            <p className="mt-3 text-[0.733rem] text-muted-foreground/70">No active tasks right now.</p>
          </div>
        )}
        {!loading && !allEmpty && sections.map(({ status, tasks }) =>
          tasks.length > 0 ? (
            <StatusSection
              key={status}
              status={status}
              tasks={tasks}
              onOpenTask={(task) => setSelectedTaskId(task.id)}
            />
          ) : null
        )}
      </div>
      <TaskDetailDrawer
        task={selectedTask}
        onClose={() => setSelectedTaskId(null)}
        onUpdate={updateTask}
        onDelete={handleDeleteTask}
        parentTask={parentTask}
        subtasks={subtasks}
        onOpenRelatedTask={(task) => setSelectedTaskId(task.id)}
        onExecute={executeTask}
        onApprove={approveTask}
        onReject={rejectTask}
        onAbort={abortTask}
      />
    </div>
  );
}
