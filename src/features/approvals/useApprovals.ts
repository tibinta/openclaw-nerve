import { useCallback, useEffect, useMemo, useState } from 'react';
import { useGateway } from '@/contexts/GatewayContext';
import type { GatewayEvent } from '@/types';

export type ApprovalDecision = 'allow-once' | 'allow-always' | 'deny';
export type ApprovalKind = 'exec' | 'plugin';
export type ApprovalSeverity = 'info' | 'warning' | 'critical';

export interface PendingApproval {
  id: string;
  kind: ApprovalKind;
  title: string;
  description: string;
  severity: ApprovalSeverity;
  metadata: Array<{ label: string; value: string }>;
  allowedDecisions: ApprovalDecision[];
  createdAtMs: number;
  expiresAtMs: number;
}

export interface UseApprovalsState {
  pendingApprovals: PendingApproval[];
  resolvingKeys: Set<string>;
  error: string | null;
  refreshApprovals: () => Promise<void>;
  resolveApproval: (approval: PendingApproval, decision: ApprovalDecision) => Promise<void>;
}

const DEFAULT_DECISIONS: ApprovalDecision[] = ['allow-once', 'allow-always', 'deny'];
const REFRESH_INTERVAL_MS = 5_000;

async function noopRpc(): Promise<unknown> {
  return [];
}

function noopSubscribe(): () => void {
  return () => undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parseAllowedDecisions(value: unknown): ApprovalDecision[] {
  if (!Array.isArray(value)) return DEFAULT_DECISIONS;
  const decisions = value.filter((decision): decision is ApprovalDecision => (
    decision === 'allow-once' || decision === 'allow-always' || decision === 'deny'
  ));
  return decisions.length > 0 ? decisions : DEFAULT_DECISIONS;
}

export function redactApprovalText(input: string): string {
  return input
    .replace(/\bhttps?:\/\/[^\s<>"'),\]]+/gi, '[link]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]')
    .replace(/\b(?:Bearer\s+)?(?:sk|pk|pit|ghp|gho|glpat|xox[baprs]|AIza)[A-Za-z0-9._:-]{8,}\b/g, '[token]')
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, '[token]')
    .replace(/(^|[^\w])(\+?\d[\d\s().-]{8,}\d)(?=$|[^\w])/g, (match, prefix, possiblePhone) => {
      const digits = possiblePhone.replace(/\D/g, '');
      return digits.length >= 10 ? `${prefix}[phone]` : match;
    });
}

function safeLabel(value: unknown): string | null {
  const text = stringValue(value);
  return text ? redactApprovalText(text) : null;
}

function buildMetadata(entries: Array<[string, unknown]>): Array<{ label: string; value: string }> {
  return entries.flatMap(([label, value]) => {
    const text = safeLabel(value);
    return text ? [{ label, value: text }] : [];
  });
}

function normalizeSeverity(value: unknown): ApprovalSeverity {
  const severity = stringValue(value)?.toLowerCase();
  if (severity === 'critical' || severity === 'error' || severity === 'danger') return 'critical';
  if (severity === 'info' || severity === 'notice') return 'info';
  return 'warning';
}

function normalizeExecSeverity(request: Record<string, unknown>): ApprovalSeverity {
  const security = stringValue(request.security)?.toLowerCase();
  if (security === 'critical' || security === 'danger' || security === 'deny') return 'critical';
  if (security === 'info' || security === 'safe') return 'info';
  return 'warning';
}

function readRequestRecord(raw: Record<string, unknown>): Record<string, unknown> | null {
  return isRecord(raw.request) ? raw.request : null;
}

export function normalizeExecApproval(raw: unknown): PendingApproval | null {
  if (!isRecord(raw)) return null;
  const request = readRequestRecord(raw);
  if (!request) return null;

  const id = stringValue(raw.id);
  const createdAtMs = numberValue(raw.createdAtMs);
  const expiresAtMs = numberValue(raw.expiresAtMs);
  const command = stringValue(request.command)
    ?? stringValue(request.commandPreview)
    ?? stringValue(raw.commandText)
    ?? stringValue(raw.commandPreview);

  if (!id || !createdAtMs || !expiresAtMs || !command) return null;

  const commandPreview = stringValue(request.commandPreview) ?? stringValue(raw.commandPreview) ?? command;
  const warningText = stringValue(request.warningText);
  const descriptionParts = [`Command: ${commandPreview}`];
  if (warningText) descriptionParts.push(warningText);

  return {
    id,
    kind: 'exec',
    title: 'Command approval',
    description: redactApprovalText(descriptionParts.join('\n')),
    severity: normalizeExecSeverity(request),
    metadata: buildMetadata([
      ['Type', 'Command'],
      ['Agent', request.agentId],
      ['Host', request.host],
      ['Working dir', request.cwd],
      ['Security', request.security],
      ['Ask', request.ask],
    ]),
    allowedDecisions: parseAllowedDecisions(request.allowedDecisions),
    createdAtMs,
    expiresAtMs,
  };
}

export function normalizePluginApproval(raw: unknown): PendingApproval | null {
  if (!isRecord(raw)) return null;
  const request = readRequestRecord(raw);
  if (!request) return null;

  const id = stringValue(raw.id);
  const createdAtMs = numberValue(raw.createdAtMs);
  const expiresAtMs = numberValue(raw.expiresAtMs);
  const title = stringValue(request.title);

  if (!id || !createdAtMs || !expiresAtMs || !title) return null;

  return {
    id,
    kind: 'plugin',
    title: redactApprovalText(title),
    description: redactApprovalText(stringValue(request.description) ?? ''),
    severity: normalizeSeverity(request.severity),
    metadata: buildMetadata([
      ['Type', 'Plugin tool'],
      ['Plugin', request.pluginId],
      ['Tool', request.toolName],
      ['Agent', request.agentId],
      ['Severity', request.severity],
    ]),
    allowedDecisions: parseAllowedDecisions(request.allowedDecisions),
    createdAtMs,
    expiresAtMs,
  };
}

function readApprovalListPayload(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!isRecord(payload)) return [];
  if (Array.isArray(payload.approvals)) return payload.approvals;
  if (Array.isArray(payload.pending)) return payload.pending;
  if (Array.isArray(payload.requests)) return payload.requests;
  return [];
}

function approvalKey(approval: Pick<PendingApproval, 'id' | 'kind'>): string {
  return `${approval.kind}:${approval.id}`;
}

function sortApprovals(approvals: PendingApproval[]): PendingApproval[] {
  return [...approvals].sort((a, b) => b.createdAtMs - a.createdAtMs);
}

function dedupeApprovals(approvals: PendingApproval[]): PendingApproval[] {
  const byKey = new Map<string, PendingApproval>();
  for (const approval of approvals) byKey.set(approvalKey(approval), approval);
  return sortApprovals(Array.from(byKey.values()));
}

function pruneExpired(approvals: PendingApproval[], now = Date.now()): PendingApproval[] {
  return approvals.filter((approval) => approval.expiresAtMs > now);
}

export function useApprovals(): UseApprovalsState {
  const gateway = useGateway();
  const { connectionState } = gateway;
  const rpc = typeof gateway.rpc === 'function' ? gateway.rpc : noopRpc;
  const subscribe = typeof gateway.subscribe === 'function' ? gateway.subscribe : noopSubscribe;
  const [pendingApprovals, setPendingApprovals] = useState<PendingApproval[]>([]);
  const [resolvingKeys, setResolvingKeys] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);

  const refreshApprovals = useCallback(async () => {
    if (connectionState !== 'connected') return;

    const listCalls = await Promise.allSettled([
      rpc('exec.approval.list', {}),
      rpc('plugin.approval.list', {}),
    ]);

    const execPayload = listCalls[0];
    const pluginPayload = listCalls[1];
    const execApprovals = execPayload.status === 'fulfilled'
      ? readApprovalListPayload(execPayload.value).flatMap((item) => {
        const approval = normalizeExecApproval(item);
        return approval ? [approval] : [];
      })
      : [];
    const pluginApprovals = pluginPayload.status === 'fulfilled'
      ? readApprovalListPayload(pluginPayload.value).flatMap((item) => {
        const approval = normalizePluginApproval(item);
        return approval ? [approval] : [];
      })
      : [];

    if (execPayload.status === 'rejected' && pluginPayload.status === 'rejected') {
      setError('Could not load approvals.');
      return;
    }

    setError(null);
    setPendingApprovals(pruneExpired(dedupeApprovals([...execApprovals, ...pluginApprovals])));
  }, [connectionState, rpc]);

  const resolveApproval = useCallback(async (approval: PendingApproval, decision: ApprovalDecision) => {
    const key = approvalKey(approval);
    setResolvingKeys((current) => new Set(current).add(key));
    try {
      const method = approval.kind === 'exec' ? 'exec.approval.resolve' : 'plugin.approval.resolve';
      await rpc(method, { id: approval.id, decision });
      setPendingApprovals((current) => current.filter((item) => approvalKey(item) !== key));
      setError(null);
    } catch {
      setError('Could not answer approval.');
    } finally {
      setResolvingKeys((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  }, [rpc]);

  useEffect(() => {
    if (connectionState !== 'connected') {
      setPendingApprovals([]);
      return;
    }

    void refreshApprovals();
    const interval = window.setInterval(() => { void refreshApprovals(); }, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [connectionState, refreshApprovals]);

  useEffect(() => {
    if (connectionState !== 'connected') return;

    return subscribe((event: GatewayEvent) => {
      if (event.event === 'exec.approval.requested' || event.event === 'exec.approval.request') {
        const approval = normalizeExecApproval(event.payload);
        if (!approval) return;
        setPendingApprovals((current) => pruneExpired(dedupeApprovals([approval, ...current])));
        setError(null);
      } else if (event.event === 'plugin.approval.requested') {
        const approval = normalizePluginApproval(event.payload);
        if (!approval) return;
        setPendingApprovals((current) => pruneExpired(dedupeApprovals([approval, ...current])));
        setError(null);
      } else if (event.event === 'exec.approval.resolved' || event.event === 'plugin.approval.resolved') {
        const payload = isRecord(event.payload) ? event.payload : {};
        const id = stringValue(payload.id);
        if (!id) return;
        const kind: ApprovalKind = event.event.startsWith('exec.') ? 'exec' : 'plugin';
        setPendingApprovals((current) => current.filter((approval) => approvalKey(approval) !== `${kind}:${id}`));
        setError(null);
      }
    });
  }, [connectionState, subscribe]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      setPendingApprovals((current) => pruneExpired(current));
    }, 1_000);
    return () => window.clearInterval(interval);
  }, []);

  return useMemo(() => ({
    pendingApprovals,
    resolvingKeys,
    error,
    refreshApprovals,
    resolveApproval,
  }), [pendingApprovals, resolvingKeys, error, refreshApprovals, resolveApproval]);
}

export function approvalResolvingKey(approval: Pick<PendingApproval, 'id' | 'kind'>): string {
  return approvalKey(approval);
}
