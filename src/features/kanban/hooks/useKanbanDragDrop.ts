import { useCallback, useRef, useState } from 'react';
import {
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  defaultKeyboardCoordinateGetter,
  closestCorners,
} from '@dnd-kit/core';
import type { DragStartEvent, DragOverEvent, DragEndEvent } from '@dnd-kit/core';
import { arrayMove } from '@dnd-kit/sortable';
import type { KanbanTask, TaskStatus } from '../types';
import { COLUMNS } from '../types';
import { compareTaskPriority } from './useKanban';

interface UseKanbanDragDropOptions {
  tasks: KanbanTask[];
  setTasksOptimistic: (updater: (prev: KanbanTask[]) => KanbanTask[]) => void;
  reorderTask: (id: string, version: number, targetStatus: TaskStatus, targetIndex: number) => Promise<KanbanTask>;
  onError?: (msg: string) => void;
  /** Active column keys — used to distinguish column drop targets from card IDs. Defaults to COLUMNS. */
  activeColumns?: TaskStatus[];
}

const visualOrder = (a: KanbanTask, b: KanbanTask) =>
  compareTaskPriority(a, b) || a.columnOrder - b.columnOrder;

// Translate a visible insertion inside the task's priority band back to
// the raw columnOrder index used by the server.
const rawInsertionIndex = (rawTasks: KanbanTask[], priority: KanbanTask['priority'], visibleIndex: number) => {
  const visible = [...rawTasks].sort(visualOrder);
  const peers = visible.filter((task) => task.priority === priority);
  const peerStart = visible.findIndex((task) => task.priority === priority);
  const peerIndex = Math.max(0, Math.min(visibleIndex - Math.max(0, peerStart), peers.length));
  const raw = [...rawTasks].sort((a, b) => a.columnOrder - b.columnOrder);
  const nextPeer = peers[peerIndex];
  if (nextPeer) return raw.findIndex((task) => task.id === nextPeer.id);
  const lastPeer = peers.at(-1);
  return lastPeer ? raw.findIndex((task) => task.id === lastPeer.id) + 1 : raw.length;
};

/**
 * Encapsulates all dnd-kit drag-and-drop logic for the Kanban board.
 * Provides sensors, event handlers, active task state, and collision strategy.
 */
export function useKanbanDragDrop({
  tasks,
  setTasksOptimistic,
  reorderTask,
  onError,
  activeColumns: activeColumnsProp,
}: UseKanbanDragDropOptions) {
  const activeColumns = activeColumnsProp ?? COLUMNS;
  const [activeTask, setActiveTask] = useState<KanbanTask | null>(null);

  // Snapshot of tasks before a drag starts — used for rollback on error
  const snapshotRef = useRef<KanbanTask[] | null>(null);
  const submittingRef = useRef(false);

  /* ── Sensors ── */
  const pointerSensor = useSensor(PointerSensor, {
    activationConstraint: { distance: 5 },
  });
  const keyboardSensor = useSensor(KeyboardSensor, {
    coordinateGetter: defaultKeyboardCoordinateGetter,
  });
  const sensors = useSensors(pointerSensor, keyboardSensor);

  /* ── Helpers ── */
  /** Determine which column a droppable id belongs to. */
  const findColumnForId = useCallback(
    (id: string): TaskStatus | null => {
      // Is it a column id directly?
      if (activeColumns.includes(id)) return id as TaskStatus;
      // Otherwise it's a task id — find its column
      const task = tasks.find((t) => t.id === id);
      return task?.status ?? null;
    },
    [tasks, activeColumns],
  );

  /* ── Drag Start ── */
  const onDragStart = useCallback(
    (event: DragStartEvent) => {
      if (submittingRef.current) return;
      const task = tasks.find((t) => t.id === event.active.id);
      if (!task) return;
      setActiveTask(task);
      snapshotRef.current = tasks.map((t) => ({ ...t })); // deep-ish clone
    },
    [tasks],
  );

  /* ── Drag Over (live column transfer for visual feedback) ── */
  const onDragOver = useCallback(
    (event: DragOverEvent) => {
      if (submittingRef.current) return;
      const { active, over } = event;
      if (!over) return;

      const activeId = active.id as string;
      const overId = over.id as string;

      const fromColumn = findColumnForId(activeId);
      const toColumn = findColumnForId(overId);
      if (!fromColumn || !toColumn || fromColumn === toColumn) return;

      // Move card to the new column optimistically
      setTasksOptimistic((prev) => {
        const activeTask = prev.find((t) => t.id === activeId);
        if (!activeTask) return prev;

        const destTasks = prev
          .filter((t) => t.status === toColumn && t.id !== activeId)
          .sort(visualOrder);

        // Find index to insert at: if over is a task, insert at its index; else append
        let newIndex = destTasks.length;
        if (!activeColumns.includes(overId)) {
          const overIndex = destTasks.findIndex((t) => t.id === overId);
          if (overIndex >= 0) newIndex = overIndex;
        }

        const rawIndex = rawInsertionIndex(destTasks, activeTask.priority, newIndex);
        const rawTasks = [...destTasks].sort((a, b) => a.columnOrder - b.columnOrder);
        rawTasks.splice(rawIndex, 0, { ...activeTask, status: toColumn });
        const orderMap = new Map(rawTasks.map((task, index) => [task.id, index]));

        return prev.map((task) => orderMap.has(task.id)
          ? { ...task, status: toColumn, columnOrder: orderMap.get(task.id)! }
          : task);
      });
    },
    [findColumnForId, setTasksOptimistic, activeColumns],
  );

  /* ── Drag End (commit to API) ── */
  const onDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const { active, over } = event;
      setActiveTask(null);
      if (submittingRef.current) return;

      if (!over) {
        // Dropped outside — rollback
        const snapshot = snapshotRef.current;
        if (snapshot) {
          setTasksOptimistic(() => snapshot);
          snapshotRef.current = null;
        }
        return;
      }

      const activeId = active.id as string;
      const overId = over.id as string;

      // Find the task from snapshot (has correct original version)
      const originalTask = snapshotRef.current?.find((t) => t.id === activeId);
      if (!originalTask) {
        snapshotRef.current = null;
        return;
      }

      // Determine target column
      const targetColumn = findColumnForId(overId) ?? originalTask.status;

      // Compute final order: get current tasks in the target column after optimistic updates
      // Use the live tasks state (already optimistically updated in onDragOver)
      const columnTasks = tasks
        .filter((t) => t.status === targetColumn)
        .sort(visualOrder);

      let targetIndex: number;

      if (activeId === overId) {
        // Dropped on itself — find its current index in column
        targetIndex = columnTasks.findIndex((t) => t.id === activeId);
        if (targetIndex < 0) targetIndex = 0;
      } else if (activeColumns.includes(overId)) {
        // Dropped on empty column — append
        targetIndex = columnTasks.filter((t) => t.id !== activeId).length;
      } else {
        // Dropped on another card — use that card's position
        const overIndex = columnTasks.findIndex((t) => t.id === overId);
        const activeIndex = columnTasks.findIndex((t) => t.id === activeId);

        if (originalTask.status === targetColumn && activeIndex >= 0 && overIndex >= 0) {
          // Same column reorder: use arrayMove index logic
          const reordered = arrayMove(
            columnTasks.map((t) => t.id),
            activeIndex,
            overIndex,
          );
          targetIndex = reordered.indexOf(activeId);
        } else {
          // Cross-column: insert at over position
          targetIndex = overIndex >= 0 ? overIndex : columnTasks.length;
        }
      }

      // If nothing actually changed, skip API call
      if (
        originalTask.status === targetColumn &&
        targetIndex === columnTasks.findIndex((t) => t.id === activeId)
      ) {
        snapshotRef.current = null;
        return;
      }

      const movedTask = columnTasks.find((task) => task.id === activeId) ?? originalTask;
      const withoutActive = columnTasks.filter((task) => task.id !== activeId);
      const groupStart = withoutActive.findIndex((task) => task.priority === movedTask.priority);
      const visibleInsertion = originalTask.status === targetColumn
        ? targetIndex
        : activeColumns.includes(overId)
          ? withoutActive.length
          : Math.max(0, withoutActive.findIndex((task) => task.id === overId));
      const peerInsertion = withoutActive
        .slice(0, visibleInsertion)
        .filter((task) => task.priority === movedTask.priority).length;
      targetIndex = rawInsertionIndex(
        withoutActive,
        movedTask.priority,
        Math.max(0, groupStart) + Math.max(0, peerInsertion),
      );

      // Optimistic state is already applied from onDragOver / implicit ordering.
      // Now apply the final correct ordering in local state.
      setTasksOptimistic((prev) => {
        const colTasks = prev
          .filter((t) => t.status === targetColumn && t.id !== activeId)
          .sort((a, b) => a.columnOrder - b.columnOrder);

        const clamped = Math.max(0, Math.min(targetIndex, colTasks.length));
        const ordered = [...colTasks];
        const moved = prev.find((t) => t.id === activeId);
        if (!moved) return prev;
        ordered.splice(clamped, 0, moved);

        const orderMap = new Map<string, number>();
        ordered.forEach((t, i) => orderMap.set(t.id, i));

        return prev.map((t) => {
          if (t.id === activeId) {
            return { ...t, status: targetColumn, columnOrder: clamped };
          }
          if (t.status === targetColumn && orderMap.has(t.id)) {
            return { ...t, columnOrder: orderMap.get(t.id)! };
          }
          return t;
        });
      });

      // Call API — rollback on failure
      submittingRef.current = true;
      try {
        const updated = await reorderTask(activeId, originalTask.version, targetColumn, targetIndex);
        setTasksOptimistic((prev) => prev.map((task) => task.id === updated.id ? updated : task));
      } catch (err: unknown) {
        // Restore the pre-drag order while keeping the server's latest task
        // version when another writer changed it during the drag.
        const snapshot = snapshotRef.current;
        if (snapshot) {
          const latest = (err as Error & { latest?: KanbanTask }).latest;
          setTasksOptimistic(() => snapshot.map((task) => latest?.id === task.id ? latest : task));
        }
        const msg =
          err instanceof Error && err.message === 'version_conflict'
            ? 'Task changed elsewhere. The latest task details were kept; try the move again.'
            : 'Failed to move task — reverted';
        onError?.(msg);
      } finally {
        submittingRef.current = false;
        snapshotRef.current = null;
      }
    },
    [tasks, findColumnForId, setTasksOptimistic, reorderTask, onError, activeColumns],
  );

  const onDragCancel = useCallback(() => {
    if (submittingRef.current) return;
    const snapshot = snapshotRef.current;
    if (snapshot) {
      setTasksOptimistic(() => snapshot);
    }
    snapshotRef.current = null;
    setActiveTask(null);
  }, [setTasksOptimistic]);

  return {
    sensors,
    collisionDetection: closestCorners,
    activeTask,
    onDragStart,
    onDragOver,
    onDragEnd,
    onDragCancel,
  };
}
