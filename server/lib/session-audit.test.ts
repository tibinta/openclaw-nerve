import { describe, expect, it } from 'vitest';
import {
  aggregateSessionAudit,
  classifySessionAuditBlocker,
  SESSION_AUDIT_WINDOW_MS,
  type SessionAuditObservation,
} from './session-audit.js';

describe('session-audit', () => {
  it('aggregates recent sources across the audit window', () => {
    const now = Date.now();
    const observations: SessionAuditObservation[] = [
      {
        sessionKey: 'agent:reviewer:subagent:child-1',
        source: 'store',
        updatedAt: now - 30_000,
        status: 'waiting',
        pinned: true,
        waiting: true,
        label: 'child task',
      },
      {
        sessionKey: 'agent:reviewer:subagent:child-1',
        source: 'transcript',
        updatedAt: now - 20_000,
        status: 'waiting',
        pinned: true,
        waiting: true,
        detail: 'transcript present',
      },
      {
        sessionKey: 'agent:reviewer:subagent:child-1',
        source: 'gateway',
        updatedAt: now - (SESSION_AUDIT_WINDOW_MS + 10_000),
        status: 'running',
        detail: 'old snapshot',
      },
    ];

    const summaries = aggregateSessionAudit(observations, { now });
    expect(summaries).toHaveLength(1);

    const summary = summaries[0];
    expect(summary.sessionKey).toBe('agent:reviewer:subagent:child-1');
    expect(summary.sources).toHaveLength(2);
    expect(summary.sources.map((source) => source.source)).toEqual(['transcript', 'store']);
    expect(summary.pinned).toBe(true);
    expect(summary.waiting).toBe(true);
    expect(summary.blocker).toBeNull();
  });

  it('classifies repeated identical failures as a typed blocker', () => {
    const now = Date.now();
    const blocker = classifySessionAuditBlocker([
      {
        sessionKey: 'agent:reviewer:subagent:child-2',
        source: 'gateway',
        updatedAt: now - 120_000,
        status: 'error',
        error: 'worker crashed',
      },
      {
        sessionKey: 'agent:reviewer:subagent:child-2',
        source: 'gateway',
        updatedAt: now - 30_000,
        status: 'error',
        error: 'worker crashed',
      },
    ], { now });

    expect(blocker).toEqual(expect.objectContaining({
      type: 'repeated_identical_failure',
      count: 2,
    }));
    expect(blocker?.message).toContain('worker crashed');
  });

  it('keeps pinned waiting sessions out of the stale blocker path', () => {
    const now = Date.now();
    const blocker = classifySessionAuditBlocker([
      {
        sessionKey: 'agent:reviewer:subagent:child-3',
        source: 'gateway',
        updatedAt: now - (SESSION_AUDIT_WINDOW_MS + 60_000),
        status: 'waiting',
        pinned: true,
        waiting: true,
      },
    ], { now });

    expect(blocker).toBeNull();
  });

  it('marks stale child sessions as typed blockers once the audit window expires', () => {
    const now = Date.now();
    const blocker = classifySessionAuditBlocker([
      {
        sessionKey: 'agent:reviewer:subagent:child-4',
        source: 'gateway',
        updatedAt: now - (SESSION_AUDIT_WINDOW_MS + 60_000),
        status: 'running',
      },
    ], { now });

    expect(blocker).toEqual(expect.objectContaining({
      type: 'stale_child_session',
    }));
    expect(blocker?.message).toContain('stale');
  });
});
