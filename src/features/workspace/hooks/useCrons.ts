/**
 * useCrons — Fetch, toggle, run, add, update, and delete cron jobs.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { useGateway } from '@/contexts/GatewayContext';
import type { GatewayEvent } from '@/types';

export interface CronDelivery {
  mode: string;
  channel?: string;
  to?: string;
  bestEffort?: boolean;
}

export interface CronJob {
  id: string;
  name?: string;
  label?: string;
  description?: string;
  agentId?: string;
  enabled: boolean;
  // Schedule (normalized)
  scheduleKind: 'every' | 'cron' | 'at';
  schedule?: string;      // cron expr
  scheduleTz?: string;    // cron tz
  everyMs?: number;
  at?: string;            // ISO string
  // Payload
  payloadKind: 'agentTurn' | 'systemEvent' | 'command';
  message?: string;       // agentTurn message or systemEvent text
  model?: string;
  thinking?: string;
  timeoutSeconds?: number;
  sessionTarget?: 'main' | 'isolated' | `session:${string}`;
  sessionKey?: string;
  // Delivery
  delivery?: CronDelivery;
  wakeMode?: string;
  deleteAfterRun?: boolean;
  clearAgentOverride?: boolean;
  accountId?: string;
  lightContext?: boolean;
  failureAlerts?: string;
  bestEffortDelivery?: boolean;
  // State
  nextRun?: string;
  lastRun?: string;
  lastStatus?: string;
  lastError?: string;
  lastDeliveryStatus?: string;
  raw?: Record<string, unknown>;
}

export interface CronRun {
  timestamp: string;
  status: string;
  duration?: number;
  error?: string;
  summary?: string;
}

const CRON_TOOL_UNAVAILABLE_RE = /tool not available:\s*cron/i;

export const CRON_GATEWAY_TOOL_ALLOWLIST = ['cron', 'gateway', 'sessions_spawn'] as const;
export const CRON_WARNING_SUMMARY = 'This gateway does not expose cron management, so Nerve can’t load or edit crons right now.';
const CRON_EVENT_REFRESH_DELAY_MS = 1500;

interface FetchJobsOptions {
  silent?: boolean;
}

export function getCronWarning(error: string | null | undefined): string | null {
  if (!error || !CRON_TOOL_UNAVAILABLE_RE.test(error)) return null;
  return CRON_WARNING_SUMMARY;
}

export function normalizeCronJob(j: Record<string, unknown>): CronJob {
  const sched = (j.schedule || {}) as Record<string, unknown>;
  const payload = (j.payload || {}) as Record<string, unknown>;
  const state = (j.state || {}) as Record<string, unknown>;
  const delivery = (j.delivery || undefined) as CronDelivery | undefined;
  const target = j.sessionTarget;
  const sessionTarget = target === 'main' || target === 'isolated' || (typeof target === 'string' && target.startsWith('session:') && target.length > 8)
    ? (target as CronJob['sessionTarget'])
    : undefined;
  const agentId = typeof j.agentId === 'string' && j.agentId.trim().length > 0
    ? j.agentId.trim()
    : undefined;

  const scheduleKind = (sched.kind as string) || (sched.everyMs ? 'every' : sched.expr ? 'cron' : sched.at ? 'at' : 'every');

  return {
    id: (j.id || j.jobId || '') as string,
    name: (j.name || j.label || '') as string,
    label: (j.label || j.name || '') as string,
    description: typeof j.description === 'string' ? j.description : undefined,
    agentId,
    enabled: (j.enabled as boolean) ?? true,
    // Schedule
    scheduleKind: scheduleKind as CronJob['scheduleKind'],
    schedule: sched.expr as string | undefined,
    scheduleTz: sched.tz as string | undefined,
    everyMs: sched.everyMs as number | undefined,
    at: sched.at as string | undefined,
    // Payload
    payloadKind: payload.kind === 'systemEvent' ? 'systemEvent' : payload.kind === 'command' ? 'command' : 'agentTurn',
    message: (payload.message || payload.text || '') as string,
    model: payload.model as string | undefined,
    thinking: typeof payload.thinking === 'string' ? payload.thinking : typeof j.thinking === 'string' ? j.thinking : undefined,
    timeoutSeconds:
      typeof payload.timeoutSeconds === 'number'
        ? payload.timeoutSeconds
        : typeof j.timeoutSeconds === 'number'
          ? j.timeoutSeconds
          : undefined,
    sessionTarget,
    sessionKey:
      typeof j.sessionKey === 'string' && j.sessionKey.trim().length > 0
        ? j.sessionKey
        : undefined,
    // Delivery
    delivery: delivery?.mode ? delivery : undefined,
    wakeMode: typeof j.wakeMode === 'string' ? j.wakeMode : undefined,
    deleteAfterRun: typeof j.deleteAfterRun === 'boolean' ? j.deleteAfterRun : undefined,
    clearAgentOverride: typeof j.clearAgentOverride === 'boolean' ? j.clearAgentOverride : undefined,
    accountId: typeof j.accountId === 'string' ? j.accountId : undefined,
    lightContext: typeof j.lightContext === 'boolean' ? j.lightContext : undefined,
    failureAlerts: typeof j.failureAlerts === 'string' ? j.failureAlerts : undefined,
    bestEffortDelivery:
      typeof j.bestEffortDelivery === 'boolean'
        ? j.bestEffortDelivery
        : typeof delivery?.bestEffort === 'boolean'
          ? delivery.bestEffort
          : undefined,
    // State
    nextRun: state.nextRunAtMs
      ? new Date(state.nextRunAtMs as number).toISOString()
      : undefined,
    lastRun: state.lastRunAtMs
      ? new Date(state.lastRunAtMs as number).toISOString()
      : undefined,
    lastStatus: state.lastStatus as string | undefined,
    lastError: state.lastError as string | undefined,
    lastDeliveryStatus: state.lastDeliveryStatus as string | undefined,
    raw: j,
  };
}

function cronLastRunMs(job: CronJob): number {
  if (!job.lastRun) return 0;
  const time = Date.parse(job.lastRun);
  return Number.isFinite(time) ? time : 0;
}

export function sortCronJobsByLastRun(jobs: CronJob[]): CronJob[] {
  return [...jobs].sort((a, b) => cronLastRunMs(b) - cronLastRunMs(a));
}

function getEventSessionKey(msg: GatewayEvent): string {
  const payload = msg.payload as { sessionKey?: unknown } | undefined;
  return typeof payload?.sessionKey === 'string' ? payload.sessionKey : '';
}

function isCronSessionLifecycleEvent(msg: GatewayEvent): boolean {
  const sessionKey = getEventSessionKey(msg);
  if (!sessionKey.includes(':cron:')) return false;

  const payload = msg.payload as {
    state?: unknown;
    stream?: unknown;
    data?: { phase?: unknown };
  } | undefined;

  if (msg.event === 'chat') {
    const state = String(payload?.state ?? '').toLowerCase();
    return ['started', 'final', 'error', 'aborted'].includes(state);
  }

  if (msg.event === 'agent' && payload?.stream === 'lifecycle') {
    const phase = String(payload.data?.phase ?? '').toLowerCase();
    return ['start', 'end', 'error'].includes(phase);
  }

  return false;
}

function shouldRefreshCronsForEvent(msg: GatewayEvent): boolean {
  return msg.type === 'event' && (
    msg.event.startsWith('cron')
    || isCronSessionLifecycleEvent(msg)
  );
}

/** Hook to list, create, update, delete, and toggle cron jobs via the gateway API. */
export function useCrons() {
  const { connectionState, subscribe } = useGateway();
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cronWarning, setCronWarning] = useState<string | null>(null);
  const fetchedRef = useRef(false);
  const fetchSeqRef = useRef(0);
  const fetchJobsRef = useRef<(options?: FetchJobsOptions) => Promise<void>>(async () => {});
  const eventRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setErrorState = useCallback((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    setError(message);
    setCronWarning(getCronWarning(message));
  }, []);

  const fetchJobs = useCallback(async (options: FetchJobsOptions = {}) => {
    const seq = ++fetchSeqRef.current;
    const silent = options.silent === true;
    if (!silent) {
      setIsLoading(true);
      setError(null);
      setCronWarning(null);
    }
    try {
      const res = await fetch('/api/crons');
      const data = await res.json() as { ok: boolean; result?: { jobs?: unknown[]; details?: { jobs?: unknown[] } }; error?: string };
      if (!data.ok) throw new Error(data.error || 'Failed to fetch crons');
      const rawJobs = extractCronJobsFromResult(data.result);
      if (seq === fetchSeqRef.current) {
        setJobs(sortCronJobsByLastRun((rawJobs as Record<string, unknown>[]).map(normalizeCronJob)));
        setError(null);
        setCronWarning(null);
      }
    } catch (err) {
      // Live cron events can arrive while the gateway is busy. Keep the last
      // valid list on screen and only show errors for user-driven refreshes.
      if (!silent && seq === fetchSeqRef.current) {
        setErrorState(err);
      }
    } finally {
      if (!silent && seq === fetchSeqRef.current) {
        setIsLoading(false);
      }
    }
  }, [setErrorState]);

  useEffect(() => {
    fetchJobsRef.current = fetchJobs;
  }, [fetchJobs]);

  // Auto-fetch on first mount so activeCount is available immediately (e.g. for tab badge)
  useEffect(() => {
    if (!fetchedRef.current) {
      fetchedRef.current = true;
      fetchJobs();
    }
  }, [fetchJobs]);

  useEffect(() => {
    if (connectionState !== 'connected') return;

    const unsubscribe = subscribe((msg) => {
      if (!shouldRefreshCronsForEvent(msg)) return;

      if (eventRefreshTimerRef.current) {
        clearTimeout(eventRefreshTimerRef.current);
      }

      eventRefreshTimerRef.current = setTimeout(() => {
        eventRefreshTimerRef.current = null;
        void fetchJobsRef.current({ silent: true });
      }, CRON_EVENT_REFRESH_DELAY_MS);
    });

    return () => {
      unsubscribe();
      if (eventRefreshTimerRef.current) {
        clearTimeout(eventRefreshTimerRef.current);
        eventRefreshTimerRef.current = null;
      }
    };
  }, [connectionState, subscribe]);

  const toggleJob = useCallback(async (id: string, enabled: boolean) => {
    try {
      const res = await fetch(`/api/crons/${encodeURIComponent(id)}/toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      const data = await res.json() as { ok: boolean; error?: string };
      if (!data.ok) throw new Error(data.error || 'Failed to toggle');
      setJobs(prev => prev.map(j => j.id === id ? { ...j, enabled } : j));
      return true;
    } catch (err) {
      setErrorState(err);
      return false;
    }
  }, [setErrorState]);

  const runJob = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/crons/${encodeURIComponent(id)}/run`, { method: 'POST' });
      const data = await res.json() as { ok: boolean; error?: string };
      if (!data.ok) throw new Error(data.error || 'Failed to run');
      const nowIso = new Date().toISOString();
      setJobs(prev => sortCronJobsByLastRun(prev.map(job => (
        job.id === id
          ? { ...job, lastRun: nowIso }
          : job
      ))));
      return true;
    } catch (err) {
      setErrorState(err);
      return false;
    }
  }, [setErrorState]);

  const fetchRuns = useCallback(async (id: string): Promise<CronRun[]> => {
    try {
      const res = await fetch(`/api/crons/${encodeURIComponent(id)}/runs`);
      const data = await res.json() as {
        ok: boolean;
        result?: { entries?: unknown[]; runs?: unknown[]; details?: { entries?: unknown[] } };
        error?: string;
      };
      if (!data.ok) throw new Error(data.error || 'Failed to fetch runs');
      const rawRuns = data.result?.entries || data.result?.runs || data.result?.details?.entries || (Array.isArray(data.result) ? data.result : []);
      return (rawRuns as Record<string, unknown>[]).map(r => ({
        timestamp: r.timestamp as string || (r.ts ? new Date(r.ts as number).toISOString() : ''),
        status: (r.status as string) || 'unknown',
        duration: (r.durationMs as number) ?? (r.duration as number),
        error: r.error as string | undefined,
        summary: r.summary as string | undefined,
      }));
    } catch {
      return [];
    }
  }, []);

  const addJob = useCallback(async (job: Record<string, unknown>) => {
    try {
      const res = await fetch('/api/crons', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job }),
      });
      const data = await res.json() as { ok: boolean; error?: string };
      if (!data.ok) throw new Error(data.error || 'Failed to add cron');
      await fetchJobs();
      return true;
    } catch (err) {
      setErrorState(err);
      return false;
    }
  }, [fetchJobs, setErrorState]);

  const updateJob = useCallback(async (id: string, patch: Record<string, unknown>) => {
    try {
      const res = await fetch(`/api/crons/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ patch }),
      });
      const data = await res.json() as { ok: boolean; error?: string };
      if (!data.ok) throw new Error(data.error || 'Failed to update cron');
      await fetchJobs();
      return true;
    } catch (err) {
      setErrorState(err);
      return false;
    }
  }, [fetchJobs, setErrorState]);

  const deleteJob = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/crons/${encodeURIComponent(id)}`, { method: 'DELETE' });
      const data = await res.json() as { ok: boolean; error?: string };
      if (!data.ok) throw new Error(data.error || 'Failed to delete');
      setJobs(prev => prev.filter(j => j.id !== id));
      return true;
    } catch (err) {
      setErrorState(err);
      return false;
    }
  }, [setErrorState]);

  const activeCount = jobs.filter(j => j.enabled).length;
  const totalCount = jobs.length;

  return { jobs, isLoading, error, cronWarning, activeCount, totalCount, fetchJobs, toggleJob, runJob, fetchRuns, addJob, updateJob, deleteJob };
}

function extractCronJobsFromResult(result: unknown): Record<string, unknown>[] {
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
        // Keep scanning other content items. The gateway sometimes wraps JSON
        // in explanatory text, and we do not want one malformed block to hide
        // the real cron list.
      }
    }
  }

  return Array.isArray(result) ? result as Record<string, unknown>[] : [];
}
