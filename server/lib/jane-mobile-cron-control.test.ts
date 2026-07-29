import { describe, expect, it, vi } from 'vitest';
import {
  createJaneMobileCronController,
  isJaneMobileCronControlRequest,
  JANE_OPERATING_CRONS,
} from './jane-mobile-cron-control.js';

function jobs(enabled = false) {
  return JANE_OPERATING_CRONS.map(([id, base]) => ({
    id,
    name: `${base} [edited 2026-07-25]`,
    enabled,
    schedule: { kind: 'every', everyMs: 300_000 },
    state: { lastRunAtMs: 1_785_193_173_610, lastRunStatus: 'ok' },
  }));
}

function request(id: string, method: string, params: Record<string, unknown>) {
  return JSON.stringify({ type: 'req', id, method, params });
}

describe('Jane mobile cron control', () => {
  it('accepts only the fixed status and idempotent group toggle shapes', () => {
    expect(isJaneMobileCronControlRequest(JSON.parse(request('status-1', 'nerve.cron.group.status', {})))).toBe(true);
    expect(isJaneMobileCronControlRequest(JSON.parse(request('set-1', 'nerve.cron.group.setEnabled', {
      enabled: true,
      idempotencyKey: 'toggle-0001',
    })))).toBe(true);
    expect(isJaneMobileCronControlRequest(JSON.parse(request('set-2', 'nerve.cron.group.setEnabled', {
      enabled: true,
      idempotencyKey: 'toggle-0002',
      jobId: JANE_OPERATING_CRONS[0][0],
    })))).toBe(false);
    expect(isJaneMobileCronControlRequest(JSON.parse(request('admin', 'cron.update', {})))).toBe(false);
  });

  it('returns only safe allowlisted status fields', async () => {
    const gatewayCall = vi.fn(async () => ({ jobs: jobs() }));
    const controller = createJaneMobileCronController(gatewayCall as never);
    const frames: Record<string, unknown>[] = [];

    expect(controller.handle(request('status-1', 'nerve.cron.group.status', {}), false, (frame) => {
      frames.push(JSON.parse(frame));
    })).toBe(true);
    await vi.waitFor(() => expect(frames).toHaveLength(1));

    expect(frames[0]).toMatchObject({
      type: 'res', id: 'status-1', ok: true,
      payload: { group: 'openclaw-operating-crons', edit_date: '2026-07-25', available: true, state: 'disabled' },
    });
    expect((frames[0].payload as { jobs: unknown[] }).jobs).toHaveLength(15);
    expect(JSON.stringify(frames[0])).not.toMatch(/prompt|token|argv|description/i);
  });

  it('runs one allowlisted group update for duplicate idempotency keys', async () => {
    const current = jobs();
    const gatewayCall = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === 'cron.list') return { jobs: current };
      if (method === 'cron.update') {
        const id = String(params.id || params.jobId || '');
        const job = current.find((item) => item.id === id)!;
        job.enabled = (params.patch as { enabled: boolean }).enabled;
        return { ok: true };
      }
      throw new Error('unexpected method');
    });
    const controller = createJaneMobileCronController(gatewayCall as never);
    const frames: Record<string, unknown>[] = [];
    const send = (frame: string) => frames.push(JSON.parse(frame));
    const params = { enabled: true, idempotencyKey: 'same-toggle-key' };

    expect(controller.handle(request('set-1', 'nerve.cron.group.setEnabled', params), false, send)).toBe(true);
    expect(controller.handle(request('set-2', 'nerve.cron.group.setEnabled', params), false, send)).toBe(true);
    await vi.waitFor(() => expect(frames.filter((frame) => frame.type === 'res')).toHaveLength(2));

    expect(gatewayCall.mock.calls.filter(([method]) => method === 'cron.update')).toHaveLength(15);
    expect(frames.filter((frame) => frame.event === 'nerve.agent.progress' && (frame.payload as { state?: string }).state === 'started')).toHaveLength(1);
    expect(frames.filter((frame) => frame.event === 'nerve.agent.progress' && (frame.payload as { state?: string }).state === 'completed')).toHaveLength(1);
    expect(current.every((job) => job.enabled)).toBe(true);

    controller.handle(request('set-3', 'nerve.cron.group.setEnabled', {
      enabled: false,
      idempotencyKey: 'same-toggle-key',
    }), false, send);
    expect(frames.at(-1)).toMatchObject({ ok: false, error: { code: 'idempotency_conflict' } });
    expect(gatewayCall.mock.calls.filter(([method]) => method === 'cron.update')).toHaveLength(15);
  });

  it('fails closed when a live allowlisted name changes', async () => {
    const changed = jobs();
    changed[0].name = 'Unexpected renamed job';
    const gatewayCall = vi.fn(async (method: string) => {
      if (method === 'cron.list') return { jobs: changed };
      throw new Error('mutation must not run');
    });
    const controller = createJaneMobileCronController(gatewayCall as never);
    const frames: Record<string, unknown>[] = [];

    controller.handle(request('set-1', 'nerve.cron.group.setEnabled', {
      enabled: true,
      idempotencyKey: 'changed-group-key',
    }), false, (frame) => frames.push(JSON.parse(frame)));
    await vi.waitFor(() => expect(frames.some((frame) => frame.type === 'res')).toBe(true));

    expect(frames.find((frame) => frame.type === 'res')).toMatchObject({
      ok: false,
      error: { code: 'cron_group_changed' },
    });
    expect(gatewayCall).toHaveBeenCalledTimes(1);
  });
});
