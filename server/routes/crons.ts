/**
 * Cron API Routes — proxy to OpenClaw gateway
 *
 * GET    /api/crons            — List all cron jobs
 * POST   /api/crons            — Create a new cron job
 * PATCH  /api/crons/:id        — Update a cron job
 * DELETE /api/crons/:id        — Delete a cron job
 * POST   /api/crons/:id/toggle — Toggle enabled/disabled
 * POST   /api/crons/:id/run    — Run a cron job immediately
 * GET    /api/crons/:id/runs   — Get run history
 */

import { Hono } from 'hono';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { config } from '../lib/config.js';
import { invokeGatewayTool } from '../lib/gateway-client.js';
import { gatewayRpcCall } from '../lib/gateway-rpc.js';
import { getPhoneCronSelection, setPhoneCronSelection } from '../lib/jane-mobile-cron-control.js';
import { rateLimitGeneral } from '../middleware/rate-limit.js';

const scheduleSchema = z.union([
  z.object({ kind: z.literal('at'), at: z.string() }),
  z.object({ kind: z.literal('every'), everyMs: z.number(), anchorMs: z.number().optional() }),
  z.object({ kind: z.literal('cron'), expr: z.string(), tz: z.string().optional() }),
]);

const payloadSchema = z.union([
  z.object({ kind: z.literal('systemEvent'), text: z.string() }),
  z.object({
    kind: z.literal('agentTurn'),
    message: z.string(),
    model: z.string().optional(),
    thinking: z.string().optional(),
    timeoutSeconds: z.number().optional(),
    lightContext: z.boolean().optional(),
    toolsAllow: z.array(z.string()).optional(),
  }),
  z.object({
    kind: z.literal('command'),
    argv: z.array(z.string()),
    cwd: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
    input: z.string().optional(),
    timeoutSeconds: z.number().optional(),
    noOutputTimeoutSeconds: z.number().optional(),
    outputMaxBytes: z.number().optional(),
  }),
]);

const deliverySchema = z.object({
  mode: z.enum(['none', 'announce']).optional(),
  channel: z.string().optional(),
  to: z.string().optional(),
  accountId: z.string().optional(),
  threadId: z.string().optional(),
  bestEffort: z.boolean().optional(),
}).passthrough().optional();

const sessionAgentIdSchema = z.string().max(200).optional();
const sessionTargetSchema = z.union([z.enum(['main', 'isolated']), z.string().max(208).regex(/^session:.+/)]);

const cronJobSchema = z.object({
  job: z.object({
    name: z.string().min(1).max(200).optional(),
    schedule: scheduleSchema.optional(),
    payload: payloadSchema.optional(),
    delivery: deliverySchema,
    sessionTarget: sessionTargetSchema.optional(),
    sessionKey: z.string().max(200).optional(),
    agentId: sessionAgentIdSchema,
    enabled: z.boolean().optional(),
    notify: z.boolean().optional(),
    // Legacy compat — Nerve may send these flat fields
    prompt: z.string().max(10000).optional(),
    model: z.string().max(200).optional(),
    thinkingLevel: z.string().max(50).optional(),
    channel: z.string().max(200).optional(),
  }).passthrough(),
});

const cronPatchSchema = z.object({
  patch: z.object({
    name: z.string().min(1).max(200).optional(),
    schedule: scheduleSchema.optional(),
    payload: payloadSchema.optional(),
    delivery: deliverySchema,
    sessionTarget: sessionTargetSchema.optional(),
    sessionKey: z.string().max(200).optional(),
    agentId: sessionAgentIdSchema,
    enabled: z.boolean().optional(),
    notify: z.boolean().optional(),
    prompt: z.string().max(10000).optional(),
    model: z.string().max(200).optional(),
    thinkingLevel: z.string().max(50).optional(),
    channel: z.string().max(200).optional(),
  }).passthrough(),
});

const app = new Hono();

const GATEWAY_RUN_TIMEOUT_MS = 60_000;
const MANUAL_CRON_RUNS_DIR = join(config.home, '.openclaw', 'cron', 'nerve-manual-runs');
const LOCAL_CRON_JOBS_FILE = join(config.home, '.openclaw', 'cron', 'jobs.json');
const LOCAL_CRON_STATE_FILE = join(config.home, '.openclaw', 'cron', 'jobs-state.json');
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
  'effectiveAgentId',
  'displayName',
  'declarationKey',
  'status',
  'lastRunError',
  'lastFailureNotificationDelivered',
  'nextRunAtMs',
  'lastRunAtMs',
  'lastRunStatus',
  'lastDelivered',
  'lastDeliveryError',
  'lastFailureNotificationDeliveryStatus',
  'clearAgentOverride',
  'systemOwned',
  'availableOnPhone',
  'phoneSelectable',
]);

type CronMutationInput = {
  sessionKey?: string;
  agentId?: string;
  sessionTarget?: string;
  payload?: unknown;
  thinkingLevel?: unknown;
  [key: string]: unknown;
};

interface ManualCronRunEntry {
  ts: number;
  jobId: string;
  action: 'spawned';
  status: 'ok';
  summary: string;
  runAtMs: number;
  nextRunAtMs?: number;
  childSessionKey?: string;
  runId?: string;
  manual: true;
}

function getCronJobsFromResult(result: unknown): Record<string, unknown>[] {
  const r = result as {
    jobs?: unknown;
    details?: { jobs?: unknown };
    content?: Array<{ type?: string; text?: string }>;
  };
  if (Array.isArray(r?.jobs)) return r.jobs as Record<string, unknown>[];
  if (Array.isArray(r?.details?.jobs)) return r.details.jobs as Record<string, unknown>[];
  if (Array.isArray(r?.content)) {
    for (const item of r.content) {
      if (item?.type !== 'text' || typeof item.text !== 'string') continue;
      try {
        const parsed = JSON.parse(item.text) as { jobs?: unknown };
        if (Array.isArray(parsed.jobs)) return parsed.jobs as Record<string, unknown>[];
      } catch {
        // Keep looking. Some gateway text items are not JSON cron payloads.
      }
    }
  }
  return Array.isArray(result) ? result as Record<string, unknown>[] : [];
}

function getCronRunEntriesFromResult(result: unknown): Record<string, unknown>[] {
  const r = result as { runs?: unknown; details?: { entries?: unknown; runs?: unknown } };
  if (Array.isArray(r?.runs)) return r.runs as Record<string, unknown>[];
  if (Array.isArray(r?.details?.entries)) return r.details.entries as Record<string, unknown>[];
  if (Array.isArray(r?.details?.runs)) return r.details.runs as Record<string, unknown>[];
  return Array.isArray(result) ? result as Record<string, unknown>[] : [];
}

function getManualCronRunsFilePath(jobId: string): string {
  return join(MANUAL_CRON_RUNS_DIR, `${jobId}.jsonl`);
}

async function appendManualCronRunEntry(jobId: string, entry: ManualCronRunEntry): Promise<void> {
  await fs.mkdir(MANUAL_CRON_RUNS_DIR, { recursive: true });
  await fs.appendFile(getManualCronRunsFilePath(jobId), `${JSON.stringify(entry)}\n`, 'utf8');
}

async function readManualCronRunEntries(jobId: string): Promise<Record<string, unknown>[]> {
  try {
    const raw = await fs.readFile(getManualCronRunsFilePath(jobId), 'utf8');
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function readFirstJsonFile<T>(filePaths: string[]): Promise<T | null> {
  for (const filePath of filePaths) {
    const parsed = await readJsonFile<T>(filePath);
    if (parsed) return parsed;
  }
  return null;
}

function sortCronRunEntries(entries: Record<string, unknown>[]): Record<string, unknown>[] {
  return [...entries].sort((a, b) => {
    const aTs = Number(a.ts || a.runAtMs || 0);
    const bTs = Number(b.ts || b.runAtMs || 0);
    return bTs - aTs;
  });
}

async function mergeManualRunStateIntoJobs(jobs: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
  return Promise.all(jobs.map(async (job) => {
    const jobId = typeof job.id === 'string'
      ? job.id
      : typeof job.jobId === 'string'
        ? job.jobId
        : '';
    if (!jobId) return job;

    const latestManualEntry = sortCronRunEntries(await readManualCronRunEntries(jobId))[0];
    const latestManualTs = Number(latestManualEntry?.ts || latestManualEntry?.runAtMs || 0);
    if (!latestManualTs) return job;

    const state = ((job.state as Record<string, unknown> | undefined) ?? {});
    const gatewayLastRunTs = typeof state.lastRunAtMs === 'number' ? state.lastRunAtMs : 0;
    if (gatewayLastRunTs >= latestManualTs) return job;

    return {
      ...job,
      state: {
        ...state,
        lastRunAtMs: latestManualTs,
      },
    };
  }));
}

async function mergeLocalCronFallbackIntoJobs(jobs: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
  const [localJobsFile, localStateFile] = await Promise.all([
    readFirstJsonFile<{ jobs?: Record<string, unknown>[] }>([LOCAL_CRON_JOBS_FILE]),
    readFirstJsonFile<{ jobs?: Record<string, { state?: Record<string, unknown> }> }>([LOCAL_CRON_STATE_FILE]),
  ]);

  const localJobs = Array.isArray(localJobsFile?.jobs) ? localJobsFile.jobs : [];
  if (!localJobs.length) return jobs;

  const jobsById = new Map<string, Record<string, unknown>>();
  for (const job of jobs) {
    const jobId = typeof job.id === 'string'
      ? job.id
      : typeof job.jobId === 'string'
        ? job.jobId
        : '';
    if (jobId) jobsById.set(jobId, job);
  }

  const localStateById = localStateFile?.jobs ?? {};
  const merged = [...jobs];
  for (const localJob of localJobs) {
    const jobId = typeof localJob.id === 'string'
      ? localJob.id
      : typeof localJob.jobId === 'string'
        ? localJob.jobId
        : '';
    if (!jobId || jobsById.has(jobId)) continue;

    const localState = localStateById[jobId]?.state ?? {};
    // The gateway may omit disabled jobs; merge the canonical local cron store so Off jobs stay visible.
    merged.push({
      ...localJob,
      state: localState,
    });
  }

  return merged;
}

function replaceCronJobsInResult(result: unknown, jobs: Record<string, unknown>[]): unknown {
  const r = result as {
    jobs?: unknown;
    details?: Record<string, unknown>;
    content?: Array<{ type?: string; text?: string }>;
  };
  const syncContent = (nextResult: Record<string, unknown>) => {
    if (!Array.isArray(r?.content)) return nextResult;
    const nextContent = r.content.map((item) => {
      if (item?.type !== 'text' || typeof item.text !== 'string') return item;
      try {
        const parsed = JSON.parse(item.text) as Record<string, unknown>;
        if (!Array.isArray(parsed.jobs)) return item;
        return {
          ...item,
          text: JSON.stringify({ ...parsed, jobs, total: jobs.length }, null, 2),
        };
      } catch {
        return item;
      }
    });
    return {
      ...nextResult,
      content: nextContent,
    };
  };
  if (Array.isArray(r?.jobs)) {
    return syncContent({ ...r, jobs, total: jobs.length });
  }
  if (Array.isArray(r?.details?.jobs)) {
    return syncContent({
      ...r,
      details: {
        ...r.details,
        jobs,
        total: jobs.length,
      },
      total: jobs.length,
    });
  }
  if (Array.isArray(result)) {
    return jobs;
  }
  if (r && typeof r === 'object') {
    return syncContent({ ...r, jobs, total: jobs.length });
  }
  return result;
}

async function getGatewayCronRunEntries(jobId: string): Promise<Record<string, unknown>[]> {
  try {
    const gatewayResult = await gatewayRpcCall('cron.runs', {
      jobId,
      limit: 10,
    }, GATEWAY_RUN_TIMEOUT_MS);
    return getCronRunEntriesFromResult(gatewayResult);
  } catch (err) {
    console.warn('[crons] gateway runs unavailable, falling back to manual history only:', (err as Error).message);
    return [];
  }
}

async function gatewayCronUpdate(jobId: string, patch: Record<string, unknown>): Promise<unknown> {
  try {
    return await gatewayRpcCall('cron.update', {
      id: jobId,
      patch,
    }, GATEWAY_RUN_TIMEOUT_MS);
  } catch (err) {
    const message = (err as Error).message || '';
    if (!/required property 'jobId'|unexpected property 'id'/.test(message)) {
      throw err;
    }
    return gatewayRpcCall('cron.update', {
      jobId,
      patch,
    }, GATEWAY_RUN_TIMEOUT_MS);
  }
}

function deriveAgentIdFromSessionKey(sessionKey?: string): string | undefined {
  if (!sessionKey) return undefined;
  const match = sessionKey.match(/^agent:([^:]+):/);
  return match?.[1];
}

function normalizeCronTarget<T extends CronMutationInput>(job: T): T {
  const cleanedJob: CronMutationInput = { ...job };
  for (const key of CRON_READONLY_KEYS) {
    delete cleanedJob[key];
  }

  const agentId = deriveAgentIdFromSessionKey(cleanedJob.sessionKey);
  const normalizedAgentId = agentId ?? cleanedJob.agentId;
  const normalizedJob = agentId ? { ...cleanedJob, agentId } : { ...cleanedJob };
  const hasPayload = normalizedJob.payload !== undefined;
  const payload = { ...((normalizedJob.payload || {}) as Record<string, unknown>) };
  const thinkingLevel = typeof normalizedJob.thinkingLevel === 'string'
    ? normalizedJob.thinkingLevel.trim()
    : '';
  const topLevelModel = typeof normalizedJob.model === 'string'
    ? normalizedJob.model.trim()
    : '';
  const topLevelTimeoutSeconds = typeof normalizedJob.timeoutSeconds === 'number'
    ? normalizedJob.timeoutSeconds
    : undefined;
  if (payload.kind === 'agentTurn') {
    if (topLevelModel && typeof payload.model !== 'string') payload.model = topLevelModel;
    if (topLevelTimeoutSeconds !== undefined && typeof payload.timeoutSeconds !== 'number') {
      payload.timeoutSeconds = topLevelTimeoutSeconds;
    }
    if (typeof normalizedJob.lightContext === 'boolean' && typeof payload.lightContext !== 'boolean') {
      payload.lightContext = normalizedJob.lightContext;
    }
  }
  const payloadWithThinking = thinkingLevel && payload.kind === 'agentTurn'
    // The gateway accepts thinking on the payload shape, not as a top-level field.
    ? { ...payload, thinking: thinkingLevel }
    : payload;
  const jobWithoutThinkingLevel = { ...normalizedJob } as Record<string, unknown>;
  delete jobWithoutThinkingLevel.thinkingLevel;
  delete jobWithoutThinkingLevel.model;
  delete jobWithoutThinkingLevel.timeoutSeconds;
  delete jobWithoutThinkingLevel.lightContext;
  delete jobWithoutThinkingLevel.failureAlerts;

  if (typeof jobWithoutThinkingLevel.bestEffortDelivery === 'boolean') {
    const delivery = {
      ...((jobWithoutThinkingLevel.delivery || {}) as Record<string, unknown>),
      bestEffort: jobWithoutThinkingLevel.bestEffortDelivery,
    };
    jobWithoutThinkingLevel.delivery = delivery;
    delete jobWithoutThinkingLevel.bestEffortDelivery;
  }

  if (typeof jobWithoutThinkingLevel.accountId === 'string' && jobWithoutThinkingLevel.accountId.trim()) {
    const delivery = {
      ...((jobWithoutThinkingLevel.delivery || {}) as Record<string, unknown>),
      accountId: jobWithoutThinkingLevel.accountId.trim(),
    };
    jobWithoutThinkingLevel.delivery = delivery;
    delete jobWithoutThinkingLevel.accountId;
  } else {
    delete jobWithoutThinkingLevel.accountId;
  }

  if (
    normalizedAgentId
    && normalizedAgentId !== 'main'
    && normalizedJob.sessionTarget === 'main'
    && payload.kind === 'agentTurn'
  ) {
    // Gateway only permits root `main` targeting for the default agent. Keep
    // saved agent cron edits recoverable by preserving the agent and isolating the run.
    return {
      ...jobWithoutThinkingLevel,
      ...(hasPayload ? { payload: payloadWithThinking } : {}),
      sessionTarget: 'isolated',
    } as T;
  }

  return {
    ...jobWithoutThinkingLevel,
    ...(hasPayload ? { payload: payloadWithThinking } : {}),
  } as T;
}

function isIsolatedAgentTurnCron(job: Record<string, unknown>): boolean {
  const payload = (job.payload || {}) as Record<string, unknown>;
  return job.sessionTarget === 'isolated'
    && payload.kind === 'agentTurn'
    && typeof payload.message === 'string'
    && payload.message.trim().length > 0;
}

function buildCronSpawnLabel(job: Record<string, unknown>): string {
  const base = typeof job.name === 'string' && job.name.trim()
    ? job.name.trim()
    : `cron ${String(job.id || job.jobId || '').slice(0, 8)}`;
  const stamp = new Date().toISOString().slice(11, 16);
  return `Cron · ${base} · ${stamp}`;
}

app.get('/api/crons', rateLimitGeneral, async (c) => {
  try {
    // Current OpenClaw exposes cron management as gateway RPC methods, not
    // as a generic /tools/invoke tool. Use RPC so the UI does not show a false
    // "gateway.tools.allow" warning when the config is already correct.
    const result = await gatewayRpcCall('cron.list', {
      includeDisabled: true,
    }, GATEWAY_RUN_TIMEOUT_MS);
    const jobs = getCronJobsFromResult(result);
    const localFallbackJobs = await mergeLocalCronFallbackIntoJobs(jobs);
    const mergedJobs = localFallbackJobs.length > 0 ? await mergeManualRunStateIntoJobs(localFallbackJobs) : localFallbackJobs;
    const selected = new Set(await getPhoneCronSelection());
    const phoneJobs = mergedJobs.map((job) => ({
      ...job,
      availableOnPhone: selected.has(String(job.id || job.jobId || '')),
      phoneSelectable: job.declarationKey == null && job.systemOwned !== true,
    }));
    return c.json({ ok: true, result: replaceCronJobsInResult(result, phoneJobs) });
  } catch (err) {
    console.error('[crons] list error:', (err as Error).message);
    return c.json({ ok: false, error: (err as Error).message }, 502);
  }
});

app.post('/api/crons/:id/phone-selection', rateLimitGeneral, async (c) => {
  const id = c.req.param('id');
  try {
    const body = await c.req.json() as { available?: unknown };
    if (typeof body.available !== 'boolean') return c.json({ ok: false, error: 'available must be a boolean' }, 400);
    const result = await gatewayRpcCall('cron.list', { includeDisabled: true }, GATEWAY_RUN_TIMEOUT_MS);
    const job = getCronJobsFromResult(result).find((entry) => String(entry.id || entry.jobId || '') === id);
    if (!job) return c.json({ ok: false, error: 'Cron job not found' }, 404);
    if (job.declarationKey != null || job.systemOwned === true) {
      return c.json({ ok: false, error: 'This cron cannot be selected for phone control' }, 403);
    }
    const jobIds = await setPhoneCronSelection(id, body.available);
    return c.json({ ok: true, availableOnPhone: jobIds.includes(id) });
  } catch (err) {
    console.error('[crons] phone selection error:', (err as Error).message);
    return c.json({ ok: false, error: 'Phone cron selection could not be saved' }, 500);
  }
});

app.post('/api/crons', rateLimitGeneral, async (c) => {
  try {
    const raw = await c.req.json();
    const parsed = cronJobSchema.safeParse(raw);
    if (!parsed.success) return c.json({ ok: false, error: parsed.error.issues[0]?.message || 'Invalid body' }, 400);
    const body = parsed.data;
    const normalizedJob = normalizeCronTarget(body.job);
    const result = await gatewayRpcCall('cron.add', {
      job: normalizedJob,
    }, GATEWAY_RUN_TIMEOUT_MS);
    return c.json({ ok: true, result });
  } catch (err) {
    console.error('[crons] add error:', (err as Error).message);
    return c.json({ ok: false, error: (err as Error).message }, 502);
  }
});

app.patch('/api/crons/:id', rateLimitGeneral, async (c) => {
  const id = c.req.param('id');
  try {
    const raw = await c.req.json();
    const parsed = cronPatchSchema.safeParse(raw);
    if (!parsed.success) return c.json({ ok: false, error: parsed.error.issues[0]?.message || 'Invalid body' }, 400);
    const body = parsed.data;
    const normalizedPatch = normalizeCronTarget(body.patch);
    const result = await gatewayCronUpdate(id, normalizedPatch);
    return c.json({ ok: true, result });
  } catch (err) {
    console.error('[crons] update error:', (err as Error).message);
    return c.json({ ok: false, error: (err as Error).message }, 502);
  }
});

app.delete('/api/crons/:id', rateLimitGeneral, async (c) => {
  const id = c.req.param('id');
  try {
    const result = await gatewayRpcCall('cron.remove', {
      jobId: id,
    }, GATEWAY_RUN_TIMEOUT_MS);
    try {
      await setPhoneCronSelection(id, false);
    } catch (selectionError) {
      console.warn('[crons] removed job phone selection cleanup failed:', (selectionError as Error).message);
    }
    return c.json({ ok: true, result });
  } catch (err) {
    console.error('[crons] remove error:', (err as Error).message);
    return c.json({ ok: false, error: (err as Error).message }, 502);
  }
});

app.post('/api/crons/:id/toggle', rateLimitGeneral, async (c) => {
  const id = c.req.param('id');
  // Get current state first, then flip
  try {
    const body = await c.req.json<{ enabled: boolean }>().catch(() => ({ enabled: true }));
    const result = await gatewayCronUpdate(id, { enabled: body.enabled });
    return c.json({ ok: true, result });
  } catch (err) {
    console.error('[crons] toggle error:', (err as Error).message);
    return c.json({ ok: false, error: (err as Error).message }, 502);
  }
});

app.post('/api/crons/:id/run', rateLimitGeneral, async (c) => {
  const id = c.req.param('id');
  try {
    const listResult = await gatewayRpcCall('cron.list', {
      includeDisabled: true,
    }, GATEWAY_RUN_TIMEOUT_MS) as Record<string, unknown>;
    const jobs = getCronJobsFromResult(listResult);
    const job = jobs.find((entry) => (entry.id || entry.jobId) === id);

    if (job && isIsolatedAgentTurnCron(job)) {
      const payload = job.payload as Record<string, unknown>;
      const runAtMs = Date.now();
      const spawnArgs: Record<string, unknown> = {
        task: String(payload.message || '').trim(),
        mode: 'run',
        label: buildCronSpawnLabel(job),
      };
      if (typeof payload.model === 'string' && payload.model.trim()) {
        spawnArgs.model = payload.model.trim();
      }
      if (typeof payload.thinking === 'string' && payload.thinking.trim()) {
        spawnArgs.thinking = payload.thinking.trim();
      }
      if (typeof job.agentId === 'string' && job.agentId.trim()) {
        spawnArgs.agentId = job.agentId.trim();
      }

      let result: unknown;
      try {
        result = await invokeGatewayTool('sessions_spawn', spawnArgs, GATEWAY_RUN_TIMEOUT_MS);
      } catch (spawnErr) {
        const message = (spawnErr as Error).message || '';
        if (!/Tool not available: sessions_spawn|404/.test(message)) throw spawnErr;
        // Some current OpenClaw gateways expose cron management as RPC while
        // hiding generic session-spawn tools. Manual run should still work.
        result = await gatewayRpcCall('cron.run', { jobId: id }, GATEWAY_RUN_TIMEOUT_MS);
      }
      const details = (result as { details?: Record<string, unknown> })?.details ?? {};
      try {
        await appendManualCronRunEntry(id, {
          ts: runAtMs,
          jobId: id,
          action: 'spawned',
          status: 'ok',
          summary: 'Manual run started in a separate cron session.',
          runAtMs,
          nextRunAtMs: typeof (job.state as Record<string, unknown> | undefined)?.nextRunAtMs === 'number'
            ? (job.state as Record<string, unknown>).nextRunAtMs as number
            : undefined,
          childSessionKey: typeof details.childSessionKey === 'string' ? details.childSessionKey : undefined,
          runId: typeof details.runId === 'string' ? details.runId : undefined,
          manual: true,
        });
      } catch (ledgerErr) {
        console.warn('[crons] manual run history write failed:', (ledgerErr as Error).message);
      }
      return c.json({ ok: true, result });
    }

    const result = await gatewayRpcCall('cron.run', {
      jobId: id,
    }, GATEWAY_RUN_TIMEOUT_MS);
    return c.json({ ok: true, result });
  } catch (err) {
    console.error('[crons] run error:', (err as Error).message);
    return c.json({ ok: false, error: (err as Error).message }, 502);
  }
});

app.get('/api/crons/:id/runs', rateLimitGeneral, async (c) => {
  const id = c.req.param('id');
  try {
    const gatewayEntries = await getGatewayCronRunEntries(id);
    const manualEntries = await readManualCronRunEntries(id);
    const entries = sortCronRunEntries([...gatewayEntries, ...manualEntries]).slice(0, 10);
    return c.json({
      ok: true,
      result: {
        entries,
        total: entries.length,
        offset: 0,
        limit: 10,
        hasMore: false,
        nextOffset: null,
      },
    });
  } catch (err) {
    console.error('[crons] runs error:', (err as Error).message);
    return c.json({ ok: false, error: (err as Error).message }, 502);
  }
});

export default app;
