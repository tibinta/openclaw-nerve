/** Tests for the sessions API routes. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

describe('sessions routes', () => {
  let tmpDir: string;
  let spawnSubagentMock: ReturnType<typeof vi.fn>;
  let gatewayRpcCallMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sessions-test-'));
    spawnSubagentMock = vi.fn();
    gatewayRpcCallMock = vi.fn();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function buildApp() {
    // Mock config to use our temp sessions dir
    vi.doMock('../lib/config.js', () => ({
      config: {
        sessionsDir: tmpDir,
        auth: false,
        port: 3000,
        host: '127.0.0.1',
        sslPort: 3443,
      },
      SESSION_COOKIE_NAME: 'nerve_session_3000',
    }));
    vi.doMock('../middleware/rate-limit.js', () => ({
      rateLimitGeneral: vi.fn((_c: unknown, next: () => Promise<void>) => next()),
    }));
    vi.doMock('../lib/subagent-spawn.js', () => ({
      spawnSubagent: spawnSubagentMock,
    }));
    vi.doMock('../lib/gateway-rpc.js', () => ({
      gatewayRpcCall: gatewayRpcCallMock,
    }));

    const mod = await import('./sessions.js');
    const app = new Hono();
    app.route('/', mod.default);
    return app;
  }

  it('rejects invalid session IDs (not UUID)', async () => {
    const app = await buildApp();
    const res = await app.request('/api/sessions/not-a-uuid/model');
    expect(res.status).toBe(400);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.ok).toBe(false);
    expect(json.error).toContain('Invalid session ID');
  });

  it('returns 200 with missing=true when transcript does not exist', async () => {
    const app = await buildApp();
    const uuid = '12345678-1234-1234-1234-123456789abc';
    const res = await app.request(`/api/sessions/${uuid}/model`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(json.model).toBeNull();
    expect(json.missing).toBe(true);
  });

  it('aggregates hidden session sources from the store and transcript within the audit window', async () => {
    const app = await buildApp();
    const sessionKey = 'agent:reviewer:cron:daily:run:abc123';
    const sessionId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const updatedAt = Date.now();

    await fs.writeFile(path.join(tmpDir, 'sessions.json'), JSON.stringify({
      [sessionKey]: {
        sessionId,
        label: 'daily summary',
        displayName: 'daily summary',
        updatedAt,
        model: 'openai/gpt-4.1',
        thinking: 'medium',
        thinkingLevel: 'medium',
      },
    }));
    await fs.writeFile(path.join(tmpDir, `${sessionId}.jsonl`), [
      JSON.stringify({ type: 'session_start', ts: updatedAt - 10_000 }),
      JSON.stringify({ type: 'model_change', modelId: 'openai/gpt-4.1', ts: updatedAt - 5_000 }),
    ].join('\n'));

    const res = await app.request('/api/sessions/hidden?activeMinutes=180&limit=10');
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok?: boolean; sessions?: Array<Record<string, unknown>> };
    expect(json.ok).toBe(true);
    expect(json.sessions).toHaveLength(1);
    expect(json.sessions?.[0]).toMatchObject({
      key: sessionKey,
      sessionKey,
      id: sessionId,
      label: 'daily summary',
      displayName: 'daily summary',
      model: 'openai/gpt-4.1',
    });
    expect(Array.isArray(json.sessions?.[0]?.sources)).toBe(true);
    expect((json.sessions?.[0]?.sources as Array<Record<string, unknown>>).map((source) => source.source)).toEqual([
      'transcript',
      'store',
    ]);
    expect(json.sessions?.[0]?.blocker).toBeNull();
  });

  it('returns model from transcript with model_change entry', async () => {
    const app = await buildApp();
    const uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const transcript = [
      JSON.stringify({ type: 'session_start', ts: Date.now() }),
      JSON.stringify({ type: 'model_change', modelId: 'anthropic/claude-opus-4', ts: Date.now() }),
      JSON.stringify({ type: 'message', role: 'user', content: 'hello' }),
    ].join('\n');
    await fs.writeFile(path.join(tmpDir, `${uuid}.jsonl`), transcript);

    const res = await app.request(`/api/sessions/${uuid}/model`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(json.model).toBe('anthropic/claude-opus-4');
    expect(json.missing).toBe(false);
  });

  it('returns model: null when transcript has no model_change', async () => {
    const app = await buildApp();
    const uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const transcript = [
      JSON.stringify({ type: 'session_start', ts: Date.now() }),
      JSON.stringify({ type: 'message', role: 'user', content: 'hello' }),
    ].join('\n');
    await fs.writeFile(path.join(tmpDir, `${uuid}.jsonl`), transcript);

    const res = await app.request(`/api/sessions/${uuid}/model`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(json.model).toBeNull();
    expect(json.missing).toBe(false);
  });

  it('finds deleted transcripts', async () => {
    const app = await buildApp();
    const uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const transcript = JSON.stringify({ type: 'model_change', modelId: 'openai/gpt-4o', ts: Date.now() });
    await fs.writeFile(path.join(tmpDir, `${uuid}.jsonl.deleted-1234`), transcript);

    const res = await app.request(`/api/sessions/${uuid}/model`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(json.model).toBe('openai/gpt-4o');
    expect(json.missing).toBe(false);
  });

  it('serves omitted image bytes from a session transcript', async () => {
    const app = await buildApp();
    const sessionKey = 'agent:main:main';
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const timestamp = 1775131617235;
    const base64 = Buffer.from('hello-image').toString('base64');

    await fs.writeFile(path.join(tmpDir, 'sessions.json'), JSON.stringify({
      [sessionKey]: { sessionId },
    }));
    await fs.writeFile(path.join(tmpDir, `${sessionId}.jsonl`), [
      JSON.stringify({ type: 'session_start', ts: Date.now() }),
      JSON.stringify({
        type: 'message',
        message: {
          timestamp,
          content: [
            { type: 'text', text: 'testing' },
            { type: 'image', mimeType: 'image/png', data: base64 },
          ],
        },
      }),
    ].join('\n'));

    const res = await app.request(`/api/sessions/media?sessionKey=${encodeURIComponent(sessionKey)}&timestamp=${timestamp}&imageIndex=0`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('content-disposition')).toContain(`message-${timestamp}-image-0.png`);
    const body = Buffer.from(await res.arrayBuffer()).toString('utf-8');
    expect(body).toBe('hello-image');
  });

  it('serves omitted audio bytes from a session transcript', async () => {
    const app = await buildApp();
    const sessionKey = 'agent:main:main';
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const timestamp = 1775131617236;
    const base64 = Buffer.from('hello-audio').toString('base64');

    await fs.writeFile(path.join(tmpDir, 'sessions.json'), JSON.stringify({
      [sessionKey]: { sessionId },
    }));
    await fs.writeFile(path.join(tmpDir, `${sessionId}.jsonl`), [
      JSON.stringify({ type: 'session_start', ts: Date.now() }),
      JSON.stringify({
        type: 'message',
        message: {
          timestamp,
          content: [
            { type: 'text', text: 'testing' },
            { type: 'audio', mimeType: 'audio/mpeg', data: base64 },
          ],
        },
      }),
    ].join('\n'));

    const res = await app.request(`/api/sessions/media?sessionKey=${encodeURIComponent(sessionKey)}&timestamp=${timestamp}&imageIndex=0`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/mpeg');
    expect(res.headers.get('content-disposition')).toContain(`message-${timestamp}-audio-0.mp3`);
    const body = Buffer.from(await res.arrayBuffer()).toString('utf-8');
    expect(body).toBe('hello-audio');
  });

  it('serves omitted file bytes from a session transcript', async () => {
    const app = await buildApp();
    const sessionKey = 'agent:main:main';
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const timestamp = 1775131617237;
    const base64 = Buffer.from('hello-file').toString('base64');

    await fs.writeFile(path.join(tmpDir, 'sessions.json'), JSON.stringify({
      [sessionKey]: { sessionId },
    }));
    await fs.writeFile(path.join(tmpDir, `${sessionId}.jsonl`), [
      JSON.stringify({ type: 'session_start', ts: Date.now() }),
      JSON.stringify({
        type: 'message',
        message: {
          timestamp,
          content: [
            { type: 'text', text: 'testing' },
            { type: 'file', mimeType: 'application/pdf', data: base64 },
          ],
        },
      }),
    ].join('\n'));

    const res = await app.request(`/api/sessions/media?sessionKey=${encodeURIComponent(sessionKey)}&timestamp=${timestamp}&imageIndex=0`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toContain(`message-${timestamp}-file-0.pdf`);
    const body = Buffer.from(await res.arrayBuffer()).toString('utf-8');
    expect(body).toBe('hello-file');
  });

  it('returns 404 when session transcript media cannot be resolved', async () => {
    const app = await buildApp();
    const sessionKey = 'agent:main:main';
    await fs.writeFile(path.join(tmpDir, 'sessions.json'), JSON.stringify({
      [sessionKey]: { sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
    }));

    const res = await app.request(`/api/sessions/media?sessionKey=${encodeURIComponent(sessionKey)}&timestamp=1775131617235&imageIndex=0`);
    expect(res.status).toBe(404);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.ok).toBe(false);
  });

  // ── POST /api/sessions/spawn-subagent ────────────────────────────

  it('rejects missing body with 400', async () => {
    const app = await buildApp();
    const res = await app.request('/api/sessions/spawn-subagent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.ok).toBe(false);
    expect(typeof json.error).toBe('string');
  });

  it('rejects body with missing required fields', async () => {
    const app = await buildApp();
    const res = await app.request('/api/sessions/spawn-subagent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: 'do something' }), // missing parentSessionKey
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.ok).toBe(false);
    expect(String(json.error)).toContain('parentSessionKey');
  });

  it('rejects parentSessionKey that is not a top-level root key', async () => {
    const app = await buildApp();
    const res = await app.request('/api/sessions/spawn-subagent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        parentSessionKey: 'agent:reviewer:subagent:child',
        task: 'do something',
      }),
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.ok).toBe(false);
    expect(String(json.error)).toContain('parentSessionKey');
  });

  it('rejects empty task string', async () => {
    const app = await buildApp();
    const res = await app.request('/api/sessions/spawn-subagent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        parentSessionKey: 'agent:reviewer:main',
        task: '',
      }),
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.ok).toBe(false);
  });

  it('returns direct success payload when helper succeeds with direct mode', async () => {
    spawnSubagentMock.mockResolvedValueOnce({
      sessionKey: 'agent:reviewer:subagent:abc-123',
      runId: 'run-xyz',
      mode: 'direct',
    });

    const app = await buildApp();
    const res = await app.request('/api/sessions/spawn-subagent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        parentSessionKey: 'agent:reviewer:main',
        task: 'Reply with exactly: OK',
        label: 'audit-auth-flow',
        model: 'claude-sonnet-4-6',
        thinking: 'medium',
        cleanup: 'keep',
      }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(json.sessionKey).toBe('agent:reviewer:subagent:abc-123');
    expect(json.runId).toBe('run-xyz');
    expect(json.mode).toBe('direct');
  });

  it('returns marker success payload when helper falls back to marker mode', async () => {
    spawnSubagentMock.mockResolvedValueOnce({
      sessionKey: 'agent:reviewer:subagent:from-marker',
      mode: 'marker',
    });

    const app = await buildApp();
    const res = await app.request('/api/sessions/spawn-subagent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        parentSessionKey: 'agent:reviewer:main',
        task: 'do something',
      }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(json.sessionKey).toBe('agent:reviewer:subagent:from-marker');
    expect(json.mode).toBe('marker');
    expect(json.runId).toBeUndefined();
  });

  it('returns 500 with error message when helper throws', async () => {
    spawnSubagentMock.mockRejectedValueOnce(new Error('Gateway connection failed'));

    const app = await buildApp();
    const res = await app.request('/api/sessions/spawn-subagent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        parentSessionKey: 'agent:reviewer:main',
        task: 'do something',
      }),
    });
    expect(res.status).toBe(500);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.ok).toBe(false);
    expect(String(json.error)).toContain('Gateway connection failed');
  });

  it('defaults cleanup to keep when not specified', async () => {
    spawnSubagentMock.mockResolvedValueOnce({
      sessionKey: 'agent:reviewer:subagent:test',
      mode: 'direct',
    });

    const app = await buildApp();
    await app.request('/api/sessions/spawn-subagent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        parentSessionKey: 'agent:reviewer:main',
        task: 'do something',
      }),
    });

    expect(spawnSubagentMock).toHaveBeenCalledWith(expect.objectContaining({
      cleanup: 'keep',
    }));
  });

  it('bulk deletes loaded sessions through the gateway while keeping protected roots', async () => {
    gatewayRpcCallMock.mockResolvedValue({});

    const app = await buildApp();
    const res = await app.request('/api/sessions/delete-all', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        keys: [
          'agent:main:main',
          'agent:designer:main',
          'agent:designer:subagent:abc123',
          'agent:designer:main',
          'agent:main:cron:daily-digest',
        ],
      }),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; deleted: number; failed: string[] };
    expect(json.ok).toBe(true);
    expect(json.deleted).toBe(3);
    expect(json.failed).toEqual([]);
    expect(gatewayRpcCallMock).toHaveBeenCalledWith('sessions.delete', {
      key: 'agent:designer:main',
      deleteTranscript: true,
    });
    expect(gatewayRpcCallMock).toHaveBeenCalledWith('sessions.delete', {
      key: 'agent:designer:subagent:abc123',
      deleteTranscript: true,
    });
    expect(gatewayRpcCallMock).toHaveBeenCalledWith('sessions.delete', {
      key: 'agent:main:cron:daily-digest',
      deleteTranscript: true,
    });
    expect(gatewayRpcCallMock).not.toHaveBeenCalledWith('sessions.delete', {
      key: 'agent:main:main',
      deleteTranscript: true,
    });
  });
});
