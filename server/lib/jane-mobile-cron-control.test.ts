import { describe, expect, it, vi } from 'vitest';
import {
  createJaneMobileCronController,
  isJaneMobileCronControlRequest,
  JANE_OPERATING_CRONS,
} from './jane-mobile-cron-control.js';

const EXPECTED_OPERATING_CRONS = [
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

function jobs(enabled = false) {
  return JANE_OPERATING_CRONS.map(([id, name]) => ({
    id,
    name,
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
    expect(JANE_OPERATING_CRONS.map(([id, name]) => [id, name.replace(/\s+\[edited \d{4}-\d{2}-\d{2}\]$/, '')])).toEqual(EXPECTED_OPERATING_CRONS);
    const gatewayCall = vi.fn(async () => ({ jobs: jobs() }));
    const controller = createJaneMobileCronController(gatewayCall as never);
    const frames: Record<string, unknown>[] = [];

    expect(controller.handle(request('status-1', 'nerve.cron.group.status', {}), false, (frame) => {
      frames.push(JSON.parse(frame));
    })).toBe(true);
    await vi.waitFor(() => expect(frames).toHaveLength(1));

    expect(frames[0]).toMatchObject({
      type: 'res', id: 'status-1', ok: true,
      payload: { group: 'openclaw-operating-crons', edit_date: '2026-08-03', available: true, state: 'disabled' },
    });
    expect((frames[0].payload as { jobs: Array<{ name: string }> }).jobs.map((job) => job.name))
      .toEqual(JANE_OPERATING_CRONS.map(([, name]) => name));
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
