import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import type { KanbanTask, DelegationProof, SwarmSummary, SwarmPacket, TaskStatus, TaskPriority } from '../types';
import { COLUMNS } from '../types';

/* ── API response shape ── */
interface TasksResponse {
  items: KanbanTask[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

interface ArchiveResponse {
  items: KanbanTask[];
  total: number;
}

/* ── Filter state ── */
export interface KanbanFilters {
  q: string;
  priority: TaskPriority[];
  assignee: string;
  labels: string[];
}

const EMPTY_FILTERS: KanbanFilters = { q: '', priority: [], assignee: '', labels: [] };
const BOARD_LOAD_ORDER: TaskStatus[] = ['in-progress', 'review', 'todo', 'backlog'];

/** Error with attached latest task from a 409 response */
export interface VersionConflictError extends Error {
  latest?: KanbanTask;
}

/* ── Create / Update payloads ── */
export interface CreateTaskPayload {
  title: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  labels?: string[];
  assignee?: string;
  evidence_links?: string[];
  proof_gate?: {
    reindex_verified: boolean;
    read_back_verified: boolean;
    live_link_or_canvas_checked: boolean;
    proof_log_updated: boolean;
  };
  delegation_proof?: DelegationProof;
  parentTaskId?: string;
  swarmSummary?: SwarmSummary;
  swarmPacket?: SwarmPacket;
}

export interface UpdateTaskPayload {
  title?: string;
  description?: string | null;
  status?: TaskStatus;
  priority?: TaskPriority;
  labels?: string[];
  assignee?: string | null;
  evidence_links?: string[];
  feedback?: {
    at: number | string;
    by: string;
    note: string;
  }[];
  proof_gate?: {
    reindex_verified: boolean;
    read_back_verified: boolean;
    live_link_or_canvas_checked: boolean;
    proof_log_updated: boolean;
  };
  delegation_proof?: DelegationProof;
  parentTaskId?: string;
  swarmSummary?: SwarmSummary;
  swarmPacket?: SwarmPacket;
  version: number;
}

/* ── Build query string from filters ── */
function buildQuery(filters: KanbanFilters): string {
  const p = new URLSearchParams();
  if (filters.q) p.set('q', filters.q);
  for (const pr of filters.priority) p.append('priority[]', pr);
  if (filters.assignee) p.set('assignee', filters.assignee);
  for (const l of filters.labels) p.append('label', l);
  p.set('limit', '200');
  return p.toString();
}

function hasActiveFilters(filters: KanbanFilters): boolean {
  return Boolean(filters.q || filters.priority.length > 0 || filters.assignee || filters.labels.length > 0);
}

const PRIORITY_ORDER: Record<TaskPriority, number> = { critical: 0, high: 1, normal: 2, low: 3 };
export function compareTaskPriority(a: KanbanTask, b: KanbanTask): number {
  return PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || a.columnOrder - b.columnOrder;
}

/* ── Board config ── */
export interface BoardColumnConfig {
  key: string;
  title: string;
  wipLimit?: number;
  visible: boolean;
}

export interface BoardConfig {
  columns: BoardColumnConfig[];
  defaults: { status: string; priority: string };
  reviewRequired: boolean;
  allowDoneDragBypass: boolean;
  quickViewLimit: number;
  proposalPolicy: 'confirm' | 'auto';
}

/* ── Hook ── */
export function useKanban() {
  const [tasks, setTasks] = useState<KanbanTask[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<KanbanFilters>(EMPTY_FILTERS);
  const [boardConfig, setBoardConfig] = useState<BoardConfig | null>(null);
  const [archivedTasks, setArchivedTasks] = useState<KanbanTask[]>([]);
  const [archiveLoaded, setArchiveLoaded] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const refreshInFlightRef = useRef(false);
  const listRetryAtRef = useRef(0);
  const mutationRevisionRef = useRef(0);

  /* ── Fetch board config (columns are user-configurable) ── */
  useEffect(() => {
    fetch('/api/kanban/config')
      .then(r => r.ok ? r.json() : null)
      .then((cfg: BoardConfig | null) => { if (cfg) setBoardConfig(cfg); })
      .catch(() => {/* fallback to COLUMNS default */});
  }, []);

  /** Visible columns in display order, derived from board config when available. */
  const boardColumns = useMemo((): TaskStatus[] => {
    if (!boardConfig) return COLUMNS;
    return boardConfig.columns.filter(c => c.visible).map(c => c.key);
  }, [boardConfig]);

  /* ── Fetch ── */

  const fetchTasks = useCallback(async (f?: KanbanFilters, { silent = false, force = false }: { silent?: boolean; force?: boolean } = {}) => {
    if (Date.now() < listRetryAtRef.current) return;
    if (silent && !force && refreshInFlightRef.current) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    const revision = mutationRevisionRef.current;
    abortRef.current = controller;
    refreshInFlightRef.current = true;
    if (!silent) {
      setLoading(true);
      setError(null);
    }
    try {
      const effectiveFilters = f ?? filters;
      const qs = new URLSearchParams(buildQuery(effectiveFilters));
      if (!hasActiveFilters(effectiveFilters)) {
        for (const status of BOARD_LOAD_ORDER) qs.append('status', status);
      }
      const items: KanbanTask[] = [];
      let count = 0;
      let more = true;
      while (more) {
        qs.set('offset', String(items.length));
        const res = await fetch(`/api/kanban/tasks?${qs}`, { signal: controller.signal });
        if (controller.signal.aborted || revision !== mutationRevisionRef.current) return;
        if (!res.ok) {
          if (res.status === 429) {
            const retry = res.headers.get('Retry-After');
            const seconds = Number(retry);
            listRetryAtRef.current = Date.now() + (retry && Number.isFinite(seconds) ? Math.max(1, seconds) * 1000 : 60_000);
          }
          throw new Error(`HTTP ${res.status}`);
        }
        const data: TasksResponse = await res.json();
        items.push(...data.items);
        count = data.total;
        more = data.hasMore && data.items.length > 0;
      }
      // A list requested before a move must never replace its newer version.
      if (controller.signal.aborted || revision !== mutationRevisionRef.current) return;
      setTasks(items);
      setTotal(count);
      setError(null);
    } catch (err: unknown) {
      if (controller.signal.aborted) return;
      if (!silent) setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        refreshInFlightRef.current = false;
        if (!silent) setLoading(false);
      }
    }
  }, [filters]);

  const fetchArchive = useCallback(async () => {
    const res = await fetch('/api/kanban/archive');
    if (!res.ok) return;
    const data: ArchiveResponse = await res.json();
    setArchivedTasks(data.items);
    setArchiveLoaded(true);
  }, []);

  /* Initial fetch + refetch on filter change */
  useEffect(() => {
    fetchTasks(filters);
    return () => abortRef.current?.abort();
  }, [filters, fetchTasks]);

  /* Refresh visible boards without multiplying requests by the number of columns. */
  useEffect(() => {
    const id = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      void fetchTasks(undefined, { silent: true });
    }, 15_000);
    return () => clearInterval(id);
  }, [fetchTasks]);

  /* ── Mutations ── */
  const createTask = useCallback(async (payload: CreateTaskPayload): Promise<KanbanTask> => {
    const res = await fetch('/api/kanban/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.details || body.error || `HTTP ${res.status}`);
    }
    const created: KanbanTask = await res.json();
    // Refetch to get accurate ordering
    await fetchTasks();
    return created;
  }, [fetchTasks]);

  const updateTask = useCallback(async (id: string, payload: UpdateTaskPayload): Promise<KanbanTask> => {
    const res = await fetch(`/api/kanban/tasks/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      if (res.status === 409) {
        const err = new Error('version_conflict');
        (err as VersionConflictError).latest = body.latest;
        throw err;
      }
      throw new Error(body.details || body.error || `HTTP ${res.status}`);
    }
    const updated: KanbanTask = await res.json();
    await fetchTasks();
    return updated;
  }, [fetchTasks]);

  /** Reorder / move a task via the dedicated reorder endpoint. */
  const reorderTask = useCallback(async (
    id: string,
    version: number,
    targetStatus: TaskStatus,
    targetIndex: number,
  ): Promise<KanbanTask> => {
    mutationRevisionRef.current += 1;
    abortRef.current?.abort();
    const res = await fetch(`/api/kanban/tasks/${encodeURIComponent(id)}/reorder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version, targetStatus, targetIndex }),
    });
    mutationRevisionRef.current += 1;
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      if (res.status === 409) {
        if (body.latest) setTasks(prev => prev.map(task => task.id === id ? body.latest : task));
        void fetchTasks(undefined, { silent: true, force: true });
        const err: VersionConflictError = new Error('version_conflict');
        err.latest = body.latest;
        throw err;
      }
      throw new Error(body.details || body.error || `HTTP ${res.status}`);
    }
    const updated: KanbanTask = await res.json();
    setTasks(prev => prev.map(task => task.id === id ? updated : task));
    void fetchTasks(undefined, { silent: true, force: true });
    return updated;
  }, [fetchTasks]);

  /** Optimistic state updater for drag-and-drop — applies immediately, no API call. */
  const setTasksOptimistic = useCallback((updater: (prev: KanbanTask[]) => KanbanTask[]) => {
    setTasks(updater);
  }, []);

  /** Root tasks power the board lanes; subtasks stay attached to their parent folder. */
  const rootTasks = useMemo(() => tasks.filter((task) => !task.parentTaskId), [tasks]);

  const deleteTask = useCallback(async (id: string): Promise<void> => {
    const res = await fetch(`/api/kanban/tasks/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.details || body.error || `HTTP ${res.status}`);
    }
    await fetchTasks();
  }, [fetchTasks]);

  /* ── Workflow mutations ── */

  const executeTask = useCallback(async (id: string, options?: { model?: string; thinking?: string }): Promise<KanbanTask> => {
    const res = await fetch(`/api/kanban/tasks/${encodeURIComponent(id)}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(options ?? {}),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.details || body.error || `HTTP ${res.status}`);
    }
    const task: KanbanTask = await res.json();
    await fetchTasks(undefined, { silent: true });
    return task;
  }, [fetchTasks]);

  const approveTask = useCallback(async (id: string, note?: string): Promise<KanbanTask> => {
    const res = await fetch(`/api/kanban/tasks/${encodeURIComponent(id)}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(note ? { note } : {}),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.details || body.error || `HTTP ${res.status}`);
    }
    const task: KanbanTask = await res.json();
    await fetchTasks(undefined, { silent: true });
    return task;
  }, [fetchTasks]);

  const rejectTask = useCallback(async (id: string, note: string): Promise<KanbanTask> => {
    const res = await fetch(`/api/kanban/tasks/${encodeURIComponent(id)}/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.details || body.error || `HTTP ${res.status}`);
    }
    const task: KanbanTask = await res.json();
    await fetchTasks(undefined, { silent: true });
    return task;
  }, [fetchTasks]);

  const abortTask = useCallback(async (id: string, note?: string): Promise<KanbanTask> => {
    const res = await fetch(`/api/kanban/tasks/${encodeURIComponent(id)}/abort`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(note ? { note } : {}),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.details || body.error || `HTTP ${res.status}`);
    }
    const task: KanbanTask = await res.json();
    await fetchTasks(undefined, { silent: true });
    return task;
  }, [fetchTasks]);

  const archiveDoneTasks = useCallback(async (): Promise<KanbanTask[]> => {
    const res = await fetch('/api/kanban/archive', { method: 'POST' });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.details || body.error || `HTTP ${res.status}`);
    }
    const data: { archived: KanbanTask[] } = await res.json();
    await Promise.all([fetchTasks(undefined, { silent: true }), fetchArchive()]);
    return data.archived;
  }, [fetchArchive, fetchTasks]);

  const restoreArchivedTask = useCallback(async (id: string): Promise<KanbanTask> => {
    const res = await fetch(`/api/kanban/archive/${encodeURIComponent(id)}/restore`, { method: 'POST' });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.details || body.error || `HTTP ${res.status}`);
    }
    const task: KanbanTask = await res.json();
    await Promise.all([fetchTasks(undefined, { silent: true }), fetchArchive()]);
    return task;
  }, [fetchArchive, fetchTasks]);

  /* ── Helpers ── */
  const tasksByStatusMap = useMemo(() => {
    const map = new Map<TaskStatus, KanbanTask[]>();
    for (const t of rootTasks) {
      let list = map.get(t.status);
      if (!list) { list = []; map.set(t.status, list); }
      list.push(t);
    }
    for (const list of map.values()) list.sort(compareTaskPriority);
    return map;
  }, [rootTasks]);

  const tasksByStatus = useCallback((status: TaskStatus): KanbanTask[] => {
    return tasksByStatusMap.get(status) ?? [];
  }, [tasksByStatusMap]);

  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const t of rootTasks) counts[t.status] = (counts[t.status] || 0) + 1;
    return counts;
  }, [rootTasks]);

  return {
    tasks,
    rootTasks,
    setTasks,
    total,
    loading,
    error,
    filters,
    setFilters,
    fetchTasks,
    createTask,
    updateTask,
    deleteTask,
    reorderTask,
    setTasksOptimistic,
    tasksByStatus,
    statusCounts,
    boardColumns,
    boardConfig,
    archivedTasks,
    archiveLoaded,
    fetchArchive,
    archiveDoneTasks,
    restoreArchivedTask,
    executeTask,
    approveTask,
    rejectTask,
    abortTask,
  };
}
