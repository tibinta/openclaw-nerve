/** Tests for session tree building logic. */
import { describe, it, expect } from 'vitest';
import { buildAgentSidebarTree, buildSessionTree, flattenTree, getSessionType, isAgentSidebarRootSessionKey } from './sessionTree';
import type { Session } from '@/types';

function session(key: string, extra: Partial<Session> = {}): Session {
  return { sessionKey: key, ...extra };
}

describe('getSessionType', () => {
  it('classifies main sessions', () => {
    expect(getSessionType('agent:main:main')).toBe('main');
  });

  it('classifies subagent sessions', () => {
    expect(getSessionType('agent:main:subagent:abc123')).toBe('subagent');
  });

  it('classifies cron sessions', () => {
    expect(getSessionType('agent:main:cron:daily-check')).toBe('cron');
  });

  it('classifies cron-run sessions', () => {
    expect(getSessionType('agent:main:cron:daily:run:xyz789')).toBe('cron-run');
  });
});

describe('buildSessionTree', () => {
  it('returns empty array for empty input', () => {
    expect(buildSessionTree([])).toEqual([]);
  });

  it('builds single root node', () => {
    const sessions = [session('agent:main:main')];
    const tree = buildSessionTree(sessions);
    expect(tree).toHaveLength(1);
    expect(tree[0].key).toBe('agent:main:main');
    expect(tree[0].depth).toBe(0);
    expect(tree[0].children).toEqual([]);
  });

  it('nests subagent under main', () => {
    const sessions = [
      session('agent:main:main'),
      session('agent:main:subagent:abc'),
    ];
    const tree = buildSessionTree(sessions);
    expect(tree).toHaveLength(1);
    expect(tree[0].children).toHaveLength(1);
    expect(tree[0].children[0].key).toBe('agent:main:subagent:abc');
    expect(tree[0].children[0].depth).toBe(1);
  });

  it('nests cron under main', () => {
    const sessions = [
      session('agent:main:main'),
      session('agent:main:cron:daily'),
    ];
    const tree = buildSessionTree(sessions);
    expect(tree[0].children).toHaveLength(1);
    expect(tree[0].children[0].key).toBe('agent:main:cron:daily');
  });

  it('nests cron-run under cron', () => {
    const sessions = [
      session('agent:main:main'),
      session('agent:main:cron:daily'),
      session('agent:main:cron:daily:run:xyz'),
    ];
    const tree = buildSessionTree(sessions);
    const cron = tree[0].children[0];
    expect(cron.children).toHaveLength(1);
    expect(cron.children[0].key).toBe('agent:main:cron:daily:run:xyz');
    expect(cron.children[0].depth).toBe(2);
  });

  it('sorts subagents before crons', () => {
    const sessions = [
      session('agent:main:main'),
      session('agent:main:cron:zzz'),
      session('agent:main:subagent:aaa'),
    ];
    const tree = buildSessionTree(sessions);
    expect(tree[0].children[0].key).toBe('agent:main:subagent:aaa');
    expect(tree[0].children[1].key).toBe('agent:main:cron:zzz');
  });

  it('uses explicit parentId when provided', () => {
    const sessions = [
      session('agent:main:main'),
      session('agent:main:subagent:child', { parentId: 'agent:main:main' }),
    ];
    const tree = buildSessionTree(sessions);
    expect(tree[0].children).toHaveLength(1);
    expect(tree[0].children[0].key).toBe('agent:main:subagent:child');
  });

  it('falls back to inferred parent when parentId is stale', () => {
    const sessions = [
      session('agent:reviewer:main'),
      session('agent:reviewer:subagent:child', { parentId: 'agent:missing:main' }),
    ];
    const tree = buildSessionTree(sessions);
    expect(tree).toHaveLength(1);
    expect(tree[0].key).toBe('agent:reviewer:main');
    expect(tree[0].children).toHaveLength(1);
    expect(tree[0].children[0].key).toBe('agent:reviewer:subagent:child');
  });

  it('orphans sessions whose parent is not in the list', () => {
    const sessions = [
      session('agent:main:subagent:orphan', { parentId: 'agent:other:main' }),
    ];
    const tree = buildSessionTree(sessions);
    // Orphan should appear at root level
    expect(tree).toHaveLength(1);
    expect(tree[0].key).toBe('agent:main:subagent:orphan');
  });

  it('builds multiple top-level roots with their own children', () => {
    const sessions = [
      session('agent:main:main'),
      session('agent:reviewer:main'),
      session('agent:main:subagent:a'),
      session('agent:reviewer:subagent:b'),
    ];
    const tree = buildSessionTree(sessions);

    expect(tree).toHaveLength(2);
    expect(tree[0].key).toBe('agent:main:main');
    expect(tree[1].key).toBe('agent:reviewer:main');
    expect(tree[0].children[0].key).toBe('agent:main:subagent:a');
    expect(tree[1].children[0].key).toBe('agent:reviewer:subagent:b');
  });

  it('sorts top-level roots by most recent activity first', () => {
    const sessions = [
      session('agent:older:main', { updatedAt: 1_000 }),
      session('agent:newer:main', { updatedAt: 2_000 }),
      session('agent:middle:main', { updatedAt: 1_500 }),
    ];

    const tree = buildSessionTree(sessions);

    expect(tree.map((node) => node.key)).toEqual([
      'agent:newer:main',
      'agent:middle:main',
      'agent:older:main',
    ]);
  });

  it('keeps heartbeat-suffixed agent families grouped under one root row', () => {
    const sessions = [
      session('agent:henry:main:heartbeat', { updatedAt: 1_000, label: 'heartbeat' }),
      session('agent:henry:subagent:alpha:heartbeat', { updatedAt: 2_000, label: 'Alpha helper', parentId: 'agent:henry:main' }),
      session('agent:henry:subagent:beta', { updatedAt: 1_500, label: 'Beta helper', parentId: 'agent:henry:main' }),
    ];

    const tree = buildSessionTree(sessions);
    expect(flattenTree(tree, {}).map((node) => node.key)).toEqual([
      'agent:henry:main:heartbeat',
      'agent:henry:subagent:alpha:heartbeat',
      'agent:henry:subagent:beta',
    ]);
    expect(tree[0].children.map((node) => node.key)).toEqual([
      'agent:henry:subagent:alpha:heartbeat',
      'agent:henry:subagent:beta',
    ]);
  });

  it('orders root families by the newest descendant and keeps each family contiguous', () => {
    const sessions = [
      session('agent:older:main', { updatedAt: 1_000 }),
      session('agent:older:subagent:alpha', { updatedAt: 1_100 }),
      session('agent:newer:main', { updatedAt: 900 }),
      session('agent:newer:subagent:beta', { updatedAt: 2_000 }),
    ];

    const tree = buildSessionTree(sessions);

    expect(flattenTree(tree, {}).map((node) => node.key)).toEqual([
      'agent:newer:main',
      'agent:newer:subagent:beta',
      'agent:older:main',
      'agent:older:subagent:alpha',
    ]);
  });

  it('sorts siblings by most recent activity first', () => {
    const sessions = [
      session('agent:main:main'),
      session('agent:main:subagent:old', { updatedAt: 1_000 }),
      session('agent:main:subagent:new', { updatedAt: 2_000 }),
    ];

    const tree = buildSessionTree(sessions);

    expect(tree[0].children.map((node) => node.key)).toEqual([
      'agent:main:subagent:new',
      'agent:main:subagent:old',
    ]);
  });

  it('prefers the Jane root ahead of legacy main when both roots exist', () => {
    const sessions = [
      session('agent:main:main'),
      session('agent:jane-whitmore---ceo:main'),
      session('agent:reviewer:main'),
    ];
    const tree = buildSessionTree(sessions);

    expect(tree).toHaveLength(3);
    expect(tree[0].key).toBe('agent:jane-whitmore---ceo:main');
    expect(tree[1].key).toBe('agent:main:main');
    expect(tree[2].key).toBe('agent:reviewer:main');
  });

  it('sorts cron-runs by most recent first', () => {
    const sessions = [
      session('agent:main:main'),
      session('agent:main:cron:job1'),
      session('agent:main:cron:job1:run:old', { lastActivity: '2026-01-01T00:00:00Z' }),
      session('agent:main:cron:job1:run:new', { lastActivity: '2026-02-26T00:00:00Z' }),
    ];
    const tree = buildSessionTree(sessions);
    const runs = tree[0].children[0].children;
    expect(runs[0].key).toBe('agent:main:cron:job1:run:new');
    expect(runs[1].key).toBe('agent:main:cron:job1:run:old');
  });
});

describe('buildAgentSidebarTree', () => {
  it('recognizes only real top-level agent roots as sidebar roots', () => {
    expect(isAgentSidebarRootSessionKey('agent:main:main')).toBe(true);
    expect(isAgentSidebarRootSessionKey('agent:codex:main')).toBe(true);
    expect(isAgentSidebarRootSessionKey('agent:main:subagent:abc123')).toBe(false);
    expect(isAgentSidebarRootSessionKey('discord:123')).toBe(false);
    expect(isAgentSidebarRootSessionKey('agent:main:cron:nightly')).toBe(false);
  });

  it('still filters out unrelated root sessions for legacy sidebar views', () => {
    const sessions = [
      session('agent:main:main', { label: 'Main' }),
      session('agent:main:subagent:abc123', { label: 'Worker' }),
      session('discord:sean', { label: 'Discord Root' }),
    ];

    const tree = buildAgentSidebarTree(sessions);
    const flat = flattenTree(tree, {});
    expect(flat.map((node) => node.key)).toEqual([
      'agent:main:main',
      'agent:main:subagent:abc123',
    ]);
  });
});

describe('live session tree visibility', () => {
  it('keeps subagents and other live children in the tree', () => {
    const sessions = [
      session('agent:main:main', { label: 'Main' }),
      session('agent:main:subagent:abc123', { label: 'Worker' }),
      session('agent:main:cron:nightly', { label: 'Nightly' }),
      session('agent:main:cron:nightly:run:run123', { label: 'Run 123' }),
      session('discord:sean', { label: 'Discord Root' }),
    ];

    const tree = buildSessionTree(sessions);
    const flat = flattenTree(tree, {});
    expect(flat.map((node) => node.key)).toEqual([
      'agent:main:main',
      'agent:main:subagent:abc123',
      'agent:main:cron:nightly',
      'agent:main:cron:nightly:run:run123',
      'discord:sean',
    ]);
  });
});

describe('flattenTree', () => {
  it('flattens expanded tree in order', () => {
    const sessions = [
      session('agent:main:main'),
      session('agent:main:subagent:a'),
      session('agent:main:cron:b'),
    ];
    const tree = buildSessionTree(sessions);
    const flat = flattenTree(tree, {});
    expect(flat.map(n => n.key)).toEqual([
      'agent:main:main',
      'agent:main:subagent:a',
      'agent:main:cron:b',
    ]);
  });

  it('respects collapsed state', () => {
    const sessions = [
      session('agent:main:main'),
      session('agent:main:subagent:a'),
      session('agent:main:cron:b'),
    ];
    const tree = buildSessionTree(sessions);
    const flat = flattenTree(tree, { 'agent:main:main': false });
    // Collapsed root — only root visible
    expect(flat.map(n => n.key)).toEqual(['agent:main:main']);
  });
});
