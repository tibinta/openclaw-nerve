import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useProposals, type KanbanProposal } from './useProposals';

function proposal(id: string, proposedAt = 1): KanbanProposal {
  return { id, type: 'create', payload: { title: id }, proposedBy: 'agent:test', proposedAt, status: 'pending', version: 1 };
}

function response(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 503, json: async () => body };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

afterEach(() => vi.unstubAllGlobals());

describe('useProposals decisions', () => {
  it('hides one of 2001 rows immediately, blocks duplicate submits, and ignores stale polls', async () => {
    const rows = Array.from({ length: 2001 }, (_, index) => proposal(`p${index}`, index));
    const approval = deferred<ReturnType<typeof response>>();
    const fetchMock = vi.fn((path: string) => path.endsWith('/approve')
      ? approval.promise
      : Promise.resolve(response({ proposals: rows })));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useProposals());
    await waitFor(() => expect(result.current.pendingCount).toBe(2001));

    let pending!: Promise<unknown>;
    act(() => { pending = result.current.approveProposal('p1000'); });
    expect(result.current.pendingCount).toBe(2000);
    expect(result.current.proposals[1000].id).toBe('p1001');
    await act(async () => { await result.current.approveProposal('p1000'); });
    expect(fetchMock.mock.calls.filter(([path]) => String(path).endsWith('/approve'))).toHaveLength(1);

    await act(async () => { await result.current.refetch(); });
    expect(result.current.pendingCount).toBe(2000);
    approval.resolve(response({ resultTaskId: 'task-1' }));
    await act(async () => { await pending; });
    await act(async () => { await result.current.refetch(); });
    expect(result.current.pendingCount).toBe(2000); // A stale server snapshot cannot resurrect it.
  });

  it('restores concurrent failed rows in order with visible errors', async () => {
    const rows = ['a', 'b', 'c'].map((id) => proposal(id));
    const approval = deferred<ReturnType<typeof response>>();
    const rejection = deferred<ReturnType<typeof response>>();
    const fetchMock = vi.fn((path: string) => {
      if (path.endsWith('/approve')) return approval.promise;
      if (path.endsWith('/reject')) return rejection.promise;
      return Promise.resolve(response({ proposals: rows }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useProposals());
    await waitFor(() => expect(result.current.pendingCount).toBe(3));

    let approvePending!: Promise<unknown>;
    let rejectPending!: Promise<unknown>;
    act(() => {
      approvePending = result.current.approveProposal('a');
      rejectPending = result.current.rejectProposal('b');
    });
    expect(result.current.proposals.map((row) => row.id)).toEqual(['c']);
    await act(async () => { await result.current.refetch(); });
    expect(result.current.proposals.map((row) => row.id)).toEqual(['c']);

    rejection.resolve(response({ error: 'Server unavailable' }, false));
    await act(async () => { await expect(rejectPending).rejects.toThrow('Server unavailable'); });
    approval.resolve(response({ error: 'Server unavailable' }, false));
    await act(async () => { await expect(approvePending).rejects.toThrow('Server unavailable'); });
    expect(result.current.proposals.map((row) => row.id)).toEqual(['a', 'b', 'c']);
    expect(result.current.proposals.slice(0, 2).map((row) => row.actionError)).toEqual([
      'Could not approve. Try again.', 'Could not reject. Try again.',
    ]);
    await act(async () => { await result.current.refetch(); });
    expect(result.current.proposals.map((row) => row.id)).toEqual(['a', 'b', 'c']);
    expect(result.current.proposals[0].actionError).toBe('Could not approve. Try again.');
  });
});
