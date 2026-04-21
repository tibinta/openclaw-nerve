import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

describe('codex limits and rotation', () => {
  let tmpHome: string;
  let previousHome: string | undefined;
  let previousUserProfile: string | undefined;

  async function waitForFile(file: string) {
    for (let i = 0; i < 20; i += 1) {
      try {
        return await fs.readFile(file, 'utf8');
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    throw new Error(`Timed out waiting for ${file}`);
  }

  beforeEach(async () => {
    vi.resetModules();
    previousHome = process.env.HOME;
    previousUserProfile = process.env.USERPROFILE;
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-rotation-'));
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previousUserProfile;
    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  async function buildApp() {
    const mod = await import('./codex-limits.js');
    const app = new Hono();
    app.route('/', mod.default);
    return app;
  }

  it('reports manual fallback when no saved profiles exist', async () => {
    const app = await buildApp();
    const res = await app.request('/api/codex-limits');
    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, unknown>;
    expect(json).toHaveProperty('rotation');
    expect(typeof (json.rotation as Record<string, unknown>).available).toBe('boolean');
  });

  it('exposes the rotate endpoint shape', async () => {
    await fs.mkdir(path.join(tmpHome, '.codex', 'profiles'), { recursive: true });
    await fs.writeFile(path.join(tmpHome, '.codex', 'profiles.json'), JSON.stringify({ profiles: [] }));

    const app = await buildApp();
    const res = await app.request('/api/codex-limits/rotate', { method: 'POST' });
    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, unknown>;
    expect(typeof json.ok).toBe('boolean');
    expect(json.status).toBeTruthy();
  });

  it('captures the active auth snapshot into a saved profile', async () => {
    await fs.mkdir(path.join(tmpHome, '.codex'), { recursive: true });
    await fs.writeFile(path.join(tmpHome, '.codex', 'auth.json'), JSON.stringify({ account_label: 'Alex', tokens: { access_token: 'token' } }));

    const app = await buildApp();
    const res = await app.request('/api/codex-limits/profiles/capture', {
      method: 'POST',
      body: JSON.stringify({ id: 'alex', label: 'Alex' }),
      headers: { 'content-type': 'application/json' },
    });

    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, unknown>;
    expect(json).toMatchObject({ ok: true });
    expect(await waitForFile(path.join(tmpHome, '.codex', 'profiles', 'alex.json'))).toContain('access_token');
    expect(JSON.parse(await waitForFile(path.join(tmpHome, '.codex', 'profiles.json')))).toMatchObject({ profiles: [{ id: 'alex', label: 'Alex', authFile: 'alex.json' }] });
  });
});
