import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import {
  X, Plus, Play, CheckCircle2, XCircle, Trash2, Save, Loader2,
  Clock, User, Tag, AlertTriangle, MessageSquare, StopCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useSessionContext } from '@/contexts/SessionContext';
import { formatDateTime } from '@/lib/formatting';
import { COLUMN_LABELS, type DelegationProof, type DelegationProofActor, type KanbanTask, type TaskStatus, type TaskPriority } from './types';
import type { UpdateTaskPayload, VersionConflictError } from './hooks/useKanban';
import { AssigneeCombobox } from './components/AssigneeCombobox';
import { buildAssigneeOptionsForEdit } from './lib/assigneeOptions';
import { getTaskPriorityLabel, getTaskPriorityTone, getTaskRunTone, getTaskStatusTone, getTaskPriority, getTaskStatus } from './tone';

/* ── Elapsed time helper ── */
function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m ${rs}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h ${rm}m`;
}

function RunElapsed({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <span className="text-[0.667rem] text-muted-foreground tabular-nums">
      {formatElapsed(now - startedAt)}
    </span>
  );
}

function stripAgentPrefix(value?: string | null): string {
  return value?.startsWith('agent:') ? value.slice('agent:'.length) : value || '';
}

function defaultCheckerFor(workerAgentId: string): string {
  return workerAgentId === 'hannah-clark---validation-lead'
    ? 'ruby-young---qa'
    : 'hannah-clark---validation-lead';
}

function buildProofActor(params: {
  agentId: string;
  role: 'worker' | 'checker';
  taskTitle: string;
  sessionKey?: string;
  evidenceLinks: string[];
}): DelegationProofActor {
  const cleanAgentId = stripAgentPrefix(params.agentId);
  const summary = params.role === 'worker'
    ? `Worker proof recorded: ${params.taskTitle} is complete and the attached evidence was produced or verified.`
    : `Checker proof recorded: ${params.taskTitle} passed validation against the attached evidence.`;
  return {
    agentId: cleanAgentId,
    sessionKey: params.sessionKey || `agent:${cleanAgentId}:manual-ui-proof`,
    verdict: 'pass',
    at: Date.now(),
    summary,
    evidence_links: params.evidenceLinks,
  };
}

interface TaskDetailDrawerProps {
  task: KanbanTask | null;
  onClose: () => void;
  onUpdate: (id: string, payload: UpdateTaskPayload) => Promise<KanbanTask>;
  onDelete: (id: string) => Promise<void>;
  parentTask?: KanbanTask | null;
  subtasks?: KanbanTask[];
  onOpenRelatedTask?: (task: KanbanTask) => void;
  onCreateSubtask?: () => void;
  onExecute?: (id: string, options?: { model?: string; thinking?: string }) => Promise<KanbanTask>;
  onApprove?: (id: string, note?: string) => Promise<KanbanTask>;
  onReject?: (id: string, note: string) => Promise<KanbanTask>;
  onAbort?: (id: string, note?: string) => Promise<KanbanTask>;
}

export function TaskDetailDrawer({
  task,
  onClose,
  onUpdate,
  onDelete,
  parentTask = null,
  subtasks = [],
  onOpenRelatedTask,
  onCreateSubtask,
  onExecute,
  onApprove,
  onReject,
  onAbort,
}: TaskDetailDrawerProps) {
  const { sessions, agentName } = useSessionContext();
  const [editTitle, setEditTitle] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editStatus, setEditStatus] = useState<TaskStatus>('todo');
  const [editPriority, setEditPriority] = useState<TaskPriority>('normal');
  const [editLabels, setEditLabels] = useState('');
  const [editAssignee, setEditAssignee] = useState('');
  const [editVersion, setEditVersion] = useState(0);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [proofPanelOpen, setProofPanelOpen] = useState(false);
  const [delegationProofState, setDelegationProofState] = useState<DelegationProof | undefined>(undefined);
  const drawerRef = useRef<HTMLDivElement>(null);

  /* Populate fields when task changes */
  useEffect(() => {
    if (task) {
      setEditTitle(task.title);
      setEditDescription(task.description || '');
      setEditStatus(getTaskStatus(task.status));
      setEditPriority(getTaskPriority(task.priority));
      setEditLabels(task.labels.join(', '));
      setEditAssignee(task.assignee || '');
      setEditProofUrl((task.evidence_links ?? [])[0] ?? '');
      setProofLinks(task.evidence_links ?? []);
      setDelegationProofState(task.delegation_proof);
      setProofPanelOpen(task.status === 'review');
      setGateState({
        reindex_verified: task.proof_gate?.reindex_verified === true,
        read_back_verified: task.proof_gate?.read_back_verified === true,
        live_link_or_canvas_checked: task.proof_gate?.live_link_or_canvas_checked === true,
        proof_log_updated: task.proof_gate?.proof_log_updated === true,
      });
      setEditVersion(task.version);
      setError(null);
      setDirty(false);
      setConfirmDelete(false);
    }
  }, [task]);

  /* Safe close — warn on unsaved changes */
  const safeClose = useCallback(() => {
    if (dirty && !window.confirm('You have unsaved changes. Discard?')) return;
    onClose();
  }, [dirty, onClose]);

  /* Close on Escape */
  useEffect(() => {
    if (!task) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') safeClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [task, safeClose]);

  const markDirty = useCallback(() => setDirty(true), []);

  const handleSave = useCallback(async () => {
    if (!task || saving) return;
    setSaving(true);
    setError(null);
    try {
      const labels = editLabels
        .split(',')
        .map(l => l.trim())
        .filter(Boolean);
      await onUpdate(task.id, {
        title: editTitle.trim(),
        description: editDescription.trim() || null,
        status: editStatus,
        priority: editPriority,
        labels,
        assignee: editAssignee.trim() || null,
        version: editVersion,
      });
      setDirty(false);
    } catch (err) {
      if (err instanceof Error && err.message === 'version_conflict') {
        const latest = (err as VersionConflictError).latest;
        if (latest) {
          // Refresh drawer fields with latest server state so user can retry
          setEditTitle(latest.title);
          setEditDescription(latest.description || '');
          setEditStatus(getTaskStatus(latest.status));
          setEditPriority(getTaskPriority(latest.priority));
          setEditLabels(latest.labels.join(', '));
          setEditAssignee(latest.assignee || '');
          setEditVersion(latest.version);
        }
        setError('Task was modified elsewhere. Fields refreshed to latest version -- review and save again.');
        setDirty(false);
      } else {
        setError(err instanceof Error ? err.message : 'Save failed');
      }
    } finally {
      setSaving(false);
    }
  }, [task, saving, editTitle, editDescription, editStatus, editPriority, editLabels, editAssignee, editVersion, onUpdate]);

  const [confirmDelete, setConfirmDelete] = useState(false);

  const handleDelete = useCallback(async () => {
    if (!task || deleting) return;
    setDeleting(true);
    try {
      await onDelete(task.id);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setDeleting(false);
      setConfirmDelete(false);
    }
  }, [task, deleting, onDelete, onClose]);

  /* ── Workflow action state ── */
  const [workflowLoading, setWorkflowLoading] = useState<string | null>(null);
  const [rejectNote, setRejectNote] = useState('');
  const [showRejectInput, setShowRejectInput] = useState(false);
  const [editProofUrl, setEditProofUrl] = useState('');
  const [proofLinks, setProofLinks] = useState<string[]>([]);
  const [gateState, setGateState] = useState({
    reindex_verified: false,
    read_back_verified: false,
    live_link_or_canvas_checked: false,
    proof_log_updated: false,
  });

  const handleExecute = useCallback(async () => {
    if (!task || !onExecute || workflowLoading) return;
    setWorkflowLoading('execute');
    setError(null);
    try {
      await onExecute(task.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Execute failed');
    } finally {
      setWorkflowLoading(null);
    }
  }, [task, onExecute, workflowLoading]);

  const handleAddProof = useCallback(async () => {
    if (!task || workflowLoading) return;
    const trimmed = editProofUrl.trim();
    if (!trimmed) return;
    const nextEvidence = Array.from(new Set([...(task.evidence_links ?? []), trimmed]));
    setWorkflowLoading('proof');
    setError(null);
    try {
      const updated = await onUpdate(task.id, { version: editVersion, evidence_links: nextEvidence });
      setEditVersion(updated.version);
      setEditProofUrl('');
      setProofLinks(updated.evidence_links ?? nextEvidence);
      setDirty(false);
      return updated;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Add proof failed');
      throw err;
    } finally {
      setWorkflowLoading(null);
    }
  }, [task, workflowLoading, editProofUrl, onUpdate, editVersion]);

  const isDelegatedTask = task?.assignee?.startsWith('agent:') ?? false;
  const delegationProof = delegationProofState ?? task?.delegation_proof;
  const proofGateReady = proofLinks.length > 0
    && gateState.reindex_verified
    && gateState.read_back_verified
    && gateState.live_link_or_canvas_checked
    && gateState.proof_log_updated;
  const delegationProofReady = Boolean(
    delegationProof?.packetId?.trim()
    && delegationProof.worker?.verdict === 'pass'
    && delegationProof.checker?.verdict === 'pass'
    && delegationProof.worker.agentId !== delegationProof.checker.agentId,
  );
  const readyToClose = proofGateReady && (!isDelegatedTask || delegationProofReady);
  const swarmSummary = task?.swarmSummary;
  const swarmPacket = task?.swarmPacket;
  const swarmReadyToClose = Boolean(
    swarmSummary
    && swarmSummary.packetsTotal > 0
    && swarmSummary.packetsPassed === swarmSummary.packetsTotal
    && swarmSummary.packetsBlocked === 0,
  );
  const runTone = task?.run?.status ? getTaskRunTone(task.run.status) : null;

  const canApprove = task?.status === 'review' && readyToClose;


  useEffect(() => {
    if (!task || task.status !== 'review') return;
    setProofPanelOpen(true);
    setProofLinks(task.evidence_links ?? []);
    setGateState({
      reindex_verified: task.proof_gate?.reindex_verified === true,
      read_back_verified: task.proof_gate?.read_back_verified === true,
      live_link_or_canvas_checked: task.proof_gate?.live_link_or_canvas_checked === true,
      proof_log_updated: task.proof_gate?.proof_log_updated === true,
    });
  }, [task?.id, task?.updatedAt, task?.version, task?.evidence_links, task?.proof_gate]);

  const handleProofGateUpdate = useCallback((key: keyof typeof gateState, checked: boolean) => {
    if (!task) return;
    const nextGate = {
      ...gateState,
      [key]: checked,
    };
    setGateState(nextGate);
    void onUpdate(task.id, { version: editVersion, proof_gate: nextGate })
      .then((updated) => {
        setEditVersion(updated.version);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Proof gate update failed');
      });
    markDirty();
  }, [task, gateState, onUpdate, editVersion, markDirty]);

  const handleDelegationProofPass = useCallback(async (role: 'worker' | 'checker') => {
    if (!task || workflowLoading) return;
    const currentProof = delegationProof;
    const workerAgentId = stripAgentPrefix(currentProof?.worker?.agentId || task.assignee || 'charlotte-price---operations-director');
    const checkerAgentId = stripAgentPrefix(currentProof?.checker?.agentId || defaultCheckerFor(workerAgentId));
    const nextEvidence = proofLinks.length ? proofLinks : (task.evidence_links ?? []);
    const nextProof: DelegationProof = {
      packetId: currentProof?.packetId || `packet://${task.id}`,
      worker: currentProof?.worker,
      checker: currentProof?.checker,
      blocker: currentProof?.blocker,
    };

    if (role === 'worker') {
      nextProof.worker = buildProofActor({
        agentId: workerAgentId,
        role: 'worker',
        taskTitle: task.title,
        sessionKey: currentProof?.worker?.sessionKey,
        evidenceLinks: nextEvidence,
      });
    } else {
      const safeCheckerId = checkerAgentId === workerAgentId ? defaultCheckerFor(workerAgentId) : checkerAgentId;
      nextProof.checker = buildProofActor({
        agentId: safeCheckerId,
        role: 'checker',
        taskTitle: task.title,
        sessionKey: currentProof?.checker?.sessionKey,
        evidenceLinks: nextEvidence,
      });
    }

    setWorkflowLoading(role === 'worker' ? 'worker-proof' : 'checker-proof');
    setError(null);
    try {
      const updated = await onUpdate(task.id, {
        version: editVersion,
        delegation_proof: nextProof,
      });
      setEditVersion(updated.version);
      setDelegationProofState(updated.delegation_proof ?? nextProof);
      setDirty(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Proof update failed');
    } finally {
      setWorkflowLoading(null);
    }
  }, [task, workflowLoading, proofLinks, onUpdate, editVersion, delegationProof]);

  const handleApprove = useCallback(async () => {
    if (!task || !onApprove || workflowLoading) return;
    setWorkflowLoading('approve');
    setError(null);
    try {
      await onApprove(task.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Approve failed');
    } finally {
      setWorkflowLoading(null);
    }
  }, [task, onApprove, workflowLoading]);

  const handleReject = useCallback(async () => {
    if (!task || !onReject || workflowLoading) return;
    if (!showRejectInput) {
      setShowRejectInput(true);
      return;
    }
    if (!rejectNote.trim()) return;
    setWorkflowLoading('reject');
    setError(null);
    try {
      await onReject(task.id, rejectNote.trim());
      setShowRejectInput(false);
      setRejectNote('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Reject failed');
    } finally {
      setWorkflowLoading(null);
    }
  }, [task, onReject, workflowLoading, showRejectInput, rejectNote]);


  const handleAbort = useCallback(async () => {
    if (!task || !onAbort || workflowLoading) return;
    setWorkflowLoading('abort');
    setError(null);
    try {
      await onAbort(task.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Abort failed');
    } finally {
      setWorkflowLoading(null);
    }
  }, [task, onAbort, workflowLoading]);

  /* Reset reject input when task changes */
  useEffect(() => {
    setShowRejectInput(false);
    setRejectNote('');
    setWorkflowLoading(null);
  }, [task?.id]);

  const isOpen = task !== null;
  const assigneeOptions = useMemo(
    () => buildAssigneeOptionsForEdit(sessions, task?.assignee ?? null, agentName),
    [agentName, sessions, task?.assignee],
  );

  const selectClass = 'cockpit-select h-11 text-sm';
  const priorityTone = task ? getTaskPriorityTone(editPriority) : null;

  return (
    <>
      {/* Backdrop */}
      {isOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/40 transition-opacity duration-200"
          onClick={safeClose}
        />
      )}

      {/* Drawer */}
      <div
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-label="Task details"
        className={`shell-panel fixed top-0 right-0 z-50 flex h-full w-[min(92vw,520px)] max-w-full flex-col overflow-hidden rounded-l-[32px] border-l border-border/70 shadow-[0_28px_72px_rgba(0,0,0,0.36)] transition-transform duration-[220ms] ease-[cubic-bezier(0.22,1,0.36,1)] ${
          isOpen ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        {task && (
          <>
            <div className="panel-header min-h-[56px] justify-between gap-3 px-4">
              <div className="flex items-center gap-2 min-w-0">
                <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[0.667rem] font-semibold ${getTaskStatusTone(task.status).badgeClass}`}>
                  {COLUMN_LABELS[task.status as keyof typeof COLUMN_LABELS] ?? 'Task'}
                </span>
                <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[0.667rem] font-semibold ${priorityTone?.badgeClass ?? ''}`}>
                  {getTaskPriorityLabel(editPriority)}
                </span>
              </div>
              <button
                onClick={safeClose}
                className="shell-icon-button size-9 px-0"
                aria-label="Close drawer"
              >
                <X size={16} />
              </button>
            </div>

            <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
              {error && (
                <div className="cockpit-note flex items-center gap-2 text-sm" data-tone="danger">
                  <AlertTriangle size={12} />
                  {error}
                </div>
              )}

              <div className="cockpit-surface p-4 space-y-4">
                <div>
                  <label htmlFor="kb-title" className="cockpit-field-label mb-2 block">
                    Title
                  </label>
                  <Input
                    id="kb-title"
                    value={editTitle}
                    onChange={e => { setEditTitle(e.target.value); markDirty(); }}
                    maxLength={500}
                    className="cockpit-input h-11 text-sm font-semibold"
                  />
                </div>

                <div>
                  <label htmlFor="kb-description" className="cockpit-field-label mb-2 block">
                    Description
                  </label>
                  <textarea
                    id="kb-description"
                    value={editDescription}
                    onChange={e => { setEditDescription(e.target.value); markDirty(); }}
                    placeholder="Markdown description…"
                    rows={8}
                    className="cockpit-textarea min-h-[180px]"
                  />
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label htmlFor="kb-status" className="cockpit-field-label mb-2 block">
                      Status
                    </label>
                    <select
                      id="kb-status"
                      value={editStatus}
                      onChange={e => { setEditStatus(e.target.value as TaskStatus); markDirty(); }}
                      className={selectClass}
                    >
                      {Object.entries(COLUMN_LABELS).map(([val, label]) => (
                        <option key={val} value={val}>{label}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label htmlFor="kb-priority" className="cockpit-field-label mb-2 block">
                      Priority
                    </label>
                    <select
                      id="kb-priority"
                      value={editPriority}
                      onChange={e => { setEditPriority(getTaskPriority(e.target.value)); markDirty(); }}
                      className={selectClass}
                    >
                      {(['critical', 'high', 'normal', 'low'] as TaskPriority[]).map(p => (
                        <option key={p} value={p}>{getTaskPriorityLabel(p)}</option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label htmlFor="kb-labels" className="cockpit-field-label mb-2 block">
                      <Tag size={10} className="mr-1 inline" />
                      Labels
                    </label>
                    <Input
                      id="kb-labels"
                      value={editLabels}
                      onChange={e => { setEditLabels(e.target.value); markDirty(); }}
                      placeholder="bug, urgent"
                      className="cockpit-input h-11"
                    />
                  </div>
                  <div>
                    <label htmlFor="kb-assignee" className="cockpit-field-label mb-2 block">
                      <User size={10} className="mr-1 inline" />
                      Assignee
                    </label>
                    <AssigneeCombobox
                      id="kb-assignee"
                      value={editAssignee}
                      onChange={(nextValue) => { setEditAssignee(nextValue); markDirty(); }}
                      options={assigneeOptions}
                      ariaLabel="Assignee"
                      placeholder="Select assignee"
                      noResultsText="No matching assignees"
                      inline
                    />
                  </div>
                </div>
              </div>

              <div className="cockpit-note space-y-2">
                <h4 className="cockpit-field-label">Metadata</h4>
                <div className="space-y-1 text-[0.733rem] text-muted-foreground">
                  {parentTask && (
                    <button
                      type="button"
                      onClick={() => onOpenRelatedTask?.(parentTask)}
                      className="flex w-full items-center gap-1.5 rounded-xl border border-transparent px-0 py-0 text-left text-[0.733rem] text-muted-foreground transition-colors hover:text-foreground"
                    >
                      <span className="shrink-0">Parent:</span>
                      <span className="truncate font-medium text-foreground/80">{parentTask.title}</span>
                    </button>
                  )}
                  {task.parentTaskId && !parentTask && (
                    <div className="flex items-center gap-1.5">
                      <span>Parent:</span>
                      <code className="cockpit-kbd text-[0.667rem]">{task.parentTaskId}</code>
                    </div>
                  )}
                  <div className="flex items-center gap-1.5">
                    <Clock size={10} />
                    Created: {formatDateTime(task.createdAt)}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Clock size={10} />
                    Updated: {formatDateTime(task.updatedAt)}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <User size={10} />
                    By: {task.createdBy === 'operator' ? 'Operator' : task.createdBy}
                  </div>
                </div>
              </div>

              <div className="cockpit-note space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <h4 className="cockpit-field-label">Subtasks</h4>
                  {onCreateSubtask && (
                    <Button size="xs" variant="outline" onClick={onCreateSubtask}>
                      <Plus size={11} />
                      Add
                    </Button>
                  )}
                </div>
                {subtasks.length === 0 ? (
                  <p className="text-[0.733rem] text-muted-foreground">
                    No subtasks yet.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {subtasks.map((subtask) => {
                      const statusTone = getTaskStatusTone(subtask.status);
                      return (
                        <button
                          key={subtask.id}
                          type="button"
                          onClick={() => onOpenRelatedTask?.(subtask)}
                          className="group flex w-full items-start justify-between gap-3 rounded-2xl border border-border/60 bg-background/45 px-3 py-2 text-left transition-colors hover:border-primary/24 hover:bg-primary/[0.04]"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-[0.8rem] font-medium text-foreground group-hover:text-foreground">
                              {subtask.title}
                            </div>
                            {subtask.description && (
                              <p className="mt-0.5 line-clamp-1 text-[0.667rem] text-muted-foreground">
                                {subtask.description}
                              </p>
                            )}
                          </div>
                          <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[0.667rem] font-semibold ${statusTone.badgeClass}`}>
                            {COLUMN_LABELS[subtask.status as keyof typeof COLUMN_LABELS] ?? subtask.status}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              {(swarmSummary || swarmPacket) && (
                <div className="cockpit-note space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <h4 className="cockpit-field-label">Swarm</h4>
                    <span className={swarmReadyToClose || swarmPacket?.packetStatus === 'passed' ? 'text-[0.733rem] text-green' : 'text-[0.733rem] text-muted-foreground'}>
                      {swarmReadyToClose || swarmPacket?.packetStatus === 'passed' ? 'Ready to close' : 'Missing proof'}
                    </span>
                  </div>
                  {swarmSummary && (
                    <div className="grid grid-cols-2 gap-2 text-[0.733rem] sm:grid-cols-4">
                      <div className="rounded-xl border border-border/55 bg-background/45 px-3 py-2">
                        <div className="text-muted-foreground">Packets</div>
                        <div className="font-semibold text-foreground">{swarmSummary.packetsTotal}</div>
                      </div>
                      <div className="rounded-xl border border-border/55 bg-background/45 px-3 py-2">
                        <div className="text-muted-foreground">Running</div>
                        <div className="font-semibold text-foreground">{swarmSummary.packetsRunning}</div>
                      </div>
                      <div className="rounded-xl border border-border/55 bg-background/45 px-3 py-2">
                        <div className="text-muted-foreground">Passed</div>
                        <div className="font-semibold text-foreground">{swarmSummary.packetsPassed}</div>
                      </div>
                      <div className="rounded-xl border border-border/55 bg-background/45 px-3 py-2">
                        <div className="text-muted-foreground">Blocked</div>
                        <div className="font-semibold text-foreground">{swarmSummary.packetsBlocked}</div>
                      </div>
                    </div>
                  )}
                  {swarmPacket && (
                    <div className="space-y-2 text-[0.733rem]">
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        <div className="rounded-xl border border-border/55 bg-background/45 px-3 py-2">
                          <div className="text-muted-foreground">Packet</div>
                          <div className="break-all font-semibold text-foreground">{swarmPacket.packetId}</div>
                        </div>
                        <div className="rounded-xl border border-border/55 bg-background/45 px-3 py-2">
                          <div className="text-muted-foreground">Status</div>
                          <div className="font-semibold text-foreground">{swarmPacket.packetStatus}</div>
                        </div>
                        <div className="rounded-xl border border-border/55 bg-background/45 px-3 py-2">
                          <div className="text-muted-foreground">Owner</div>
                          <div className="break-all text-foreground">{swarmPacket.ownerAgentId}</div>
                        </div>
                        <div className="rounded-xl border border-border/55 bg-background/45 px-3 py-2">
                          <div className="text-muted-foreground">Checker</div>
                          <div className="break-all text-foreground">{swarmPacket.checkerAgentId}</div>
                        </div>
                      </div>
                      <div className="rounded-xl border border-border/55 bg-background/45 px-3 py-2">
                        <div className="text-muted-foreground">Evidence path</div>
                        <div className="break-all text-foreground">{swarmPacket.evidencePath}</div>
                      </div>
                      {swarmPacket.childSessionKey && (
                        <div className="rounded-xl border border-border/55 bg-background/45 px-3 py-2">
                          <div className="text-muted-foreground">Session key</div>
                          <div className="break-all text-foreground">{swarmPacket.childSessionKey}</div>
                        </div>
                      )}
                      {swarmPacket.error && (
                        <div className="rounded-xl border border-destructive/25 bg-destructive/8 px-3 py-2">
                          <div className="text-muted-foreground">Blocker</div>
                          <div className="break-words text-destructive">{swarmPacket.error}</div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {task.run && (
                <div className="cockpit-note space-y-2">
                  <h4 className="cockpit-field-label">Agent Run</h4>
                  <div className="space-y-1.5 text-[0.733rem] text-muted-foreground">
                    <div className="flex items-center gap-2">
                      {task.run.status && runTone ? (
                        <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[0.667rem] font-semibold ${runTone.badgeClass}`}>
                          {task.run.status === 'running' && <Loader2 size={9} className="animate-spin" />}
                          {task.run.status.charAt(0).toUpperCase() + task.run.status.slice(1)}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[0.667rem] font-semibold border-border/60 bg-background/55 text-muted-foreground">
                          Run metadata
                        </span>
                      )}
                      {task.run.status === 'running' && task.run.startedAt && (
                        <RunElapsed startedAt={task.run.startedAt} />
                      )}
                    </div>
                    <div>
                      Session:{' '}
                      <code className="cockpit-kbd select-all cursor-pointer">{task.run.sessionKey}</code>
                    </div>
                    {task.run.startedAt && (
                      <div>Started: {formatDateTime(task.run.startedAt)}</div>
                    )}
                    {task.run.endedAt && (
                      <div>Ended: {formatDateTime(task.run.endedAt)}</div>
                    )}
                    {task.run.error && (
                      <div className="break-words text-destructive">Error: {task.run.error}</div>
                    )}
                  </div>
                </div>
              )}

              {task.result && (
                <div className="cockpit-note space-y-2">
                  <h4 className="cockpit-field-label">Result</h4>
                  <div className="whitespace-pre-wrap rounded-2xl border border-border/60 bg-background/45 p-3 text-xs text-foreground">
                    {task.result}
                  </div>
                </div>
              )}

              {task.feedback.length > 0 && (
                <div className="cockpit-note space-y-3">
                  <h4 className="cockpit-field-label">
                    <MessageSquare size={10} className="mr-1 inline" />
                    Feedback
                  </h4>
                  <div className="space-y-2">
                    {task.feedback.map((fb, i) => (
                      <div key={i} className="rounded-2xl border border-border/60 bg-background/45 p-3 text-xs">
                        <div className="mb-1 flex items-center justify-between text-[0.667rem] text-muted-foreground">
                          <span>{fb.by === 'operator' ? 'Operator' : fb.by}</span>
                          <span>{formatDateTime(fb.at)}</span>
                        </div>
                        <p className="text-foreground">{fb.note}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="shrink-0 border-t border-border/60 bg-background/88 px-4 py-3 backdrop-blur-sm">
              {/* Reject note input */}
              {showRejectInput && (
                <div className="mb-3 flex items-center gap-2">
                  <Input
                    value={rejectNote}
                    onChange={e => setRejectNote(e.target.value)}
                    placeholder="Rejection reason (required)…"
                    className="cockpit-input h-10 flex-1 text-sm"
                    onKeyDown={e => { if (e.key === 'Enter') handleReject(); if (e.key === 'Escape') { setShowRejectInput(false); setRejectNote(''); } }}
                    autoFocus
                  />
                  <Button size="xs" variant="outline" onClick={() => { setShowRejectInput(false); setRejectNote(''); }}>
                    Cancel
                  </Button>
                </div>
              )}

              <div className="flex items-center gap-2 flex-wrap">
              {/* Workflow actions */}
              {(task.status === 'backlog' || task.status === 'todo') && onExecute && (
                <Button size="xs" onClick={handleExecute} disabled={workflowLoading !== null}>
                  {workflowLoading === 'execute' ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
                  Execute
                </Button>
              )}
              {task.status === 'in-progress' && task.run?.status === 'running' && onAbort && (
                <Button size="xs" variant="outline" onClick={handleAbort} disabled={workflowLoading !== null} className="border-orange/30 bg-orange/8 text-orange hover:bg-orange/12">
                  {workflowLoading === 'abort' ? <Loader2 size={12} className="animate-spin" /> : <StopCircle size={12} />}
                  Abort
                </Button>
              )}
              {task.status === 'review' && (
                <>
                  {(isDelegatedTask || delegationProof) && (
                    <div className="space-y-3 rounded-2xl border border-border/60 bg-background/45 p-3 text-[0.733rem]">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium text-foreground">Delegation proof</span>
                        <span className={readyToClose ? 'text-green' : 'text-muted-foreground'}>
                          {readyToClose ? 'Ready to close' : 'Missing proof'}
                        </span>
                      </div>
                      {delegationProof ? (
                        <div className="space-y-3">
                          <div className="flex items-center justify-between gap-2 rounded-xl border border-border/55 bg-background/45 px-3 py-2">
                            <span className="text-muted-foreground">Packet</span>
                            <span className="break-all text-foreground">{delegationProof.packetId}</span>
                          </div>
                          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                            <div className="rounded-xl border border-border/55 bg-background/45 px-3 py-2">
                              <div className="flex items-center justify-between gap-2">
                                <div className="text-[0.6rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Worker</div>
                                <Button
                                  size="xs"
                                  variant="outline"
                                  onClick={() => handleDelegationProofPass('worker')}
                                  disabled={workflowLoading !== null}
                                  className="h-7 px-2 text-[0.667rem]"
                                >
                                  {workflowLoading === 'worker-proof' ? <Loader2 size={10} className="animate-spin" /> : <CheckCircle2 size={10} />}
                                  Pass worker
                                </Button>
                              </div>
                              {delegationProof.worker ? (
                                <div className="mt-1 space-y-1">
                                  <div className="font-medium text-foreground">{delegationProof.worker.agentId}</div>
                                  <div className="text-muted-foreground break-all">{delegationProof.worker.sessionKey}</div>
                                  <div className="text-foreground">Verdict: {delegationProof.worker.verdict}</div>
                                  <div className="text-muted-foreground">{delegationProof.worker.summary}</div>
                                </div>
                              ) : (
                                <div className="mt-1 text-muted-foreground">Missing worker proof.</div>
                              )}
                            </div>
                            <div className="rounded-xl border border-border/55 bg-background/45 px-3 py-2">
                              <div className="flex items-center justify-between gap-2">
                                <div className="text-[0.6rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Checker</div>
                                <Button
                                  size="xs"
                                  variant="outline"
                                  onClick={() => handleDelegationProofPass('checker')}
                                  disabled={workflowLoading !== null}
                                  className="h-7 px-2 text-[0.667rem]"
                                >
                                  {workflowLoading === 'checker-proof' ? <Loader2 size={10} className="animate-spin" /> : <CheckCircle2 size={10} />}
                                  Pass checker
                                </Button>
                              </div>
                              {delegationProof.checker ? (
                                <div className="mt-1 space-y-1">
                                  <div className="font-medium text-foreground">{delegationProof.checker.agentId}</div>
                                  <div className="text-muted-foreground break-all">{delegationProof.checker.sessionKey}</div>
                                  <div className="text-foreground">Verdict: {delegationProof.checker.verdict}</div>
                                  <div className="text-muted-foreground">{delegationProof.checker.summary}</div>
                                </div>
                              ) : (
                                <div className="mt-1 text-muted-foreground">Missing checker proof.</div>
                              )}
                            </div>
                          </div>
                          <div className="rounded-xl border border-border/55 bg-background/45 px-3 py-2">
                            <div className="text-[0.6rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Blocker</div>
                            <div className="mt-1 text-foreground">
                              {delegationProof.blocker?.trim() ? delegationProof.blocker : 'No blocker recorded'}
                            </div>
                          </div>
                        </div>
                      ) : (
                        <div className="space-y-3">
                          <div className="text-muted-foreground">
                            {isDelegatedTask ? 'Waiting for typed worker and checker proof.' : 'No typed delegation proof recorded.'}
                          </div>
                          <div className="flex flex-wrap gap-2">
                            <Button
                              size="xs"
                              variant="outline"
                              onClick={() => handleDelegationProofPass('worker')}
                              disabled={workflowLoading !== null}
                            >
                              {workflowLoading === 'worker-proof' ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />}
                              Pass worker
                            </Button>
                            <Button
                              size="xs"
                              variant="outline"
                              onClick={() => handleDelegationProofPass('checker')}
                              disabled={workflowLoading !== null}
                            >
                              {workflowLoading === 'checker-proof' ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />}
                              Pass checker
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                  <button
                    type="button"
                    className="flex w-full items-center justify-between rounded-2xl border border-border/60 bg-background/45 px-3 py-2 text-left text-[0.733rem] font-medium text-foreground"
                    onClick={() => setProofPanelOpen(v => !v)}
                    aria-expanded={proofPanelOpen}
                    aria-controls="proof-gate-panel"
                  >
                    <span>Proof gate</span>
                    <span className="text-muted-foreground">{proofPanelOpen ? 'Hide' : 'Show'}</span>
                  </button>
                  {proofPanelOpen && (
                    <div id="proof-gate-panel" className="space-y-3 rounded-2xl border border-border/60 bg-background/45 p-3 text-[0.733rem]">
                      <div className="flex items-center gap-2">
                        <label className="flex items-center gap-2 flex-1 min-w-0">
                          <span className="shrink-0 text-muted-foreground">Proof URL</span>
                          <Input
                            value={editProofUrl}
                            onChange={e => { setEditProofUrl(e.target.value); markDirty(); }}
                            placeholder="https://... or evidence link"
                            className="cockpit-input h-9 flex-1 min-w-0 text-xs"
                            aria-label="Proof URL"
                          />
                        </label>
                        <Button size="xs" variant="outline" onClick={handleAddProof} disabled={workflowLoading !== null || !editProofUrl.trim()}>
                          Add proof
                        </Button>
                      </div>
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        {[
                          ['reindex_verified', 'Reindex verified'],
                          ['read_back_verified', 'Read-back verified'],
                          ['live_link_or_canvas_checked', 'Live link/canvas checked'],
                          ['proof_log_updated', 'Proof log updated'],
                        ].map(([key, label]) => {
                          const checked = gateState[key as keyof typeof gateState];
                          return (
                            <label key={key} className="flex items-center gap-2 rounded-xl border border-border/50 px-3 py-2">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={e => handleProofGateUpdate(key as keyof typeof gateState, e.target.checked)}
                                aria-label={label}
                              />
                              <span>{label}</span>
                            </label>
                          );
                        })}
                      </div>
                      {proofLinks.length ? (
                        <div className="space-y-2 rounded-2xl border border-border/60 bg-background/45 p-3 text-[0.733rem]">
                          <div className="font-medium text-foreground">Proof attached</div>
                          <ul className="space-y-1">
                            {proofLinks.map((link, index) => (
                              <li key={index} className="break-all text-muted-foreground">{link}</li>
                            ))}
                          </ul>
                        </div>
                      ) : (
                        <span className="text-[0.733rem] text-muted-foreground">
                          Proof is missing. Add proof in the Proof gate before approving.
                        </span>
                      )}
                    </div>
                  )}
                  {onApprove && (
                    <Button size="xs" variant="outline" onClick={handleApprove} disabled={workflowLoading === 'approve' || !canApprove} className="border-green/30 bg-green/8 text-green hover:bg-green/12">
                      {workflowLoading === 'approve' ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />}
                      Approve
                    </Button>
                  )}
                  {onReject && (
                    <Button size="xs" variant="outline" onClick={handleReject} disabled={workflowLoading !== null || (showRejectInput && !rejectNote.trim())} className="border-destructive/30 bg-destructive/8 text-destructive hover:bg-destructive/12">
                      {workflowLoading === 'reject' ? <Loader2 size={12} className="animate-spin" /> : <XCircle size={12} />}
                      Reject
                    </Button>
                  )}
                </>
              )}
              <div className="flex-1" />

              {confirmDelete ? (
                <span className="inline-flex items-center gap-1.5">
                  <span className="text-[0.733rem] text-destructive font-medium">Delete?</span>
                  <Button
                    size="xs"
                    variant="destructive"
                    onClick={handleDelete}
                    disabled={deleting}
                  >
                    {deleting ? <Loader2 size={12} className="animate-spin" /> : 'Yes'}
                  </Button>
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => setConfirmDelete(false)}
                    disabled={deleting}
                  >
                    No
                  </Button>
                </span>
              ) : (
                <Button
                  size="xs"
                  variant="destructive"
                  onClick={() => setConfirmDelete(true)}
                >
                  <Trash2 size={12} />
                  Delete
                </Button>
              )}

              <Button
                size="xs"
                onClick={handleSave}
                disabled={!dirty || saving}
              >
                {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
                Save
              </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
}
