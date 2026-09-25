import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import fs from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';

describe('cron routes', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function buildApp() {
    const invokeGatewayTool = vi.fn(async () => ({ ok: true }));
    const gatewayRpcCall = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method.startsWith('cron.')) {
        return invokeGatewayTool('cron', {
          action: method.slice('cron.'.length),
          ...params,
        });
      }
      return { ok: true };
    });
    const tempHome = await fs.mkdtemp(join(os.tmpdir(), 'nerve-crons-test-'));

    vi.doMock('../lib/gateway-client.js', () => ({
      invokeGatewayTool,
    }));
    vi.doMock('../lib/gateway-rpc.js', () => ({
      gatewayRpcCall,
    }));

    vi.doMock('../lib/config.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../lib/config.js')>();
      return {
        ...actual,
        config: {
          ...actual.config,
          home: tempHome,
        },
      };
    });

    vi.doMock('../middleware/rate-limit.js', () => ({
      rateLimitGeneral: vi.fn((_c: unknown, next: () => Promise<void>) => next()),
    }));

    const mod = await import('./crons.js');
    const app = new Hono();
    app.route('/', mod.default);
    return { app, invokeGatewayTool, gatewayRpcCall, tempHome };
  }

  it('derives agentId from sessionKey when creating a cron', async () => {
    const { app, invokeGatewayTool } = await buildApp();

    const res = await app.request('/api/crons', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        job: {
          sessionTarget: 'isolated',
          sessionKey: 'agent:reviewer:main',
          payload: { kind: 'agentTurn', message: 'summarize inbox' },
        },
      }),
    });

    expect(res.status).toBe(200);
    expect(invokeGatewayTool).toHaveBeenCalledWith('cron', {
      action: 'add',
      job: {
        agentId: 'reviewer',
        payload: { kind: 'agentTurn', message: 'summarize inbox' },
        sessionKey: 'agent:reviewer:main',
        sessionTarget: 'isolated',
      },
    });
  });

  it('preserves extra cron fields when creating a cron', async () => {
    const { app, invokeGatewayTool } = await buildApp();

    const res = await app.request('/api/crons', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        job: {
          name: 'Memory Dreaming Promotion',
          description: 'Daily promotion run',
          agentId: 'main',
          enabled: true,
          schedule: { kind: 'every', everyMs: 86400000 },
          payload: { kind: 'systemEvent', text: 'Post reminder' },
          delivery: { mode: 'announce', bestEffort: true, channel: 'slack', to: '#ops' },
          sessionTarget: 'main',
          sessionKey: 'agent:main:main',
          wakeMode: 'now',
          deleteAfterRun: true,
          clearAgentOverride: true,
          accountId: 'acc-123',
          lightContext: true,
          thinkingLevel: 'medium',
          failureAlerts: 'off',
          bestEffortDelivery: true,
        },
      }),
    });

    expect(res.status).toBe(200);
    expect(invokeGatewayTool).toHaveBeenCalledWith('cron', {
      action: 'add',
      job: expect.objectContaining({
        name: 'Memory Dreaming Promotion',
        description: 'Daily promotion run',
        agentId: 'main',
        enabled: true,
        sessionTarget: 'main',
        payload: {
          kind: 'systemEvent',
          text: 'Post reminder',
        },
        delivery: { mode: 'announce', bestEffort: true, channel: 'slack', to: '#ops', accountId: 'acc-123' },
        wakeMode: 'now',
        deleteAfterRun: true,
      }),
    });
    const gatewayJob = (invokeGatewayTool.mock.calls[0]?.[1] as { job?: Record<string, unknown> } | undefined)?.job;
    expect(gatewayJob).not.toHaveProperty('accountId');
    expect(gatewayJob).not.toHaveProperty('lightContext');
    expect(gatewayJob).not.toHaveProperty('failureAlerts');
    expect(gatewayJob).not.toHaveProperty('bestEffortDelivery');
  });

  it('moves top-level thinkingLevel into the payload before saving', async () => {
    const { app, invokeGatewayTool } = await buildApp();

    const res = await app.request('/api/crons', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        job: {
          name: 'Thinking Job',
          enabled: false,
          schedule: { kind: 'every', everyMs: 86400000 },
          payload: { kind: 'agentTurn', message: 'Say hello' },
          sessionTarget: 'isolated',
          thinkingLevel: 'medium',
        },
      }),
    });

    expect(res.status).toBe(200);
    const gatewayJob = (invokeGatewayTool.mock.calls[0]?.[1] as { job?: Record<string, unknown> } | undefined)?.job;
    expect(gatewayJob).toMatchObject({
      name: 'Thinking Job',
      payload: {
        kind: 'agentTurn',
        message: 'Say hello',
        thinking: 'medium',
      },
    });
    expect(gatewayJob?.thinkingLevel).toBeUndefined();
  });

  it('derives agentId from sessionKey when updating a cron', async () => {
    const { app, gatewayRpcCall } = await buildApp();

    const res = await app.request('/api/crons/job-123', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        patch: {
          id: 'readonly-id',
          jobId: 'readonly-job-id',
          clearAgentOverride: true,
          sessionTarget: 'main',
          sessionKey: 'agent:ops:main',
          payload: { kind: 'systemEvent', text: 'Reminder: deploy window opens in 10 minutes.' },
        },
      }),
    });

    expect(res.status).toBe(200);
    expect(gatewayRpcCall).toHaveBeenCalledWith('cron.update', {
      id: 'job-123',
      patch: {
        agentId: 'ops',
        payload: { kind: 'systemEvent', text: 'Reminder: deploy window opens in 10 minutes.' },
        sessionKey: 'agent:ops:main',
        sessionTarget: 'main',
      },
    }, 60000);
  });

  it('keeps the persistent Jane Live target and agent turn on update', async () => {
    const { app, gatewayRpcCall } = await buildApp();
    const patch = {
      agentId: 'main',
      sessionTarget: 'session:agent:main:voice:direct:nerve-live',
      payload: { kind: 'agentTurn', message: 'Tell me something nice.', toolsAllow: ['*'] },
      schedule: { kind: 'every', everyMs: 1800000, anchorMs: 1790291449594 },
      delivery: { mode: 'none' },
    };
    const res = await app.request('/api/crons/job-123', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ patch }),
    });
    expect(res.status).toBe(200);
    expect(gatewayRpcCall).toHaveBeenCalledWith('cron.update', {
      id: 'job-123', patch,
    }, 60000);
  });

  it('keeps non-default agent cron edits isolated when updating', async () => {
    const { app, gatewayRpcCall } = await buildApp();

    const res = await app.request('/api/crons/job-123', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        patch: {
          agentId: 'agent-jane-whitmore---ceo-imessage-direct-447494722196',
          sessionTarget: 'main',
          sessionKey: 'agent-jane-whitmore---ceo-imessage-direct-447494722196',
          payload: { kind: 'agentTurn', message: 'Check the board.' },
        },
      }),
    });

    expect(res.status).toBe(200);
    expect(gatewayRpcCall).toHaveBeenCalledWith('cron.update', {
      id: 'job-123',
      patch: {
        agentId: 'agent-jane-whitmore---ceo-imessage-direct-447494722196',
        payload: { kind: 'agentTurn', message: 'Check the board.' },
        sessionKey: 'agent-jane-whitmore---ceo-imessage-direct-447494722196',
        sessionTarget: 'isolated',
      },
    }, 60000);
  });

  it('strips readonly cron fields before updating a job', async () => {
    const { app, gatewayRpcCall } = await buildApp();

    const res = await app.request('/api/crons/job-123', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        patch: {
          id: 'job-123',
          createdAtMs: 123,
          updatedAtMs: 456,
          jobId: 'job-123',
          clearAgentOverride: true,
          state: { lastRunAtMs: 789 },
          scheduledToolPolicy: { mode: 'account' },
          configRevision: 10,
          nextRunAtMs: 1234,
          lastRunAtMs: 789,
          lastRunStatus: 'ok',
          lastDelivered: true,
          lastDeliveryError: null,
          lastFailureNotificationDeliveryStatus: 'sent',
          schedule: { kind: 'cron', expr: '0 9 * * *', tz: 'Europe/London' },
          delivery: { mode: 'announce', channel: 'slack', to: '#ops' },
          agentId: 'agent-jane-whitmore---ceo-imessage-direct-447494722196',
          sessionKey: 'agent-jane-whitmore---ceo-imessage-direct-447494722196',
          sessionTarget: 'main',
          payload: { kind: 'agentTurn', message: 'Check the board.' },
        },
      }),
    });

    expect(res.status).toBe(200);
    expect(gatewayRpcCall).toHaveBeenCalledWith('cron.update', expect.objectContaining({
      id: 'job-123',
    }), 60000);
    const patch = (gatewayRpcCall.mock.calls[0]?.[1] as { patch?: Record<string, unknown> } | undefined)?.patch;
    expect(patch).toMatchObject({
      agentId: 'agent-jane-whitmore---ceo-imessage-direct-447494722196',
      sessionKey: 'agent-jane-whitmore---ceo-imessage-direct-447494722196',
      sessionTarget: 'isolated',
      payload: { kind: 'agentTurn', message: 'Check the board.' },
      schedule: { kind: 'cron', expr: '0 9 * * *', tz: 'Europe/London' },
      delivery: { mode: 'announce', channel: 'slack', to: '#ops' },
    });
    expect(patch).not.toHaveProperty('id');
    expect(patch).not.toHaveProperty('createdAtMs');
    expect(patch).not.toHaveProperty('updatedAtMs');
    expect(patch).not.toHaveProperty('jobId');
    expect(patch).not.toHaveProperty('clearAgentOverride');
    expect(patch).not.toHaveProperty('state');
    for (const key of [
      'scheduledToolPolicy', 'configRevision', 'nextRunAtMs', 'lastRunAtMs',
      'lastRunStatus', 'lastDelivered', 'lastDeliveryError',
      'lastFailureNotificationDeliveryStatus',
    ]) {
      expect(patch).not.toHaveProperty(key);
    }
  });

  it('moves legacy top-level agent options into the gateway payload when updating', async () => {
    const { app, gatewayRpcCall } = await buildApp();

    const res = await app.request('/api/crons/job-123', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        patch: {
          name: 'Tasks and Targets',
          schedule: { kind: 'every', everyMs: 300000 },
          sessionTarget: 'isolated',
          sessionKey: 'agent:jane-whitmore---ceo:main',
          payload: { kind: 'agentTurn', message: 'Check tasks' },
          lightContext: true,
          model: 'openai/gpt-5.1-codex',
          timeoutSeconds: 180,
          thinkingLevel: 'medium',
          bestEffortDelivery: true,
          accountId: 'imessage-main',
          failureAlerts: 'off',
        },
      }),
    });

    expect(res.status).toBe(200);
    expect(gatewayRpcCall).toHaveBeenCalledWith('cron.update', {
      id: 'job-123',
      patch: {
        agentId: 'jane-whitmore---ceo',
        name: 'Tasks and Targets',
        schedule: { kind: 'every', everyMs: 300000 },
        sessionTarget: 'isolated',
        sessionKey: 'agent:jane-whitmore---ceo:main',
        payload: {
          kind: 'agentTurn',
          message: 'Check tasks',
          lightContext: true,
          model: 'openai/gpt-5.1-codex',
          timeoutSeconds: 180,
          thinking: 'medium',
        },
        delivery: {
          bestEffort: true,
          accountId: 'imessage-main',
        },
      },
    }, 60000);
    const patch = (gatewayRpcCall.mock.calls[0]?.[1] as { patch?: Record<string, unknown> } | undefined)?.patch;
    expect(patch).not.toHaveProperty('lightContext');
    expect(patch).not.toHaveProperty('model');
    expect(patch).not.toHaveProperty('timeoutSeconds');
    expect(patch).not.toHaveProperty('thinkingLevel');
    expect(patch).not.toHaveProperty('bestEffortDelivery');
    expect(patch).not.toHaveProperty('accountId');
    expect(patch).not.toHaveProperty('failureAlerts');
  });

  it('falls back to jobId when a gateway requires the alternate update id field', async () => {
    const { app, gatewayRpcCall } = await buildApp();
    gatewayRpcCall.mockImplementationOnce(async () => {
      throw new Error("invalid cron.update params: at root: unexpected property 'id'; must have required property 'jobId'");
    }).mockImplementationOnce(async () => ({ ok: true }));

    const res = await app.request('/api/crons/job-123', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        patch: {
          enabled: true,
        },
      }),
    });

    expect(res.status).toBe(200);
    expect(gatewayRpcCall).toHaveBeenNthCalledWith(1, 'cron.update', {
      id: 'job-123',
      patch: { enabled: true },
    }, 60000);
    expect(gatewayRpcCall).toHaveBeenNthCalledWith(2, 'cron.update', {
      jobId: 'job-123',
      patch: { enabled: true },
    }, 60000);
  });

  it('runs isolated agentTurn jobs through sessions_spawn', async () => {
    const { app, invokeGatewayTool, tempHome } = await buildApp();
    invokeGatewayTool.mockImplementation(async (tool: string, args: Record<string, unknown>) => {
      if (tool === 'cron' && args.action === 'list') {
        return {
          jobs: [{
            id: 'job-123',
            agentId: 'main',
            sessionKey: 'agent:main:main',
            name: 'test cron',
            sessionTarget: 'isolated',
            payload: {
              kind: 'agentTurn',
              message: 'say hello',
              model: 'anthropic/claude-opus-4-6',
              thinking: 'medium',
            },
          }],
        };
      }
      if (tool === 'sessions_spawn') {
        return {
          details: {
            status: 'accepted',
            childSessionKey: 'agent:main:subagent:test-child',
          },
        };
      }
      return { ok: true };
    });

    const res = await app.request('/api/crons/job-123/run', { method: 'POST' });
    const data = await res.json() as { ok: boolean };

    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(invokeGatewayTool).toHaveBeenCalledWith('cron', {
      action: 'list',
      includeDisabled: true,
    });
    expect(invokeGatewayTool).toHaveBeenCalledWith('sessions_spawn', {
      task: 'say hello',
      mode: 'run',
      label: expect.stringMatching(/^Cron · test cron · \d{2}:\d{2}$/),
      model: 'anthropic/claude-opus-4-6',
      thinking: 'medium',
      agentId: 'main',
    }, 60000);
    const runLedger = await fs.readFile(join(tempHome, '.openclaw', 'cron', 'nerve-manual-runs', 'job-123.jsonl'), 'utf8');
    expect(runLedger).toContain('"summary":"Manual run started in a separate cron session."');
    expect(invokeGatewayTool).not.toHaveBeenCalledWith('cron', {
      action: 'run',
      jobId: 'job-123',
    }, 60000);
  });

  it('merges manual run history entries into cron runs', async () => {
    const { app, invokeGatewayTool, tempHome } = await buildApp();
    invokeGatewayTool.mockImplementation(async (tool: string, args: Record<string, unknown>) => {
      if (tool === 'cron' && args.action === 'runs') {
        return {
          details: {
            entries: [{
              ts: 1000,
              status: 'ok',
              summary: 'Gateway entry',
              durationMs: 500,
            }],
          },
        };
      }
      return { ok: true };
    });
    await fs.mkdir(join(tempHome, '.openclaw', 'cron', 'nerve-manual-runs'), { recursive: true });
    await fs.writeFile(
      join(tempHome, '.openclaw', 'cron', 'nerve-manual-runs', 'job-123.jsonl'),
      '{"ts":2000,"jobId":"job-123","action":"spawned","status":"ok","summary":"Manual run started in a separate cron session.","runAtMs":2000,"manual":true}\n',
      'utf8',
    );

    const res = await app.request('/api/crons/job-123/runs');
    const data = await res.json() as {
      ok: boolean;
      result: { entries: Array<{ summary?: string; ts?: number }> };
    };

    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.result.entries).toHaveLength(2);
    expect(data.result.entries[0]?.summary).toBe('Manual run started in a separate cron session.');
    expect(data.result.entries[1]?.summary).toBe('Gateway entry');
  });

  it('merges manual last-run timestamps into cron list state', async () => {
    const { app, invokeGatewayTool, tempHome } = await buildApp();
    invokeGatewayTool.mockImplementation(async (tool: string, args: Record<string, unknown>) => {
      if (tool === 'cron' && args.action === 'list') {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              jobs: [{
                id: 'job-123',
                agentId: 'main',
                sessionKey: 'agent:main:main',
                name: 'test cron',
                enabled: true,
                schedule: { kind: 'every', everyMs: 300000 },
                sessionTarget: 'isolated',
                payload: { kind: 'agentTurn', message: 'say hello' },
                state: {},
              }],
            }, null, 2),
          }],
          details: {
            jobs: [{
              id: 'job-123',
              agentId: 'main',
              sessionKey: 'agent:main:main',
              name: 'test cron',
              enabled: true,
              schedule: { kind: 'every', everyMs: 300000 },
              sessionTarget: 'isolated',
              payload: { kind: 'agentTurn', message: 'say hello' },
              state: {},
            }],
          },
        };
      }
      return { ok: true };
    });
    await fs.mkdir(join(tempHome, '.openclaw', 'cron', 'nerve-manual-runs'), { recursive: true });
    await fs.writeFile(
      join(tempHome, '.openclaw', 'cron', 'nerve-manual-runs', 'job-123.jsonl'),
      '{"ts":2000,"jobId":"job-123","action":"spawned","status":"ok","summary":"Manual run started in a separate cron session.","runAtMs":2000,"manual":true}\n',
      'utf8',
    );

    const res = await app.request('/api/crons');
    const data = await res.json() as {
      ok: boolean;
      result: {
        details?: { jobs?: Array<{ state?: { lastRunAtMs?: number } }> };
        content?: Array<{ type?: string; text?: string }>;
      };
    };

    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.result.details?.jobs?.[0]?.state?.lastRunAtMs).toBe(2000);
    const contentText = data.result.content?.[0]?.text;
    expect(contentText).toBeTruthy();
    const parsedContent = JSON.parse(contentText as string) as { jobs?: Array<{ state?: { lastRunAtMs?: number } }> };
    expect(parsedContent.jobs?.[0]?.state?.lastRunAtMs).toBe(2000);
  });

  it('backfills disabled jobs from the local cron store when the gateway omits them', async () => {
    const { app, invokeGatewayTool, tempHome } = await buildApp();
    invokeGatewayTool.mockImplementation(async (tool: string, args: Record<string, unknown>) => {
      if (tool === 'cron' && args.action === 'list') {
        return {
          jobs: [{
            id: 'live-job',
            name: 'Live job',
            enabled: true,
            schedule: { kind: 'cron', expr: '0 3 * * *' },
            payload: { kind: 'systemEvent', text: 'Live cron' },
            state: {
              nextRunAtMs: 123,
            },
          }],
          total: 1,
        };
      }
      return { ok: true };
    });

    await fs.mkdir(join(tempHome, '.openclaw', 'cron'), { recursive: true });
    await fs.writeFile(join(tempHome, '.openclaw', 'cron', 'jobs.json'), JSON.stringify({
      version: 1,
      jobs: [
        {
          id: 'live-job',
          name: 'Live job',
          enabled: true,
          schedule: { kind: 'cron', expr: '0 3 * * *' },
          payload: { kind: 'systemEvent', text: 'Live cron' },
          state: {
            nextRunAtMs: 123,
          },
        },
        {
          id: 'off-job',
          name: 'Off job',
          enabled: false,
          schedule: { kind: 'every', everyMs: 86400000 },
          payload: { kind: 'agentTurn', message: 'Disabled cron' },
          state: {
            lastRunAtMs: 456,
          },
        },
      ],
    }, null, 2), 'utf8');
    await fs.writeFile(join(tempHome, '.openclaw', 'cron', 'jobs-state.json'), JSON.stringify({
      version: 1,
      jobs: {
        'live-job': {
          updatedAtMs: 1,
          state: {
            nextRunAtMs: 123,
          },
        },
        'off-job': {
          updatedAtMs: 2,
          state: {
            lastRunAtMs: 456,
          },
        },
      },
    }, null, 2), 'utf8');

    const res = await app.request('/api/crons');
    const data = await res.json() as {
      ok: boolean;
      result: { jobs?: Array<{ id?: string; enabled?: boolean; state?: { lastRunAtMs?: number } }> };
    };

    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.result.jobs).toHaveLength(2);
    expect(data.result.jobs?.find((job) => job.id === 'live-job')?.enabled).toBe(true);
    expect(data.result.jobs?.find((job) => job.id === 'off-job')?.enabled).toBe(false);
    expect(data.result.jobs?.find((job) => job.id === 'off-job')?.state?.lastRunAtMs).toBe(456);
  });

  it('backfills disabled jobs from migrated local cron files', async () => {
    const { app, invokeGatewayTool, tempHome } = await buildApp();
    invokeGatewayTool.mockImplementation(async (tool: string, args: Record<string, unknown>) => {
      if (tool === 'cron' && args.action === 'list') {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              jobs: [{
                id: 'live-job',
                name: 'Live job',
                enabled: true,
                schedule: { kind: 'cron', expr: '0 3 * * *' },
                payload: { kind: 'systemEvent', text: 'Live cron' },
                state: {},
              }],
              total: 1,
            }),
          }],
        };
      }
      return { ok: true };
    });

    await fs.mkdir(join(tempHome, '.openclaw', 'cron'), { recursive: true });
    await fs.writeFile(join(tempHome, '.openclaw', 'cron', 'jobs.json.migrated'), JSON.stringify({
      version: 1,
      jobs: [
        {
          id: 'live-job',
          name: 'Live job',
          enabled: true,
          schedule: { kind: 'cron', expr: '0 3 * * *' },
          payload: { kind: 'systemEvent', text: 'Live cron' },
        },
        {
          id: 'off-job',
          name: 'Off job',
          enabled: false,
          schedule: { kind: 'every', everyMs: 86400000 },
          payload: { kind: 'agentTurn', message: 'Disabled cron' },
        },
      ],
    }, null, 2), 'utf8');
    await fs.writeFile(join(tempHome, '.openclaw', 'cron', 'jobs-state.json.migrated'), JSON.stringify({
      version: 1,
      jobs: {
        'off-job': {
          state: {
            lastRunAtMs: 456,
          },
        },
      },
    }, null, 2), 'utf8');

    const res = await app.request('/api/crons');
    const data = await res.json() as {
      ok: boolean;
      result: {
        jobs?: Array<{ id?: string; enabled?: boolean; state?: { lastRunAtMs?: number } }>;
        content?: Array<{ type?: string; text?: string }>;
      };
    };

    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.result.jobs).toHaveLength(2);
    expect(data.result.jobs?.find((job) => job.id === 'off-job')?.enabled).toBe(false);
    expect(data.result.jobs?.find((job) => job.id === 'off-job')?.state?.lastRunAtMs).toBe(456);
    const parsedContent = JSON.parse(data.result.content?.[0]?.text as string) as { jobs?: Array<{ id?: string }> };
    expect(parsedContent.jobs?.map((job) => job.id)).toEqual(['live-job', 'off-job']);
  });

  it('still returns success when manual run history cannot be persisted', async () => {
    const { app, invokeGatewayTool } = await buildApp();
    invokeGatewayTool.mockImplementation(async (tool: string, args: Record<string, unknown>) => {
      if (tool === 'cron' && args.action === 'list') {
        return {
          jobs: [{
            id: 'job-123',
            agentId: 'main',
            sessionKey: 'agent:main:main',
            name: 'test cron',
            sessionTarget: 'isolated',
            payload: {
              kind: 'agentTurn',
              message: 'say hello',
            },
          }],
        };
      }
      if (tool === 'sessions_spawn') {
        return {
          details: {
            status: 'accepted',
            childSessionKey: 'agent:main:subagent:test-child',
          },
        };
      }
      return { ok: true };
    });

    const appendSpy = vi.spyOn(fs, 'appendFile').mockRejectedValueOnce(new Error('disk full'));

    const res = await app.request('/api/crons/job-123/run', { method: 'POST' });
    const data = await res.json() as { ok: boolean };

    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(appendSpy).toHaveBeenCalled();
  });

  it('falls back to manual history when gateway runs lookup fails', async () => {
    const { app, invokeGatewayTool, tempHome } = await buildApp();
    invokeGatewayTool.mockImplementation(async (tool: string, args: Record<string, unknown>) => {
      if (tool === 'cron' && args.action === 'runs') {
        throw new Error('gateway unavailable');
      }
      return { ok: true };
    });
    await fs.mkdir(join(tempHome, '.openclaw', 'cron', 'nerve-manual-runs'), { recursive: true });
    await fs.writeFile(
      join(tempHome, '.openclaw', 'cron', 'nerve-manual-runs', 'job-123.jsonl'),
      '{"ts":2000,"jobId":"job-123","action":"spawned","status":"ok","summary":"Manual run started in a separate cron session.","runAtMs":2000,"manual":true}\n',
      'utf8',
    );

    const res = await app.request('/api/crons/job-123/runs');
    const data = await res.json() as {
      ok: boolean;
      result: { entries: Array<{ summary?: string; ts?: number }> };
    };

    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.result.entries).toHaveLength(1);
    expect(data.result.entries[0]?.summary).toBe('Manual run started in a separate cron session.');
  });
});
