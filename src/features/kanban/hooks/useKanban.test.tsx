import { act, renderHook, waitFor, cleanup } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { compareTaskPriority, useKanban } from './useKanban';
import type { KanbanTask } from '../types';

const task = (id: string, version = 1, priority = 'normal', columnOrder = 0) =>
  ({ id, version, priority, columnOrder, status: 'todo' } as KanbanTask);
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const page = (items: KanbanTask[], hasMore = false) => ({ items, total: items.length, hasMore });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('loads all visible statuses in one request and paginates without losing tasks', async () => {
  const fetcher = vi.fn(async (url: string) => url.endsWith('/config') ? response(null)
    : response(page([task(url.includes('offset=0') ? 'one' : 'two')], url.includes('offset=0'))));
  vi.stubGlobal('fetch', fetcher);
  const { result } = renderHook(() => useKanban());
  await waitFor(() => expect(result.current.tasks).toHaveLength(2));
  const calls = fetcher.mock.calls.filter(([url]) => url.includes('/tasks?'));
  expect(calls).toHaveLength(2);
  expect(new URL(calls[0][0], 'http://local').searchParams.getAll('status')).toEqual(['in-progress', 'review', 'todo', 'backlog']);
});

it('keeps the returned version immediately while a post-move refresh is pending', async () => {
  let lists = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/config')) return response(null);
    if (url.endsWith('/reorder')) return response(task('one', 2));
    if (++lists === 1) return response(page([task('one')]));
    return new Promise<Response>(() => {});
  }));
  const { result } = renderHook(() => useKanban());
  await waitFor(() => expect(result.current.tasks).toHaveLength(1));
  await act(async () => { await result.current.reorderTask('one', 1, 'todo', 0); });
  expect(result.current.tasks[0].version).toBe(2);
});

it('applies the current server task after conflict even when refresh is rate limited', async () => {
  let lists = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/config')) return response(null);
    if (url.endsWith('/reorder')) return response({ latest: task('one', 3) }, 409);
    return ++lists === 1 ? response(page([task('one')])) : response({}, 429);
  }));
  const { result } = renderHook(() => useKanban());
  await waitFor(() => expect(result.current.tasks).toHaveLength(1));
  await act(async () => { await expect(result.current.reorderTask('one', 1, 'todo', 0)).rejects.toThrow('version_conflict'); });
  expect(result.current.tasks[0].version).toBe(3);
});

it('orders by priority and preserves manual order within a priority', () => {
  const items = [task('normal', 1, 'normal', 0), task('high-later', 1, 'high', 5), task('critical', 1, 'critical', 9), task('high-first', 1, 'high', 1)];
  expect(items.sort(compareTaskPriority).map(t => t.id)).toEqual(['critical', 'high-first', 'high-later', 'normal']);
});

it('ignores an older list response after a move even if transport ignores abort', async () => {
  let resolveOld!: (value: Response) => void;
  let lists = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/config')) return response(null);
    if (url.endsWith('/reorder')) return response(task('one', 2));
    if (++lists === 1) return response(page([task('one')]));
    if (lists === 2) return new Promise<Response>(resolve => { resolveOld = resolve; });
    return response(page([task('one', 2)]));
  }));
  const { result } = renderHook(() => useKanban());
  await waitFor(() => expect(result.current.tasks).toHaveLength(1));
  let pending!: Promise<void>;
  act(() => { pending = result.current.fetchTasks(undefined, { silent: true }); });
  await act(async () => { await result.current.reorderTask('one', 1, 'todo', 0); });
  await act(async () => { resolveOld(response(page([task('one')]))); await pending; });
  expect(result.current.tasks[0].version).toBe(2);
});

it('does not let an aborted 429 block a later refresh', async () => {
  let resolveOld!: (value: Response) => void;
  let lists = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/config')) return response(null);
    if (++lists === 2) return new Promise<Response>(resolve => { resolveOld = resolve; });
    return response(page([task('one', lists)]));
  }));
  const { result } = renderHook(() => useKanban());
  await waitFor(() => expect(result.current.tasks).toHaveLength(1));
  let pending!: Promise<void>;
  act(() => { pending = result.current.fetchTasks(undefined, { silent: true }); });
  await act(async () => { await result.current.fetchTasks(undefined, { silent: true, force: true }); });
  await act(async () => { resolveOld(response({}, 429)); await pending; });
  await act(async () => { await result.current.fetchTasks(undefined, { silent: true }); });
  expect(lists).toBe(4);
});
