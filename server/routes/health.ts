/**
 * GET /health and /api/health — health check endpoints.
 * The `/api/health` alias keeps stale external probes harmless while `/health`
 * remains the documented canonical endpoint.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { config } from '../lib/config.js';

const app = new Hono();

const getHealth = async (c: Context) => {
  let gateway: 'ok' | 'unreachable' = 'unreachable';
  try {
    const res = await fetch(`${config.gatewayUrl}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) gateway = 'ok';
  } catch {
    // gateway unreachable — not a server failure
  }

  return c.json({ status: 'ok', uptime: process.uptime(), gateway });
};

app.get('/health', getHealth);
app.get('/api/health', getHealth);

export default app;
