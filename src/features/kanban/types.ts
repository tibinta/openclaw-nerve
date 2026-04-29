// Kanban type contracts — Frozen v1
// Change policy: coordinator approval + issue-file sync required.

/** Built-in status keys shipped with the default board config. */
export const BUILT_IN_STATUSES = ['backlog', 'todo', 'in-progress', 'review', 'done', 'cancelled'] as const;
export type BuiltInStatus = typeof BUILT_IN_STATUSES[number];

/**
 * TaskStatus is a plain string so custom column keys are supported.
 * The board config (from /api/kanban/config) is the canonical source of truth
 * for which statuses are valid and how columns are ordered.
 */
export type TaskStatus = string;
export type TaskPriority = 'critical' | 'high' | 'normal' | 'low';

/**
 * Default column display order used as a fallback before the board config loads.
 * Consumers should prefer `config.columns` from useKanban() over this constant.
 */
export const COLUMNS: TaskStatus[] = ['backlog', 'todo', 'in-progress', 'review', 'done'];

/** Split-lane workflow groups used by the redesigned tasks view. */
export const WORKFLOW_QUEUE_STATUSES = ['backlog', 'todo'] as const;
export const WORKFLOW_ACTIVE_STATUSES = ['in-progress', 'review'] as const;
export const WORKFLOW_VISIBLE_STATUSES = [
  ...WORKFLOW_QUEUE_STATUSES,
  ...WORKFLOW_ACTIVE_STATUSES,
] as const;

export const WORKFLOW_LANES = [
  { key: 'queue', title: 'Queue', statuses: WORKFLOW_QUEUE_STATUSES },
  { key: 'active', title: 'Active', statuses: WORKFLOW_ACTIVE_STATUSES },
  { key: 'archive', title: 'Archive', statuses: ['done'] as const },
] as const;

/** Human-readable labels for built-in columns. Custom columns use their `title` from config. */
export const COLUMN_LABELS: Record<string, string> = {
  backlog: 'Backlog',
  todo: 'To Do',
  'in-progress': 'In Progress',
  review: 'Review',
  done: 'Done',
  cancelled: 'Cancelled',
};
export type TaskActor = 'operator' | `agent:${string}`;
export type DelegationVerdict = 'pass' | 'blocked' | 'fail';

export interface DelegationProofActor {
  agentId: string;
  sessionKey: string;
  verdict: DelegationVerdict;
  at: number;
  summary: string;
  evidence_links?: string[];
}

export interface DelegationProof {
  packetId: string;
  worker?: DelegationProofActor;
  checker?: DelegationProofActor;
  blocker?: string;
}

export interface TaskFeedback {
  at: number;
  by: TaskActor;
  note: string;
}

export interface TaskRunLink {
  sessionKey: string;
  sessionId?: string;
  runId?: string;
  startedAt: number;
  endedAt?: number;
  status: 'running' | 'done' | 'error' | 'aborted';
  error?: string;
}

export interface KanbanTask {
  id: string;
  title: string;
  description?: string;
  status: TaskStatus;
  priority: TaskPriority;
  createdBy: TaskActor;
  createdAt: number;
  updatedAt: number;
  version: number;
  sourceSessionKey?: string;
  assignee?: TaskActor;
  labels: string[];
  columnOrder: number;
  run?: TaskRunLink;
  result?: string;
  resultAt?: number;
  model?: string;
  thinking?: 'off' | 'low' | 'medium' | 'high';
  dueAt?: number;
  estimateMin?: number;
  actualMin?: number;
  feedback: TaskFeedback[];
  evidence_links?: string[];
  proof_gate?: {
    reindex_verified: boolean;
    read_back_verified: boolean;
    live_link_or_canvas_checked: boolean;
    proof_log_updated: boolean;
  };
  delegation_proof?: DelegationProof;
}
