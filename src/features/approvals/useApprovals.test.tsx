import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GatewayEvent } from '@/types';
import {
  normalizeExecApproval,
  redactApprovalText,
  useApprovals,
  type PendingApproval,
} from './useApprovals';

const gatewayMock = vi.hoisted(() => ({
  state: {
    connectionState: 'connected' as const,
    rpc: vi.fn(),
    subscribe: vi.fn(),
  },
  subscribers: [] as Array<(event: GatewayEvent) => void>,
}));

vi.mock('@/contexts/GatewayContext', () => ({
  useGateway: () => gatewayMock.state,
}));

const now = Date.now();

function execRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'exec-1',
    createdAtMs: now,
    expiresAtMs: now + 60_000,
    request: {
      command: '/usr/bin/open -na "Google Chrome"',
      commandPreview: '/usr/bin/open -na "Google Chrome"',
      agentId: 'jane-whitmore---ceo',
      host: 'node',
      security: 'warning',
      allowedDecisions: ['allow-once', 'deny'],
    },
    ...overrides,
  };
}

function pluginRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'plugin-1',
    createdAtMs: now - 1_000,
    expiresAtMs: now + 60_000,
    request: {
      title: 'Allow the ghl-mcp MCP server to run tool "read_leads"?',
      description: 'Read HighLevel conversations for proof. No writes.',
      pluginId: 'openclaw-codex-app-server',
      toolName: 'read_leads',
      severity: 'warning',
      allowedDecisions: ['allow-once', 'allow-always', 'deny'],
    },
    ...overrides,
  };
}

function setupGateway(rpcImpl?: (method: string, params?: Record<string, unknown>) => Promise<unknown>) {
  gatewayMock.subscribers = [];
  gatewayMock.state.connectionState = 'connected';
  gatewayMock.state.rpc = vi.fn(rpcImpl ?? (async (method: string) => {
    if (method === 'exec.approval.list') return [];
    if (method === 'plugin.approval.list') return [];
    return {};
  }));
  gatewayMock.state.subscribe = vi.fn((handler: (event: GatewayEvent) => void) => {
    gatewayMock.subscribers.push(handler);
    return () => {
      gatewayMock.subscribers = gatewayMock.subscribers.filter((item) => item !== handler);
    };
  });
}

function emit(event: string, payload: unknown) {
  act(() => {
    for (const subscriber of gatewayMock.subscribers) {
      subscriber({ type: 'event', event, payload });
    }
  });
}

describe('approval normalization', () => {
  it('redacts sensitive values before display', () => {
    const text = 'Email jane@example.com, phone +44 7494 722196, link https://example.com/a, token sk-live-secret1234567890';

    expect(redactApprovalText(text)).toBe('Email [email], phone [phone], link [link], token [token]');
  });

  it('normalizes command approvals without exposing session metadata by default', () => {
    const approval = normalizeExecApproval(execRecord({
      request: {
        command: 'curl https://example.com?phone=+447494722196',
        sessionKey: 'agent:jane:imessage:direct:+447494722196',
        agentId: 'jane-whitmore---ceo',
      },
    }));

    expect(approval?.kind).toBe('exec');
    expect(approval?.description).toContain('[link]');
    expect(approval?.description).not.toContain('+447494');
    expect(approval?.metadata.some((item) => item.label === 'Session')).toBe(false);
  });
});

describe('useApprovals', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupGateway();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads both command and plugin approval queues', async () => {
    setupGateway(async (method: string) => {
      if (method === 'exec.approval.list') return [execRecord()];
      if (method === 'plugin.approval.list') return [pluginRecord()];
      return {};
    });

    const { result } = renderHook(() => useApprovals());

    await waitFor(() => expect(result.current.pendingApprovals).toHaveLength(2));

    expect(gatewayMock.state.rpc).toHaveBeenCalledWith('exec.approval.list', {});
    expect(gatewayMock.state.rpc).toHaveBeenCalledWith('plugin.approval.list', {});
    expect(result.current.pendingApprovals.map((approval) => approval.kind)).toEqual(['exec', 'plugin']);
  });

  it('adds requested approvals from live gateway events and removes resolved ones', async () => {
    const { result } = renderHook(() => useApprovals());

    await waitFor(() => expect(gatewayMock.state.subscribe).toHaveBeenCalled());

    emit('exec.approval.requested', execRecord({ id: 'exec-event' }));
    emit('plugin.approval.requested', pluginRecord({ id: 'plugin-event' }));

    await waitFor(() => expect(result.current.pendingApprovals).toHaveLength(2));

    emit('exec.approval.resolved', { id: 'exec-event', decision: 'allow-once' });

    await waitFor(() => {
      expect(result.current.pendingApprovals.map((approval) => approval.id)).toEqual(['plugin-event']);
    });
  });

  it('resolves each approval through the matching gateway method', async () => {
    setupGateway(async (method: string) => {
      if (method === 'exec.approval.list') return [execRecord()];
      if (method === 'plugin.approval.list') return [pluginRecord()];
      return {};
    });

    const { result } = renderHook(() => useApprovals());

    await waitFor(() => expect(result.current.pendingApprovals).toHaveLength(2));

    const execApproval = result.current.pendingApprovals.find((approval) => approval.kind === 'exec') as PendingApproval;
    const pluginApproval = result.current.pendingApprovals.find((approval) => approval.kind === 'plugin') as PendingApproval;

    await act(async () => {
      await result.current.resolveApproval(execApproval, 'allow-once');
      await result.current.resolveApproval(pluginApproval, 'deny');
    });

    expect(gatewayMock.state.rpc).toHaveBeenCalledWith('exec.approval.resolve', {
      id: 'exec-1',
      decision: 'allow-once',
    });
    expect(gatewayMock.state.rpc).toHaveBeenCalledWith('plugin.approval.resolve', {
      id: 'plugin-1',
      decision: 'deny',
    });
  });
});
