import { gatewayRpcCall } from './gateway-rpc.js';

const EDIT_DATE = '2026-07-25';
const RPC_TIMEOUT_MS = 60_000;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/;

export const JANE_OPERATING_CRONS = [
  ['01a2c6e0-f218-40e2-a16a-868add41fe98', 'Jane Capability Audit'],
  ['05072c24-c96e-499b-bf09-ac5f238aa5d8', 'OpenClaw Orchestrator Tick'],
  ['1c91b17d-f2e2-41f5-8b4a-a60d5b550da1', 'Services Watchdog'],
  ['2a8997bb-df41-46b9-9de6-2df636a11150', 'OpenClaw Work Runner'],
  ['4a9e36b2-9ca0-46ac-9b5f-8453fbfd4226', 'Retention Guardian'],
  ['5e380036-829d-4ed6-be70-99f593e56837', 'Jane Whitmore Active Loop'],
  ['61903d57-5ee5-4a14-9807-295734e6d687', 'OpenClaw Monitor Heartbeat'],
  ['6ba3036e-731f-4287-8de1-1a7ddede6e56', 'Business Heartbeat - Mentor Pulse'],
  ['6c7a06fe-1708-4434-9e68-a7ca8c57a1ff', 'Nightly Reflection'],
  ['6db891e3-1922-4545-bd64-ebfbc77416a5', 'OmniBrain Learn'],
  ['a600f637-501b-4cbb-9103-467f0a6696c3', 'Jane Task Ledger Audit'],
  ['bf56ca22-d3f3-4bd3-9636-6c290e30d307', 'CRM and Outreach Watch'],
  ['c0cefe41-562d-4c16-85cc-7ab1f6ee0b05', 'Mentoring'],
  ['d03f6b19-d8bb-46d6-9a54-de28ac4d0149', 'Omni-Nerve Task Sync'],
  ['e0560373-4143-4aaa-b3cb-2c5d927e4a2a', 'Weekly Mentor Review'],
] as const;

type GatewayCall = typeof gatewayRpcCall;
type SendFrame = (frame: string) => void;
type ProgressState = 'started' | 'running' | 'completed' | 'failed';

interface CronJob {
  id?: unknown;
  name?: unknown;
  enabled?: unknown;
  schedule?: unknown;
  state?: unknown;
  lastRunAtMs?: unknown;
  lastRunStatus?: unknown;
}

interface GroupStatus {
  group: 'openclaw-operating-crons';
  edit_date: string;
  available: boolean;
  state: 'enabled' | 'disabled' | 'mixed';
  jobs: Array<{
    id: string;
    name: string;
    enabled: boolean;
    schedule: string;
    last_run_at: string | null;
    last_status: 'ok' | 'error' | 'unknown';
  }>;
  mismatches: string[];
}

class CronControlError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

function publicError(error: unknown): CronControlError {
  return error instanceof CronControlError
    ? error
    : new CronControlError('cron_unavailable', 'Cron control is temporarily unavailable.');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cronJobs(result: unknown): CronJob[] {
  if (Array.isArray(result)) return result as CronJob[];
  if (!isRecord(result)) return [];
  if (Array.isArray(result.jobs)) return result.jobs as CronJob[];
  if (isRecord(result.details) && Array.isArray(result.details.jobs)) return result.details.jobs as CronJob[];
  return [];
}

function scheduleLabel(value: unknown): string {
  if (!isRecord(value)) return 'unknown';
  if (value.kind === 'every' && typeof value.everyMs === 'number') return `every ${Math.round(value.everyMs / 1000)}s`;
  if (value.kind === 'cron' && typeof value.expr === 'string') return `cron ${value.expr}`;
  if (value.kind === 'at' && typeof value.at === 'string') return `at ${value.at}`;
  return 'unknown';
}

function lastRun(job: CronJob): { at: string | null; status: 'ok' | 'error' | 'unknown' } {
  const state = isRecord(job.state) ? job.state : {};
  const atValue = typeof state.lastRunAtMs === 'number' ? state.lastRunAtMs : job.lastRunAtMs;
  const at = typeof atValue === 'number' && Number.isFinite(atValue) ? new Date(atValue).toISOString() : null;
  const raw = typeof state.lastRunStatus === 'string' ? state.lastRunStatus : job.lastRunStatus;
  return { at, status: raw === 'ok' ? 'ok' : raw === 'error' ? 'error' : 'unknown' };
}

function response(id: string, ok: boolean, payload?: unknown, code?: string, message?: string): string {
  return JSON.stringify(ok
    ? { type: 'res', id, ok: true, payload }
    : { type: 'res', id, ok: false, error: { code, message } });
}

function progress(id: string, state: ProgressState, label: string): string {
  return JSON.stringify({
    type: 'event',
    event: 'nerve.agent.progress',
    payload: { request_id: id, state, label },
  });
}

async function updateCron(gatewayCall: GatewayCall, id: string, enabled: boolean): Promise<void> {
  try {
    await gatewayCall('cron.update', { id, patch: { enabled } }, RPC_TIMEOUT_MS);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (!/required property 'jobId'|unexpected property 'id'/.test(message)) throw error;
    await gatewayCall('cron.update', { jobId: id, patch: { enabled } }, RPC_TIMEOUT_MS);
  }
}

export function isJaneMobileCronControlRequest(message: Record<string, unknown>): boolean {
  if (message.type !== 'req' || typeof message.id !== 'string' || message.id.length < 1 || message.id.length > 128) return false;
  if (!isRecord(message.params)) return false;
  if (message.method === 'nerve.cron.group.status') return Object.keys(message.params).length === 0;
  if (message.method !== 'nerve.cron.group.setEnabled') return false;
  return Object.keys(message.params).every((key) => key === 'enabled' || key === 'idempotencyKey')
    && typeof message.params.enabled === 'boolean'
    && typeof message.params.idempotencyKey === 'string'
    && IDEMPOTENCY_KEY_RE.test(message.params.idempotencyKey);
}

export interface JaneMobileCronController {
  handle(data: Buffer | string, isBinary: boolean, send: SendFrame): boolean;
}

export function createJaneMobileCronController(gatewayCall: GatewayCall = gatewayRpcCall): JaneMobileCronController {
  const operations = new Map<string, { enabled: boolean; promise: Promise<GroupStatus> }>();

  async function status(): Promise<GroupStatus> {
    const result = await gatewayCall('cron.list', { includeDisabled: true }, RPC_TIMEOUT_MS);
    const byId = new Map(cronJobs(result).map((job) => [String(job.id || ''), job]));
    const mismatches: string[] = [];
    const jobs = JANE_OPERATING_CRONS.map(([id, base]) => {
      const job = byId.get(id);
      const expectedName = `${base} [edited ${EDIT_DATE}]`;
      if (!job) mismatches.push(`${base}:missing`);
      else if (job.name !== expectedName) mismatches.push(`${base}:name_changed`);
      const run = lastRun(job || {});
      return {
        id,
        name: typeof job?.name === 'string' ? job.name : expectedName,
        enabled: job?.enabled === true,
        schedule: scheduleLabel(job?.schedule),
        last_run_at: run.at,
        last_status: run.status,
      };
    });
    const enabledCount = jobs.filter((job) => job.enabled).length;
    return {
      group: 'openclaw-operating-crons',
      edit_date: EDIT_DATE,
      available: mismatches.length === 0,
      state: enabledCount === 0 ? 'disabled' : enabledCount === jobs.length ? 'enabled' : 'mixed',
      jobs,
      mismatches,
    };
  }

  async function setEnabled(enabled: boolean, send: SendFrame, requestId: string): Promise<GroupStatus> {
    const before = await status();
    if (!before.available) throw new CronControlError('cron_group_changed', 'The operating cron group no longer matches its approved allowlist.');
    const changed: Array<{ id: string; enabled: boolean }> = [];
    try {
      for (const job of before.jobs) {
        if (job.enabled === enabled) continue;
        send(progress(requestId, 'running', job.name.replace(/\s+\[edited \d{4}-\d{2}-\d{2}\]$/, '')));
        await updateCron(gatewayCall, job.id, enabled);
        changed.push({ id: job.id, enabled: job.enabled });
      }
    } catch {
      await Promise.allSettled(changed.reverse().map((job) => updateCron(gatewayCall, job.id, job.enabled)));
      throw new CronControlError('cron_update_failed', 'The cron group could not be updated safely.');
    }
    return status();
  }

  return {
    handle(data, isBinary, send) {
      if (isBinary) return false;
      let message: Record<string, unknown>;
      try {
        const parsed = JSON.parse(data.toString()) as unknown;
        if (!isRecord(parsed) || typeof parsed.method !== 'string' || !parsed.method.startsWith('nerve.cron.group.')) return false;
        message = parsed;
      } catch {
        return false;
      }

      const id = typeof message.id === 'string' ? message.id : '';
      if (!isJaneMobileCronControlRequest(message)) {
        send(response(id, false, undefined, 'invalid_request', 'Unsupported or malformed cron group request.'));
        return true;
      }

      const params = message.params as Record<string, unknown>;
      if (message.method === 'nerve.cron.group.status') {
        void status()
          .then((result) => send(response(id, true, result)))
          .catch(() => send(response(id, false, undefined, 'cron_unavailable', 'Cron status is temporarily unavailable.')));
        return true;
      }

      const enabled = params.enabled as boolean;
      const key = params.idempotencyKey as string;
      const existing = operations.get(key);
      if (existing && existing.enabled !== enabled) {
        send(response(id, false, undefined, 'idempotency_conflict', 'This request key was already used for another state.'));
        return true;
      }
      if (existing) {
        void existing.promise
          .then((result) => send(response(id, true, result)))
          .catch((error) => {
            const safe = publicError(error);
            send(response(id, false, undefined, safe.code, safe.message));
          });
        return true;
      }

      send(progress(id, 'started', enabled ? 'Enabling operating schedules' : 'Disabling operating schedules'));
      const promise = setEnabled(enabled, send, id);
      operations.set(key, { enabled, promise });
      if (operations.size > 128) operations.delete(operations.keys().next().value!);
      void promise
        .then((result) => {
          send(progress(id, 'completed', enabled ? 'Operating schedules enabled' : 'Operating schedules disabled'));
          send(response(id, true, result));
        })
        .catch((error) => {
          const safe = publicError(error);
          send(progress(id, 'failed', 'Operating schedule update failed'));
          send(response(id, false, undefined, safe.code, safe.message));
        });
      return true;
    },
  };
}
