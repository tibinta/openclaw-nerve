import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GatewayEvent } from '@/types';
import { getCronWarning, normalizeCronJob, useCrons } from './useCrons';

const gatewayMocks = vi.hoisted(() => ({
  connectionState: 'connected' as 'disconnected' | 'connecting' | 'connected' | 'reconnecting',
  subscribe: vi.fn(),
}));

vi.mock('@/contexts/GatewayContext', () => ({
  useGateway: () => ({
    connectionState: gatewayMocks.connectionState,
    subscribe: gatewayMocks.subscribe,
  }),
}));

function jsonResponse(data: unknown): Response {
  return {
    ok: true,
    json: async () => data,
  } as Response;
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

describe('normalizeCronJob', () => {
  it('preserves explicit root routing fields from the gateway', () => {
    const job = normalizeCronJob({
      id: 'cron-1',
      sessionTarget: 'main',
      sessionKey: 'agent:reviewer:main',
      payload: {
        kind: 'systemEvent',
        text: 'Reminder',
      },
      schedule: {
        kind: 'every',
        everyMs: 300000,
      },
      enabled: true,
    });

    expect(job.sessionTarget).toBe('main');
    expect(job.sessionKey).toBe('agent:reviewer:main');
    expect(job.payloadKind).toBe('systemEvent');
    expect(job.message).toBe('Reminder');
  });

  it('leaves legacy jobs without a session key unassigned', () => {
    const job = normalizeCronJob({
      id: 'cron-2',
      payload: {
        kind: 'agentTurn',
        message: 'Summarize',
      },
      schedule: {
        kind: 'cron',
        expr: '0 9 * * *',
      },
      enabled: true,
    });

    expect(job.sessionTarget).toBeUndefined();
    expect(job.sessionKey).toBeUndefined();
  });
});

describe('getCronWarning', () => {
  it('returns a short remediation summary for the known cron tool unavailable error', () => {
    expect(
      getCronWarning('Gateway tool invoke failed: 404 {"ok":false,"error":{"type":"not_found","message":"Tool not available: cron"}}'),
    ).toBe('This gateway does not expose cron management, so Nerve can’t load or edit crons right now.');
  });

  it('ignores unrelated cron errors', () => {
    expect(getCronWarning('Failed to fetch crons')).toBeNull();
  });
});

describe('useCrons live refresh', () => {
  let originalFetch: typeof globalThis.fetch;
  let subscribedHandler: ((msg: GatewayEvent) => void) | null;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    subscribedHandler = null;
    gatewayMocks.connectionState = 'connected';
    gatewayMocks.subscribe.mockReset();
    gatewayMocks.subscribe.mockImplementation((handler: (msg: GatewayEvent) => void) => {
      subscribedHandler = handler;
      return vi.fn();
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('refreshes the cron list after a cron-run completion event', async () => {
    vi.useFakeTimers();

    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        ok: true,
        result: {
          jobs: [{
            id: 'daily-check',
            enabled: true,
            schedule: { kind: 'every', everyMs: 300000 },
            payload: { kind: 'agentTurn', message: 'Check board' },
            state: { lastRunAtMs: 1000, lastStatus: 'ok' },
          }],
        },
      }))
      .mockResolvedValueOnce(jsonResponse({
        ok: true,
        result: {
          jobs: [{
            id: 'daily-check',
            enabled: true,
            schedule: { kind: 'every', everyMs: 300000 },
            payload: { kind: 'agentTurn', message: 'Check board' },
            state: { lastRunAtMs: 2000, lastStatus: 'ok' },
          }],
        },
      })) as typeof fetch;

    const { result } = renderHook(() => useCrons());

    await act(async () => {
      await flushPromises();
    });

    expect(result.current.jobs[0]?.lastRun).toBe(new Date(1000).toISOString());

    act(() => {
      subscribedHandler?.({
        type: 'event',
        event: 'chat',
        payload: {
          sessionKey: 'agent:jane-whitmore---ceo:cron:daily-check:run:abc123',
          state: 'final',
        },
      });
    });

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(1500);
      await flushPromises();
    });

    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(result.current.jobs[0]?.lastRun).toBe(new Date(2000).toISOString());
  });
});
