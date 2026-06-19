import { AlertTriangle, CheckCircle2, Clock, PlugZap, ShieldAlert, TerminalSquare, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  approvalResolvingKey,
  type ApprovalDecision,
  type PendingApproval,
} from './useApprovals';

interface ApprovalBannerProps {
  pendingApprovals: PendingApproval[];
  resolvingKeys: Set<string>;
  error?: string | null;
  onDecision: (approval: PendingApproval, decision: ApprovalDecision) => void | Promise<void>;
}

function formatTimeLeft(expiresAtMs: number): string {
  const remainingMs = expiresAtMs - Date.now();
  if (remainingMs <= 0) return 'Expires now';
  const remainingSeconds = Math.ceil(remainingMs / 1000);
  if (remainingSeconds < 60) return `Expires in ${remainingSeconds}s`;
  const minutes = Math.ceil(remainingSeconds / 60);
  return `Expires in ${minutes}m`;
}

function decisionLabel(decision: ApprovalDecision): string {
  if (decision === 'allow-once') return 'Allow once';
  if (decision === 'allow-always') return 'Allow session';
  return 'Deny';
}

function ApprovalKindIcon({ approval }: { approval: PendingApproval }) {
  if (approval.kind === 'exec') return <TerminalSquare className="size-4" aria-hidden="true" />;
  return <PlugZap className="size-4" aria-hidden="true" />;
}

function severityClasses(approval: PendingApproval): string {
  if (approval.severity === 'critical') return 'border-destructive/45 bg-destructive/10 text-destructive';
  if (approval.severity === 'info') return 'border-primary/25 bg-primary/8 text-primary';
  return 'border-orange/35 bg-orange/10 text-orange';
}

function actionIcon(decision: ApprovalDecision) {
  if (decision === 'deny') return <XCircle className="size-4" aria-hidden="true" />;
  return <CheckCircle2 className="size-4" aria-hidden="true" />;
}

export function ApprovalBanner({
  pendingApprovals,
  resolvingKeys,
  error = null,
  onDecision,
}: ApprovalBannerProps) {
  const approval = pendingApprovals[0];

  if (!approval && !error) return null;

  if (!approval) {
    return (
      <section
        role="status"
        aria-live="polite"
        className="mx-3 mt-3 rounded-xl border border-destructive/25 bg-destructive/8 px-3 py-2 text-sm text-destructive"
      >
        <div className="flex items-center gap-2">
          <ShieldAlert className="size-4 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </div>
      </section>
    );
  }

  const resolving = resolvingKeys.has(approvalResolvingKey(approval));
  const waitingCount = pendingApprovals.length;
  const detailLines = approval.description.split('\n').filter(Boolean);

  return (
    <section
      role="alert"
      aria-live="assertive"
      className={cn(
        'mx-3 mt-3 rounded-xl border px-3 py-3 shadow-[0_18px_42px_rgba(0,0,0,0.20)]',
        severityClasses(approval),
      )}
    >
      <div className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-2">
            <span className="mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-lg border border-current/25 bg-background/55">
              <ApprovalKindIcon approval={approval} />
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <h2 className="text-sm font-semibold text-foreground">Approval needed</h2>
                <span className="inline-flex items-center gap-1 rounded-full border border-current/25 bg-background/55 px-2 py-0.5 text-[0.667rem] font-semibold uppercase tracking-[0.08em]">
                  {approval.kind === 'exec' ? 'Command' : 'Tool'}
                </span>
                {waitingCount > 1 && (
                  <span className="text-[0.733rem] text-muted-foreground">
                    {waitingCount} waiting
                  </span>
                )}
              </div>
              <p className="mt-1 text-sm font-medium text-foreground">{approval.title}</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1 text-[0.733rem] font-medium text-muted-foreground">
            <Clock className="size-3.5" aria-hidden="true" />
            <span>{formatTimeLeft(approval.expiresAtMs)}</span>
          </div>
        </div>

        {detailLines.length > 0 && (
          <div className="max-h-28 overflow-auto rounded-lg border border-current/15 bg-background/55 px-3 py-2 text-[0.733rem] leading-5 text-foreground/88">
            {detailLines.map((line, index) => (
              <p key={`${approval.id}-detail-${index}`} className={index === 0 ? 'font-mono break-words' : 'break-words'}>
                {line}
              </p>
            ))}
          </div>
        )}

        {approval.metadata.length > 0 && (
          <dl className="grid grid-cols-1 gap-x-3 gap-y-1 text-[0.733rem] sm:grid-cols-2">
            {approval.metadata.map((item) => (
              <div key={`${approval.id}-${item.label}`} className="min-w-0">
                <dt className="inline text-muted-foreground">{item.label}: </dt>
                <dd className="inline break-words text-foreground/88">{item.value}</dd>
              </div>
            ))}
          </dl>
        )}

        {error && (
          <p className="flex items-center gap-1.5 text-[0.733rem] text-destructive">
            <AlertTriangle className="size-3.5" aria-hidden="true" />
            {error}
          </p>
        )}

        <div className="flex flex-wrap justify-end gap-2">
          {approval.allowedDecisions.map((decision) => (
            <Button
              key={decision}
              type="button"
              size="sm"
              variant={decision === 'deny' ? 'destructive' : decision === 'allow-once' ? 'default' : 'outline'}
              disabled={resolving}
              onClick={() => { void onDecision(approval, decision); }}
            >
              {actionIcon(decision)}
              {decisionLabel(decision)}
            </Button>
          ))}
        </div>
      </div>
    </section>
  );
}
