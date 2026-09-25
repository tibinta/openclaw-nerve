import { useState, useEffect, useCallback, useRef } from 'react';

/* ── Proposal types (frontend-only, mirrors backend KanbanProposal) ── */

export interface KanbanProposal {
  id: string;
  type: 'create' | 'update';
  payload: Record<string, unknown>;
  sourceSessionKey?: string;
  proposedBy: string;
  proposedAt: number;
  status: 'pending' | 'approved' | 'rejected';
  version: number;
  resolvedAt?: number;
  resolvedBy?: string;
  reason?: string;
  resultTaskId?: string;
  actionError?: string;
}

interface ProposalsResponse {
  proposals: KanbanProposal[];
}

export function useProposals() {
  const [proposals, setProposals] = useState<KanbanProposal[]>([]);
  const [loading, setLoading] = useState(true);
  const proposalsRef = useRef<KanbanProposal[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const refreshInFlightRef = useRef(false);
  const actingRef = useRef(new Set<string>());
  const hiddenRef = useRef(new Set<string>());
  const errorsRef = useRef(new Map<string, string>());

  const updateProposals = useCallback((update: (current: KanbanProposal[]) => KanbanProposal[]) => {
    const next = update(proposalsRef.current);
    proposalsRef.current = next;
    setProposals(next);
  }, []);

  const fetchProposals = useCallback(async ({ silent = false }: { silent?: boolean } = {}) => {
    if (silent && refreshInFlightRef.current) return;

    if (!silent) {
      abortRef.current?.abort();
    }
    const controller = new AbortController();
    abortRef.current = controller;
    refreshInFlightRef.current = true;

    if (!silent) setLoading(true);
    try {
      const res = await fetch('/api/kanban/proposals?status=pending', { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: ProposalsResponse = await res.json();
      const returnedIds = new Set(data.proposals.map((proposal) => proposal.id));
      for (const id of hiddenRef.current) {
        if (!actingRef.current.has(id) && !returnedIds.has(id)) hiddenRef.current.delete(id);
      }
      for (const id of errorsRef.current.keys()) {
        if (!returnedIds.has(id)) errorsRef.current.delete(id);
      }
      updateProposals(() => data.proposals
        .filter((proposal) => !hiddenRef.current.has(proposal.id))
        .map((proposal) => ({ ...proposal, actionError: errorsRef.current.get(proposal.id) })));
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      // Silent errors on polls
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        refreshInFlightRef.current = false;
        if (!silent) setLoading(false);
      }
    }
  }, [updateProposals]);

  /* Initial fetch + poll every 15s */
  useEffect(() => {
    fetchProposals();
    const id = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      void fetchProposals({ silent: true });
    }, 15_000);
    return () => {
      clearInterval(id);
      abortRef.current?.abort();
    };
  }, [fetchProposals]);

  const pendingCount = proposals.length;

  const decideProposal = useCallback(async (id: string, action: 'approve' | 'reject', reason?: string) => {
    if (actingRef.current.has(id)) return;
    const current = proposalsRef.current;
    const index = current.findIndex((proposal) => proposal.id === id);
    if (index < 0) return;
    const proposal = current[index];
    const beforeId = current[index - 1]?.id;
    const afterId = current[index + 1]?.id;
    actingRef.current.add(id);
    hiddenRef.current.add(id);
    errorsRef.current.delete(id);
    updateProposals((items) => items.filter((item) => item.id !== id));
    try {
      const res = await fetch(`/api/kanban/proposals/${encodeURIComponent(id)}/${action}`, {
        method: 'POST',
        ...(action === 'reject' ? {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason }),
        } : {}),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.details || body.error || `HTTP ${res.status}`);
      }
      return action === 'approve' ? await res.json() : undefined;
    } catch (error) {
      hiddenRef.current.delete(id);
      const actionError = `Could not ${action}. Try again.`;
      errorsRef.current.set(id, actionError);
      updateProposals((items) => {
        if (items.some((item) => item.id === id)) return items;
        const afterIndex = items.findIndex((item) => item.id === afterId);
        const beforeIndex = items.findIndex((item) => item.id === beforeId);
        const restoreAt = afterIndex >= 0 ? afterIndex : beforeIndex >= 0 ? beforeIndex + 1 : Math.min(index, items.length);
        return [...items.slice(0, restoreAt), { ...proposal, actionError }, ...items.slice(restoreAt)];
      });
      throw error;
    } finally {
      actingRef.current.delete(id);
    }
  }, [updateProposals]);

  const approveProposal = useCallback((id: string) => decideProposal(id, 'approve'), [decideProposal]);
  const rejectProposal = useCallback((id: string, reason?: string) => decideProposal(id, 'reject', reason), [decideProposal]);

  const rejectBackgroundProposals = useCallback(async (proposalIds: string[]) => {
    const res = await fetch('/api/kanban/proposals/reject-background', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ proposalIds }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.details || body.error || `HTTP ${res.status}`);
    }
    const data: { rejectedCount: number } = await res.json();
    await fetchProposals();
    return data.rejectedCount;
  }, [fetchProposals]);

  return {
    proposals,
    pendingCount,
    loading,
    approveProposal,
    rejectProposal,
    rejectBackgroundProposals,
    refetch: fetchProposals,
  };
}
