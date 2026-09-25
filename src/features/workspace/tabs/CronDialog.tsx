/**
 * CronDialog — Modal for creating or editing cron jobs.
 */

import { useState, useCallback, useRef, useEffect, type SelectHTMLAttributes } from 'react';
import { ChevronDown, X } from 'lucide-react';
import type { CronJob } from '../hooks/useCrons';
import { useSessionContext } from '@/contexts/SessionContext';

interface CronDialogProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (job: Record<string, unknown>) => Promise<boolean>;
  mode: 'create' | 'edit';
  /** Pre-fill form when editing */
  initialData?: CronJob | null;
}

type ScheduleKind = 'cron' | 'every' | 'at';
type DeliveryMode = 'none' | 'announce';
type SessionTarget = 'main' | 'isolated' | `session:${string}`;
const JANE_LIVE_TARGET = 'session:agent:main:voice:direct:nerve-live';
type WakeMode = 'now' | 'nextHeartbeat';
type ThinkingLevel = 'off' | 'low' | 'medium' | 'high';

const CRON_READONLY_KEYS = new Set([
  'id',
  'jobId',
  'createdAtMs',
  'updatedAtMs',
  'state',
  'nextRun',
  'lastRun',
  'lastStatus',
  'lastError',
  'lastDeliveryStatus',
  'scheduledToolPolicy',
  'configRevision',
  'nextRunAtMs',
  'lastRunAtMs',
  'lastRunStatus',
  'lastDelivered',
  'lastDeliveryError',
  'lastFailureNotificationDeliveryStatus',
]);

interface CronFormState {
  name: string;
  description: string;
  agentId: string;
  enabled: boolean;
  scheduleKind: ScheduleKind;
  everyValue: string;
  everyUnit: 'second' | 'minute' | 'hour' | 'day';
  cronExpr: string;
  cronTz: string;
  atTime: string;
  sessionTarget: SessionTarget;
  wakeMode: WakeMode;
  message: string;
  timeoutSeconds: string;
  deliveryMode: DeliveryMode;
  deliveryChannel: string;
  deliveryTo: string;
  deleteAfterRun: boolean;
  clearAgentOverride: boolean;
  sessionKey: string;
  accountId: string;
  lightContext: boolean;
  model: string;
  thinking: ThinkingLevel;
  failureAlerts: string;
  bestEffortDelivery: boolean;
  raw: Record<string, unknown>;
}

interface ModelInfo {
  id: string;
  label?: string;
}

const EVERY_UNITS = [
  { value: 'second', label: 'Seconds', ms: 1000 },
  { value: 'minute', label: 'Minutes', ms: 60_000 },
  { value: 'hour', label: 'Hours', ms: 3_600_000 },
  { value: 'day', label: 'Days', ms: 86_400_000 },
] as const;

const THINKING_OPTIONS: Array<{ value: ThinkingLevel; label: string }> = [
  { value: 'off', label: 'Off' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
];

const WAKE_OPTIONS: Array<{ value: WakeMode; label: string; description: string }> = [
  { value: 'now', label: 'Now', description: 'Trigger immediately.' },
  { value: 'nextHeartbeat', label: 'Next heartbeat', description: 'Wait for the next cycle.' },
];

const CHANNEL_LABELS: Record<string, string> = {
  whatsapp: 'WhatsApp',
  telegram: 'Telegram',
  discord: 'Discord',
  signal: 'Signal',
  slack: 'Slack',
  irc: 'IRC',
  googlechat: 'Google Chat',
  imessage: 'iMessage',
};

const CHANNEL_PLACEHOLDERS: Record<string, string> = {
  whatsapp: '+905551234567',
  telegram: '-100123456789 or @username',
  discord: 'channel-id',
  signal: '+905551234567',
  slack: '#channel or @user',
  irc: '#channel',
  googlechat: 'space-id',
  imessage: '+905551234567',
};

function deriveAgentId(sessionKey?: string): string {
  if (!sessionKey) return 'main';
  const match = sessionKey.match(/^agent:([^:]+):/);
  return match?.[1] || 'main';
}

function defaultSessionKey(agentId: string): string {
  return `agent:${agentId || 'main'}:main`;
}

/** Strip the auto-appended delivery instruction from a prompt for clean editing */
function stripDeliveryInstruction(msg: string): string {
  return msg.replace(/\n\n(?:After completing the task, s|S)end the result using the message tool.*$/s, '');
}

function isoToLocal(iso: string): string {
  try {
    const d = new Date(iso);
    // datetime-local expects YYYY-MM-DDTHH:MM
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return '';
  }
}

function everyMsToParts(everyMs?: number): { value: string; unit: CronFormState['everyUnit'] } {
  const fallback = { value: '1', unit: 'hour' as const };
  if (!everyMs || everyMs <= 0) return fallback;

  for (const unit of [...EVERY_UNITS].reverse()) {
    if (everyMs % unit.ms === 0) {
      return {
        value: String(everyMs / unit.ms),
        unit: unit.value,
      };
    }
  }

  return {
    value: String(Math.max(1, Math.round(everyMs / 60_000))),
    unit: 'minute',
  };
}

function partsToEveryMs(value: string, unit: CronFormState['everyUnit']): number {
  const parsed = Number(value);
  const unitMs = EVERY_UNITS.find((item) => item.value === unit)?.ms ?? 60_000;
  if (!Number.isFinite(parsed) || parsed <= 0) return unitMs;
  return Math.round(parsed) * unitMs;
}

function createInitialForm(prefill: CronJob | null): CronFormState {
  const agentId = prefill?.agentId?.trim() || deriveAgentId(prefill?.sessionKey);
  const everyParts = everyMsToParts(prefill?.everyMs);
  const raw = (prefill?.raw || {}) as Record<string, unknown>;

  return {
    name: prefill?.name?.trim() || prefill?.label?.trim() || prefill?.id || '',
    description: prefill?.description?.trim() || '',
    agentId,
    enabled: prefill?.enabled ?? true,
    scheduleKind: prefill?.scheduleKind || 'every',
    everyValue: everyParts.value,
    everyUnit: everyParts.unit,
    cronExpr: prefill?.schedule || '0 9 * * *',
    cronTz: prefill?.scheduleTz || '',
    atTime: prefill?.at ? isoToLocal(prefill.at) : '',
    sessionTarget: prefill?.sessionTarget || (prefill?.payloadKind === 'systemEvent' ? 'main' : 'isolated'),
    wakeMode: (prefill?.wakeMode as WakeMode) || 'now',
    message: prefill ? stripDeliveryInstruction(prefill.message || '') : '',
    timeoutSeconds: typeof prefill?.timeoutSeconds === 'number' ? String(prefill.timeoutSeconds) : '',
    deliveryMode: prefill?.delivery?.mode === 'announce' ? 'announce' : 'none',
    deliveryChannel: prefill?.delivery?.channel || '',
    deliveryTo: prefill?.delivery?.to || '',
    deleteAfterRun: prefill?.deleteAfterRun ?? false,
    clearAgentOverride: prefill?.clearAgentOverride ?? false,
    sessionKey: prefill?.sessionKey || (prefill?.sessionTarget?.startsWith('session:') ? '' : defaultSessionKey(agentId)),
    accountId: prefill?.accountId || '',
    lightContext: prefill?.lightContext ?? false,
    model: prefill?.model || '',
    thinking: (typeof prefill?.thinking === 'string' ? prefill.thinking : 'off') as ThinkingLevel,
    failureAlerts: prefill?.failureAlerts || '',
    bestEffortDelivery: prefill?.bestEffortDelivery ?? prefill?.delivery?.bestEffort ?? false,
    raw,
  };
}

function SectionShell({
  eyebrow,
  title,
  description,
  children,
  className = '',
}: {
  eyebrow: string;
  title: string;
  description: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`cockpit-surface p-3 sm:p-3.5 ${className}`}>
      <div className="space-y-0.5">
        <div className="cockpit-kicker text-[0.6rem]">
          <span className="text-primary">◆</span>
          {eyebrow}
        </div>
        <div className="text-[0.95rem] font-semibold text-foreground">{title}</div>
        <p className="text-[0.833rem] leading-5 text-muted-foreground">{description}</p>
      </div>
      <div className="mt-3 space-y-2.5">{children}</div>
    </section>
  );
}

function CronSelect(props: SelectHTMLAttributes<HTMLSelectElement>) {
  const { className = '', children, ...rest } = props;

  return (
    <div className="relative min-w-0">
      <select
        {...rest}
        className={`cockpit-select h-11 min-w-0 appearance-none truncate pr-11 text-sm ${className}`.trim()}
      >
        {children}
      </select>
      <ChevronDown
        size={15}
        aria-hidden="true"
        className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-muted-foreground"
      />
    </div>
  );
}

/** Modal dialog for creating or editing a cron job. */
export function CronDialog({ open, onClose, onSubmit, mode, initialData }: CronDialogProps) {
  const prefill = mode === 'edit' && initialData ? initialData : null;
  const { agentName } = useSessionContext();

  const [form, setForm] = useState<CronFormState>(() => createInitialForm(prefill));
  const [models, setModels] = useState<{ value: string; label: string }[]>([]);
  const [availableChannels, setAvailableChannels] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const dialogRef = useRef<HTMLDialogElement>(null);

  // Fetch available models and configured channels when dialog opens.
  useEffect(() => {
    if (!open) return;
    fetch('/api/gateway/models')
      .then((r) => r.json())
      .then((data: { models?: ModelInfo[] }) => {
        if (Array.isArray(data.models)) {
          const opts = [
            { value: '', label: 'Default model' },
            ...data.models.map((m) => ({
              value: m.id,
              label: m.label || m.id.split('/').pop() || m.id,
            })),
          ];
          setModels(opts);
        }
      })
      .catch(() => {
        setModels([{ value: '', label: 'Default model' }]);
      });

    fetch('/api/channels')
      .then((r) => r.json())
      .then((data: { channels?: string[] }) => {
        setAvailableChannels(data.channels || []);
      })
      .catch(() => setAvailableChannels([]));
  }, [open]);

  useEffect(() => {
    if (open) {
      dialogRef.current?.showModal();
    } else {
      dialogRef.current?.close();
    }
  }, [open]);

  const handleClose = useCallback(() => {
    setError('');
    onClose();
  }, [onClose]);

  const handleDialogClick = useCallback((e: React.MouseEvent<HTMLDialogElement>) => {
    if (e.target === dialogRef.current) handleClose();
  }, [handleClose]);

  const updateForm = useCallback(<K extends keyof CronFormState>(key: K, value: CronFormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  }, []);

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    const name = form.name.trim();
    const message = form.message.trim();

    if (!name) {
      setError('Name is required');
      return;
    }
    if (!message) {
      setError('Assistant task prompt is required');
      return;
    }

    if (form.deliveryMode === 'announce' && availableChannels.length > 0 && !form.deliveryChannel) {
      setError('Select a delivery channel or switch to Keep inside Nerve');
      return;
    }

    let schedule: Record<string, unknown>;
    if (form.scheduleKind === 'cron') {
      if (!form.cronExpr.trim()) {
        setError('Cron expression required');
        return;
      }
      schedule = { kind: 'cron', expr: form.cronExpr.trim() };
      if (form.cronTz.trim()) schedule.tz = form.cronTz.trim();
    } else if (form.scheduleKind === 'at') {
      if (!form.atTime.trim()) {
        setError('Date/time required');
        return;
      }
      schedule = { kind: 'at', at: new Date(form.atTime).toISOString() };
    } else {
      const everyMs = partsToEveryMs(form.everyValue, form.everyUnit);
      schedule = { kind: 'every', everyMs };
      const previous = (form.raw.schedule || {}) as Record<string, unknown>;
      if (previous.everyMs === everyMs && typeof previous.anchorMs === 'number') schedule.anchorMs = previous.anchorMs;
    }

    const timeoutSeconds = Number(form.timeoutSeconds);
    const model = form.model.trim();
    const thinking = form.thinking;
    const sessionTarget = form.sessionTarget;
    const previousPayload = (form.raw.payload || {}) as Record<string, unknown>;
    const payload: Record<string, unknown> = sessionTarget === 'main'
      ? { kind: 'systemEvent', text: message }
      : {
          kind: 'agentTurn',
          message,
          ...(model ? { model } : {}),
          ...(thinking !== 'off' ? { thinking } : {}),
          ...(Number.isFinite(timeoutSeconds) && timeoutSeconds > 0 ? { timeoutSeconds } : {}),
          ...(Array.isArray(previousPayload.toolsAllow) ? { toolsAllow: previousPayload.toolsAllow } : {}),
        };

    const delivery: Record<string, unknown> = {
      mode: form.deliveryMode,
      bestEffort: form.bestEffortDelivery,
    };
    if (form.deliveryMode === 'announce') {
      if (form.deliveryChannel) delivery.channel = form.deliveryChannel;
      if (form.deliveryTo.trim()) delivery.to = form.deliveryTo.trim();
    }

    // Preserve editable gateway fields from the existing cron, but strip
    // readonly bookkeeping keys so the gateway never sees stale record state.
    const preservedRaw = Object.fromEntries(
      Object.entries(form.raw).filter(([key]) => !CRON_READONLY_KEYS.has(key)),
    );
    const sessionKey = form.sessionKey.trim();
    const agentId = form.agentId.trim();
    const job: Record<string, unknown> = {
      ...preservedRaw,
      name,
      description: form.description.trim() || undefined,
      agentId: agentId || undefined,
      enabled: form.enabled,
      schedule,
      payload,
      sessionTarget,
      sessionKey: sessionKey || undefined,
      wakeMode: form.wakeMode,
      timeoutSeconds: Number.isFinite(timeoutSeconds) && timeoutSeconds > 0 ? timeoutSeconds : undefined,
      delivery,
      deleteAfterRun: form.deleteAfterRun,
      clearAgentOverride: form.clearAgentOverride,
      accountId: form.accountId.trim() || undefined,
      lightContext: form.lightContext,
      model: model || undefined,
      thinkingLevel: thinking,
      failureAlerts: form.failureAlerts.trim() || undefined,
      bestEffortDelivery: form.bestEffortDelivery,
    };

    setSubmitting(true);
    const ok = await onSubmit(job);
    setSubmitting(false);

    if (ok) {
      handleClose();
    } else {
      setError(`Failed to ${mode === 'edit' ? 'update' : 'create'} cron job`);
    }
  }, [availableChannels.length, form, handleClose, mode, onSubmit]);

  if (!open) return null;

  const isEdit = mode === 'edit';
  const sessionSummary = form.sessionTarget === 'isolated'
    ? `Private session under ${agentName}.`
    : form.sessionTarget === 'main'
      ? `Posts into the main thread for ${agentName}.`
      : 'Replies appear in the selected conversation and speak when Jane Live is open.';

  return (
    <dialog
      ref={dialogRef}
      onCancel={handleClose}
      onClick={handleDialogClick}
      aria-labelledby="cron-dialog-title"
      className="fixed inset-0 z-50 m-auto max-h-[calc(100dvh-1.067rem)] w-[min(1040px,calc(100vw-1.067rem))] overflow-y-auto rounded-[24px] border border-border/80 bg-card/96 p-0 shadow-[0_36px_90px_rgba(0,0,0,0.38)] backdrop:bg-black/52 backdrop:backdrop-blur-sm sm:max-h-[calc(100dvh-2rem)] sm:rounded-[30px]"
      style={{ overscrollBehavior: 'contain' }}
    >
      <form onSubmit={handleSubmit} onClick={(e) => e.stopPropagation()} className="flex flex-col">
        <div className="border-b border-border/70 bg-secondary/42 px-4 py-3 sm:px-5 sm:py-3.5">
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1">
              <div className="cockpit-kicker">
                <span className="text-primary">◆</span>
                Scheduler
              </div>
              <h2 id="cron-dialog-title" className="cockpit-title text-[1.15rem]">
                {isEdit ? 'Edit Job' : 'New Cron'}
              </h2>
              <p className="text-[0.733rem] leading-4.5 text-muted-foreground">
                {isEdit ? 'Update the selected scheduled job.' : 'Create a scheduled job.'}
              </p>
            </div>
            <button
              type="button"
              onClick={handleClose}
              className="shell-icon-button min-h-9 px-3"
              aria-label="Close"
            >
              <X size={14} />
            </button>
          </div>
        </div>

        <div className="grid gap-3 px-3 py-3 sm:gap-4 sm:px-4 sm:py-4 xl:grid-cols-[minmax(360px,0.92fr)_minmax(430px,1.08fr)]">
          <div className="space-y-4">
            <SectionShell
              eyebrow="Basics"
              title="Name and state"
              description="Name the job, add a short note, and choose the agent it belongs to."
            >
              <div className="grid gap-3">
                <div className="flex flex-col gap-1">
                  <label htmlFor="cron-name" className="cockpit-field-label">Name * required</label>
                  <input
                    id="cron-name"
                    type="text"
                    value={form.name}
                    onChange={(e) => updateForm('name', e.target.value)}
                    placeholder="Morning status digest"
                    className="cockpit-input"
                  />
                </div>
              </div>

              <div className="grid gap-3">
                <div className="flex flex-col gap-1">
                  <label htmlFor="cron-agent-id" className="cockpit-field-label">Agent ID</label>
                  <input
                    id="cron-agent-id"
                    type="text"
                    value={form.agentId}
                    onChange={(e) => updateForm('agentId', e.target.value)}
                    placeholder="main"
                    className="cockpit-input cockpit-input-mono"
                  />
                </div>
              </div>

              <div className="flex flex-col gap-1">
                <label htmlFor="cron-description" className="cockpit-field-label">Description</label>
                <textarea
                  id="cron-description"
                  value={form.description}
                  onChange={(e) => updateForm('description', e.target.value)}
                  rows={2}
                  placeholder="Short note for the team."
                  className="cockpit-textarea min-h-[84px]"
                />
              </div>

              <label className="flex items-center gap-2 rounded-2xl border border-border/70 bg-background/35 px-3 py-2 text-sm text-foreground">
                <input
                  type="checkbox"
                  checked={form.enabled}
                  onChange={(e) => updateForm('enabled', e.target.checked)}
                  className="h-4 w-4 rounded border-border bg-background text-primary focus:ring-primary"
                />
                <span>Enabled</span>
              </label>
            </SectionShell>

            <SectionShell
              eyebrow="Schedule"
              title="When it runs"
              description="Use the timing that matches the job."
            >
              <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(7rem,0.7fr)_minmax(0,1fr)]">
                <div className="flex flex-col gap-1">
                  <span className="cockpit-field-label">Type</span>
                  <CronSelect
                    value={form.scheduleKind}
                    onChange={(e) => updateForm('scheduleKind', e.target.value as ScheduleKind)}
                    aria-label="Schedule type"
                  >
                    <option value="every">Every</option>
                    <option value="cron">Cron expression</option>
                    <option value="at">One-shot</option>
                  </CronSelect>
                </div>
                {form.scheduleKind === 'every' && (
                  <>
                    <div className="flex flex-col gap-1">
                      <label htmlFor="cron-every" className="cockpit-field-label">Every *</label>
                      <input
                        id="cron-every"
                        type="number"
                        min="1"
                        step="1"
                        value={form.everyValue}
                        onChange={(e) => updateForm('everyValue', e.target.value)}
                        className="cockpit-input cockpit-input-mono"
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <span className="cockpit-field-label">Unit</span>
                      <CronSelect
                        value={form.everyUnit}
                        onChange={(e) => updateForm('everyUnit', e.target.value as CronFormState['everyUnit'])}
                        aria-label="Unit"
                      >
                        {EVERY_UNITS.map((unit) => (
                          <option key={unit.value} value={unit.value}>{unit.label}</option>
                        ))}
                      </CronSelect>
                    </div>
                  </>
                )}
              </div>

              {form.scheduleKind === 'cron' && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="flex flex-col gap-1">
                    <label htmlFor="cron-expr" className="cockpit-field-label">Cron expression</label>
                    <input
                      id="cron-expr"
                      type="text"
                      value={form.cronExpr}
                      onChange={(e) => updateForm('cronExpr', e.target.value)}
                      placeholder="0 9 * * *"
                      className="cockpit-input cockpit-input-mono"
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label htmlFor="cron-tz" className="cockpit-field-label">Timezone (optional)</label>
                    <input
                      id="cron-tz"
                      type="text"
                      value={form.cronTz}
                      onChange={(e) => updateForm('cronTz', e.target.value)}
                      placeholder="Europe/Berlin"
                      className="cockpit-input cockpit-input-mono"
                    />
                  </div>
                </div>
              )}

              {form.scheduleKind === 'at' && (
                <div className="flex flex-col gap-1">
                  <label htmlFor="cron-at-time" className="cockpit-field-label">Date &amp; time</label>
                  <input
                    id="cron-at-time"
                    type="datetime-local"
                    value={form.atTime}
                    onChange={(e) => updateForm('atTime', e.target.value)}
                    style={{ colorScheme: 'dark' }}
                    className="cockpit-input cockpit-input-mono [&::-webkit-calendar-picker-indicator]:brightness-[2.8] [&::-webkit-calendar-picker-indicator]:opacity-70 [&::-webkit-calendar-picker-indicator]:hover:opacity-100"
                  />
                </div>
              )}
            </SectionShell>

            <SectionShell
              eyebrow="Execution"
              title="What runs"
              description="Choose where it wakes and what it should do."
            >
              <div className="grid gap-3 md:grid-cols-[minmax(0,1.25fr)_minmax(0,0.85fr)]">
                <div className="flex flex-col gap-1">
                  <span className="cockpit-field-label">Session</span>
                  <CronSelect
                    value={form.sessionTarget}
                    onChange={(e) => updateForm('sessionTarget', e.target.value as SessionTarget)}
                    aria-label="Session"
                  >
                    <option value="main">Main event</option>
                    <option value="isolated">Private agent turn</option>
                    <option value={JANE_LIVE_TARGET}>Jane Live</option>
                    {form.sessionTarget.startsWith('session:') && form.sessionTarget !== JANE_LIVE_TARGET && (
                      <option value={form.sessionTarget}>Saved conversation</option>
                    )}
                  </CronSelect>
                </div>
                <div className="flex flex-col gap-1">
                  <span className="cockpit-field-label">Wake mode</span>
                  <CronSelect
                    value={form.wakeMode}
                    onChange={(e) => updateForm('wakeMode', e.target.value as WakeMode)}
                    aria-label="Wake mode"
                  >
                    {WAKE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </CronSelect>
                </div>
              </div>

              <div className="flex flex-col gap-1">
                <label htmlFor="cron-message" className="cockpit-field-label">What should run?</label>
                <textarea
                  id="cron-message"
                  value={form.message}
                  onChange={(e) => updateForm('message', e.target.value)}
                  rows={4}
                  placeholder={form.sessionTarget === 'main'
                    ? 'Reminder: standup in 10 minutes.'
                    : 'Check my inbox, summarise the important items, and flag anything that needs a reply.'}
                  className="cockpit-textarea min-h-[122px]"
                />
                <span className="cockpit-field-hint">{sessionSummary}</span>
              </div>

              <div className="flex flex-col gap-1">
                <label htmlFor="cron-timeout" className="cockpit-field-label">Timeout (seconds)</label>
                <input
                  id="cron-timeout"
                  type="number"
                  min="1"
                  step="1"
                  value={form.timeoutSeconds}
                  onChange={(e) => updateForm('timeoutSeconds', e.target.value)}
                  className="cockpit-input cockpit-input-mono"
                  placeholder="60"
                />
              </div>
            </SectionShell>
          </div>

          <div className="space-y-4">
            <SectionShell
              eyebrow="Delivery"
              title="What happens after it finishes"
              description="Choose whether the result stays inside Nerve or gets sent out."
            >
              <div className="flex flex-col gap-1">
                <span className="cockpit-field-label">Result delivery</span>
                <CronSelect
                  value={form.deliveryMode}
                  onChange={(e) => updateForm('deliveryMode', e.target.value as DeliveryMode)}
                  aria-label="Result delivery"
                >
                  <option value="announce">Send result to a channel</option>
                  <option value="none">Keep inside Nerve</option>
                </CronSelect>
              </div>

              {form.deliveryMode === 'announce' && (
                <div className="space-y-2.5">
                  {availableChannels.length === 0 ? (
                    <div className="rounded-[18px] border border-orange/30 bg-orange/6 px-3 py-3 text-[0.733rem] text-orange/85">
                      No messaging channels are configured yet. Set one up in OpenClaw first, or keep the job inside Nerve.
                    </div>
                  ) : (
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="flex flex-col gap-1">
                        <span className="cockpit-field-label">Channel</span>
                        <CronSelect
                          value={form.deliveryChannel}
                          onChange={(e) => updateForm('deliveryChannel', e.target.value)}
                          aria-label="Channel"
                        >
                          <option value="">Select channel…</option>
                          {availableChannels.map((channel) => (
                            <option key={channel} value={channel}>{CHANNEL_LABELS[channel] || channel}</option>
                          ))}
                        </CronSelect>
                      </div>
                      <div className="flex flex-col gap-1">
                        <label htmlFor="cron-deliver-to" className="cockpit-field-label">To</label>
                        <input
                          id="cron-deliver-to"
                          type="text"
                          value={form.deliveryTo}
                          onChange={(e) => updateForm('deliveryTo', e.target.value)}
                          placeholder={CHANNEL_PLACEHOLDERS[form.deliveryChannel] || 'recipient ID'}
                          className="cockpit-input cockpit-input-mono"
                        />
                      </div>
                    </div>
                  )}
                </div>
              )}

              <label className="flex items-center gap-2 rounded-2xl border border-border/70 bg-background/35 px-3 py-2 text-sm text-foreground">
                <input
                  type="checkbox"
                  checked={form.bestEffortDelivery}
                  onChange={(e) => updateForm('bestEffortDelivery', e.target.checked)}
                  className="h-4 w-4 rounded border-border bg-background text-primary focus:ring-primary"
                />
                <span>Best effort delivery</span>
              </label>
            </SectionShell>

            <SectionShell
              eyebrow="Advanced"
              title="Extra controls"
              description="Keep recovery paths, routing, and model controls in one place."
            >
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="flex min-h-11 items-center gap-2 rounded-[14px] border border-border/70 bg-background/30 px-3 text-sm text-foreground">
                  <input
                    type="checkbox"
                    checked={form.deleteAfterRun}
                    onChange={(e) => updateForm('deleteAfterRun', e.target.checked)}
                    className="h-4 w-4 rounded border-border bg-background text-primary focus:ring-primary"
                  />
                  <span>Delete after run</span>
                </label>

                <label className="flex min-h-11 items-center gap-2 rounded-[14px] border border-border/70 bg-background/30 px-3 text-sm text-foreground">
                  <input
                    type="checkbox"
                    checked={form.clearAgentOverride}
                    onChange={(e) => updateForm('clearAgentOverride', e.target.checked)}
                    className="h-4 w-4 rounded border-border bg-background text-primary focus:ring-primary"
                  />
                  <span>Clear agent override</span>
                </label>
              </div>

              <div className="grid gap-3">
                <div className="flex flex-col gap-1">
                  <label htmlFor="cron-session-key" className="cockpit-field-label">Session key</label>
                  <input
                    id="cron-session-key"
                    type="text"
                    value={form.sessionKey}
                    onChange={(e) => updateForm('sessionKey', e.target.value)}
                    placeholder="agent:main:main"
                    className="cockpit-input cockpit-input-mono"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label htmlFor="cron-account-id" className="cockpit-field-label">Account ID</label>
                  <input
                    id="cron-account-id"
                    type="text"
                    value={form.accountId}
                    onChange={(e) => updateForm('accountId', e.target.value)}
                    placeholder="channel account ID"
                    className="cockpit-input cockpit-input-mono"
                  />
                </div>

                <div className="flex flex-col gap-1">
                  <span className="cockpit-field-label">Model</span>
                  <CronSelect
                    value={form.model}
                    onChange={(e) => updateForm('model', e.target.value)}
                    aria-label="Model"
                  >
                    {models.map((option) => (
                      <option key={option.value || 'default-model'} value={option.value}>{option.label}</option>
                    ))}
                  </CronSelect>
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <label className="flex min-h-11 items-center gap-2 rounded-[14px] border border-border/70 bg-background/30 px-3 text-sm text-foreground">
                  <input
                    type="checkbox"
                    checked={form.lightContext}
                    onChange={(e) => updateForm('lightContext', e.target.checked)}
                    className="h-4 w-4 rounded border-border bg-background text-primary focus:ring-primary"
                  />
                  <span>Light context</span>
                </label>

                <div className="flex flex-col gap-1">
                  <span className="cockpit-field-label">Thinking</span>
                  <CronSelect
                    value={form.thinking}
                    onChange={(e) => updateForm('thinking', e.target.value as ThinkingLevel)}
                    aria-label="Thinking"
                  >
                    {THINKING_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </CronSelect>
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="flex flex-col gap-1">
                  <label htmlFor="cron-failure-alerts" className="cockpit-field-label">Failure alerts</label>
                  <input
                    id="cron-failure-alerts"
                    type="text"
                    value={form.failureAlerts}
                    onChange={(e) => updateForm('failureAlerts', e.target.value)}
                    placeholder="off"
                    className="cockpit-input cockpit-input-mono"
                  />
                </div>
              </div>
            </SectionShell>

            {error && <div className="cockpit-note" data-tone="danger">{error}</div>}

            <div className="flex flex-col items-stretch gap-3 rounded-[18px] border border-border/70 bg-background/30 px-3.5 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
              <p className="text-[0.833rem] leading-5 text-muted-foreground">
                {isEdit ? 'Save when the settings look right.' : 'Create the job when the settings look right.'}
              </p>
              <button
                type="submit"
                disabled={submitting}
                className="inline-flex min-h-10 items-center justify-center rounded-[14px] bg-primary px-5 text-sm font-semibold text-primary-foreground shadow-[0_10px_22px_rgba(0,0,0,0.18)] transition-transform hover:-translate-y-px hover:bg-primary/95 disabled:cursor-not-allowed disabled:opacity-50 sm:shrink-0"
              >
                {submitting ? (isEdit ? 'Saving...' : 'Creating...') : (isEdit ? 'Save Changes' : 'Create Cron')}
              </button>
            </div>
          </div>
        </div>
      </form>
    </dialog>
  );
}
