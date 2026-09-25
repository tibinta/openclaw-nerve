import { memo, useState, useEffect } from 'react';
import { Check, X, ArrowUpCircle, PlusCircle, Sparkles, ChevronDown, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { KanbanProposal } from './hooks/useProposals';
import type { KanbanTask } from './types';
import { TASK_STATUS_TONE } from './tone';

/* ── Type badge ── */
function TypeBadge({ type }: { type: 'create' | 'update' }) {
  if (type === 'create') {
    return (
      <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[0.667rem] font-semibold ${TASK_STATUS_TONE.done.badgeClass}`}>
        <PlusCircle size={10} />
        Create
      </span>
    );
  }
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[0.667rem] font-semibold ${TASK_STATUS_TONE.todo.badgeClass}`}>
      <ArrowUpCircle size={10} />
      Update
    </span>
  );
}

/* ── Relative timestamp (ticks every 30s for live updates) ── */
export function RelativeTime({ ts }: { ts: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  const diff = Math.max(0, now - ts);
  const secs = Math.floor(diff / 1000);
  let label: string;
  if (secs < 60) label = 'just now';
  else if (secs < 3600) label = `${Math.floor(secs / 60)}m ago`;
  else if (secs < 86400) label = `${Math.floor(secs / 3600)}h ago`;
  else label = `${Math.floor(secs / 86400)}d ago`;

  return <span className="text-[0.667rem] text-muted-foreground tabular-nums">{label}</span>;
}

/* ── Summary text ── */
function ProposalSummary({ proposal }: { proposal: KanbanProposal }) {
  const [conversationOpen, setConversationOpen] = useState(false);
  const { type, payload } = proposal;
  if (type === 'create') {
    const title = (payload.title as string) || 'Untitled';
    const description = payload.description as string | undefined;
    const [descriptionSummary, fullConversation] = description?.split('\n\nFull conversation snapshot:\n', 2) ?? [];
    const sourceLine = descriptionSummary?.split('\n').find((line) => line.trim().startsWith('Source:'))?.trim();
    return (
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <p className="min-w-0 truncate text-xs font-medium text-foreground" title={title}>{title}</p>
          {fullConversation && (
            <button
              type="button"
              aria-expanded={conversationOpen}
              aria-label={`View full conversation for ${title}`}
              onClick={() => setConversationOpen((open) => !open)}
              className="shrink-0 text-[0.667rem] font-semibold tracking-wide text-primary/90 hover:text-primary"
            >
              VIEW (CONV)
            </button>
          )}
        </div>
        {sourceLine && (
          <p className="mt-0.5 truncate text-[0.733rem] text-muted-foreground" title={sourceLine}>{sourceLine}</p>
        )}
        {conversationOpen && description && (
          <p className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap rounded-lg border border-border/50 bg-background/45 p-2 text-[0.733rem] leading-relaxed text-muted-foreground">
            {description}
          </p>
        )}
      </div>
    );
  }

  // Update proposal
  const taskId = (payload.id as string) || '???';
  const changes = Object.keys(payload).filter((k) => k !== 'id');
  return (
    <div className="min-w-0 flex-1">
      <p className="text-xs font-medium text-foreground break-words">
        Update: <span className="font-mono text-[0.667rem] text-muted-foreground">{taskId}</span>
      </p>
      <p className="text-[0.667rem] text-muted-foreground break-words">
        Fields: {changes.join(', ') || 'none'}
      </p>
    </div>
  );
}

/* ── Single proposal row ── */
function ProposalRow({
  proposal,
  onApprove,
  onReject,
}: {
  proposal: KanbanProposal;
  onApprove: (id: string) => void | Promise<void>;
  onReject: (id: string) => void | Promise<void>;
}) {
  const [acting, setActing] = useState(false);
  const description = String(proposal.payload.description || '');
  const labels = Array.isArray(proposal.payload.labels) ? proposal.payload.labels : [];
  const missingOmniContext = proposal.type === 'create'
    && labels.includes('omnibrain')
    && !(description.includes('Conversation ID:') && (description.includes('Context:') || description.includes('Relevant excerpt:')));

  const handleApprove = async () => {
    setActing(true);
    try {
      await onApprove(proposal.id);
    } finally {
      setActing(false);
    }
  };

  const handleReject = async () => {
    setActing(true);
    try {
      await onReject(proposal.id);
    } finally {
      setActing(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 border-b border-border/40 px-4 py-2.5 transition-colors last:border-b-0 hover:bg-primary/[0.04] sm:flex-row sm:items-start">
      <div className="flex flex-col items-start gap-1 shrink-0 pt-0.5">
        <TypeBadge type={proposal.type} />
        <RelativeTime ts={proposal.proposedAt} />
      </div>

      <ProposalSummary proposal={proposal} />

      {missingOmniContext && (
        <p className="text-[0.667rem] leading-relaxed text-orange sm:max-w-48">
          Full source context is unavailable. Recreate this suggestion from Omni Brain before approval.
        </p>
      )}

      <div className="flex items-center gap-1 shrink-0 sm:justify-end">
        <Button
          variant="outline"
          size="xs"
          onClick={handleApprove}
          disabled={acting || missingOmniContext}
          title={missingOmniContext ? 'Full conversation context required' : 'Approve'}
          aria-label="Approve proposal"
          className="border-green/30 bg-green/8 text-green hover:bg-green/12"
        >
          <Check size={14} />
          <span className="hidden sm:inline">Approve</span>
        </Button>
        <Button
          variant="outline"
          size="xs"
          onClick={handleReject}
          disabled={acting}
          title="Reject"
          aria-label="Reject proposal"
          className="border-destructive/22 bg-destructive/8 text-destructive hover:bg-destructive/14"
        >
          <X size={14} />
          <span className="hidden sm:inline">Reject</span>
        </Button>
      </div>
    </div>
  );
}

/* ── Label badge (omnibrain gets a distinct tone) ── */
function LabelBadge({ label }: { label: string }) {
  const isOmnibrain = label === 'omnibrain';
  return (
    <span
      className={`text-[0.667rem] px-1 py-0 rounded ${
        isOmnibrain
          ? 'border border-primary/30 bg-primary/10 text-primary font-medium'
          : 'bg-muted text-muted-foreground'
      }`}
    >
      {label}
    </span>
  );
}

/* ── Single suggested task row ── */
function SuggestedTaskRow({
  task,
  onOpenTask,
}: {
  task: KanbanTask;
  onOpenTask: (taskId: string) => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpenTask(task.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpenTask(task.id);
        }
      }}
      className="flex flex-col gap-1 border-b border-border/40 px-4 py-3 transition-colors last:border-b-0 hover:bg-primary/[0.04] cursor-pointer"
    >
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 flex-1 text-xs font-medium text-foreground break-words">{task.title}</p>
        <RelativeTime ts={task.createdAt} />
      </div>
      {task.labels.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          {task.labels.map((l) => (
            <LabelBadge key={l} label={l} />
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Suggested tasks section ── */
function SuggestedTasksSection({
  tasks,
  onOpenTask,
}: {
  tasks: KanbanTask[];
  onOpenTask: (taskId: string) => void;
}) {
  if (tasks.length === 0) return null;

  return (
    <div className="border-t border-border/40">
      <div className="flex items-center gap-1.5 px-4 pt-3 pb-1">
        <Sparkles size={12} className="text-muted-foreground" />
        <span className="text-[0.667rem] font-semibold uppercase tracking-wide text-muted-foreground">
          Suggested tasks
        </span>
      </div>
      {tasks.map((t) => (
        <SuggestedTaskRow key={t.id} task={t} onOpenTask={onOpenTask} />
      ))}
    </div>
  );
}

/* ── Main inbox panel ── */
interface ProposalInboxProps {
  proposals: KanbanProposal[];
  onApprove: (id: string) => void | Promise<void>;
  onReject: (id: string) => void | Promise<void>;
  onRejectBackground?: (proposalIds: string[]) => Promise<number>;
  suggestedTasks?: KanbanTask[];
  onOpenTask?: (taskId: string) => void;
}

export const ProposalInbox = memo(function ProposalInbox({
  proposals,
  onApprove,
  onReject,
  onRejectBackground,
  suggestedTasks = [],
  onOpenTask,
}: ProposalInboxProps) {
  const [backgroundOpen, setBackgroundOpen] = useState(false);
  const [rejectingBackground, setRejectingBackground] = useState(false);
  const [backgroundRejectError, setBackgroundRejectError] = useState<string | null>(null);
  const backgroundProposals = proposals.filter((proposal) => proposal.proposedBy === 'agent:omnibrain-sync');
  const rejectSnapshot = backgroundProposals.slice(0, 5000);
  const directProposals = proposals.filter((proposal) => proposal.proposedBy !== 'agent:omnibrain-sync');

  const rejectBackground = async () => {
    if (!onRejectBackground || rejectSnapshot.length === 0) return;
    const count = rejectSnapshot.length;
    if (!window.confirm(`Reject up to ${count} background proposals shown?`)) return;
    setRejectingBackground(true);
    setBackgroundRejectError(null);
    try {
      await onRejectBackground(rejectSnapshot.map((proposal) => proposal.id));
    } catch (error) {
      setBackgroundRejectError(
        error instanceof Error ? error.message : 'Could not reject background proposals. Try again.',
      );
    } finally {
      setRejectingBackground(false);
    }
  };

  if (proposals.length === 0 && suggestedTasks.length === 0) {
    return (
      <div className="px-4 py-8 text-center">
        <div className="cockpit-badge mx-auto w-fit">Inbox clear</div>
        <p className="mt-3 text-sm text-muted-foreground">No pending proposals right now.</p>
      </div>
    );
  }

  return (
    <div className="max-h-[min(70vh,520px)] overflow-y-auto">
      {directProposals.map((p) => (
        <ProposalRow
          key={p.id}
          proposal={p}
          onApprove={onApprove}
          onReject={onReject}
        />
      ))}
      {backgroundProposals.length > 0 && (
        <section className="border-t border-border/50">
          <div className="flex items-center gap-2 px-4 py-2">
            <button
              type="button"
              aria-expanded={backgroundOpen}
              onClick={() => setBackgroundOpen((open) => !open)}
              className="flex flex-1 items-center gap-2 py-1 text-left text-xs font-semibold text-muted-foreground hover:text-foreground"
            >
              {backgroundOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              Background proposals ({backgroundProposals.length})
            </button>
            {onRejectBackground && (
              <Button
                variant="outline"
                size="xs"
                disabled={rejectingBackground}
                onClick={() => void rejectBackground()}
              >
                Reject remaining background proposals
              </Button>
            )}
          </div>
          {backgroundRejectError && (
            <p role="alert" className="px-4 pb-2 text-xs text-destructive">
              Could not reject background proposals: {backgroundRejectError}
            </p>
          )}
          {backgroundOpen && backgroundProposals.map((p) => (
            <ProposalRow
              key={p.id}
              proposal={p}
              onApprove={onApprove}
              onReject={onReject}
            />
          ))}
        </section>
      )}
      {onOpenTask && <SuggestedTasksSection tasks={suggestedTasks} onOpenTask={onOpenTask} />}
    </div>
  );
});
