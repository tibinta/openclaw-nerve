import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Session } from '@/types';
import type { GatewayAgentRegistration } from '@/contexts/SessionContext';
import { SessionList } from './SessionList';

vi.mock('@/components/skeletons', () => ({
  SessionSkeletonGroup: ({ count = 4 }: { count?: number }) => (
    <div data-testid="session-skeleton-group">Loading {count}</div>
  ),
}));

function renderSessionList(props: Partial<React.ComponentProps<typeof SessionList>> = {}) {
  return render(
    <SessionList
      sessions={[]}
      currentSession=""
      busyState={{}}
      onSelect={() => {}}
      onRefresh={() => {}}
      {...props}
    />,
  );
}

describe('SessionList live tree', () => {
  it('shows real live agent families instead of collapsing them into an empty state', () => {
    const sessions: Session[] = [
      { sessionKey: 'agent:sean:main', label: 'heartbeat', updatedAt: Date.now() - 1_000 },
      { sessionKey: 'agent:sean:subagent:abc123', label: 'Worker', parentId: 'agent:sean:main', updatedAt: Date.now() },
      { sessionKey: 'agent:whatsapp:main', label: 'heartbeat', updatedAt: Date.now() - 2_000 },
    ];

    renderSessionList({
      sessions,
      agents: [
        { id: 'sean', identityName: 'Sean Root' },
        { id: 'whatsapp', identityName: 'WhatsApp Root' },
      ],
    });

    expect(screen.getByText('Sean Root')).toBeInTheDocument();
    expect(screen.getByText('WhatsApp Root')).toBeInTheDocument();
    expect(screen.getByText('Worker')).toBeInTheDocument();
    expect(screen.queryByText('No active sessions')).not.toBeInTheDocument();
  });

  it('shows live subagents with their current status text', () => {
    const sessions: Session[] = [
      { sessionKey: 'agent:jane:main', label: 'Jane', status: 'running', totalTokens: 420 },
      { sessionKey: 'agent:jane:subagent:abc123', label: 'Evidence audit', status: 'running', totalTokens: 84, parentId: 'agent:jane:main' },
    ];

    const agentStatus = {
      'agent:jane:main': { status: 'THINKING', since: Date.now(), toolName: 'sessions.list' },
      'agent:jane:subagent:abc123': { status: 'STREAMING', since: Date.now() },
    };

    renderSessionList({ sessions, agentStatus });

    expect(screen.getByText('Evidence audit')).toBeInTheDocument();
    expect(screen.getByText('TOOL: sessions.list')).toBeInTheDocument();
    expect(screen.getByText('STREAMING')).toBeInTheDocument();
  });

  it('does not show a stale running badge when the gateway has no active run', () => {
    const sessions: Session[] = [
      {
        sessionKey: 'agent:jane:imessage:direct:+447494722196',
        label: 'Jane direct',
        status: 'running',
        state: 'running',
        busy: true,
        processing: true,
        hasActiveRun: false,
        updatedAt: Date.now(),
      },
    ];

    renderSessionList({
      sessions,
      busyState: { 'agent:jane:imessage:direct:+447494722196': true },
      agentStatus: {
        'agent:jane:imessage:direct:+447494722196': { status: 'THINKING', since: Date.now() },
      },
    });

    expect(screen.getAllByText('IDLE')).toHaveLength(2);
    expect(screen.getAllByText(/Idle · just now/i)).toHaveLength(2);
    expect(screen.queryByText('WORKING')).not.toBeInTheDocument();
    expect(screen.queryByText('THINKING')).not.toBeInTheDocument();
  });

  it('shows configured agents in a fallback section when there are no live sessions', () => {
    const agents: GatewayAgentRegistration[] = [
      { id: 'jane', name: 'Jane' },
      { id: 'support', name: 'Support' },
    ];

    renderSessionList({ agents });

    expect(screen.getByText('No active sessions')).toBeInTheDocument();
    expect(screen.getByText('Configured agents')).toBeInTheDocument();
    expect(screen.getAllByText('Jane')).toHaveLength(2);
    expect(screen.getAllByText('Support')).toHaveLength(2);
  });

  it('opens a confirmation dialog for deleting all sessions without counting fallback rows', async () => {
    const onDeleteAllSessions = vi.fn().mockResolvedValue(undefined);

    renderSessionList({
      sessions: [
        { sessionKey: 'agent:designer:main', label: 'heartbeat', updatedAt: Date.now() - 2_000 },
        { sessionKey: 'agent:designer:subagent:abc123', label: 'Designer worker', parentId: 'agent:designer:main', updatedAt: Date.now() - 1_000 },
        { sessionKey: 'heartbeat-dispatch-2026-05-06', label: 'Dispatch Run' },
      ],
      agents: [
        { id: 'designer', name: 'Designer' },
        { id: 'reviewer', name: 'Reviewer' },
      ],
      onDeleteAllSessions,
    });

    fireEvent.click(screen.getByRole('button', { name: /delete all sessions/i }));

    expect(screen.getByText(/delete all sessions/i)).toBeInTheDocument();
    expect(screen.getByText(/delete every loaded session and transcript/i)).toBeInTheDocument();
    expect(screen.getByTestId('loaded-session-count')).toHaveTextContent('3');
    expect(screen.getByText(/visible agent sessions/i)).toBeInTheDocument();
    expect(screen.getByText('Configured agents')).toBeInTheDocument();
    expect(screen.getAllByText('Reviewer')).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: /^delete all$/i }));

    await waitFor(() => {
      expect(onDeleteAllSessions).toHaveBeenCalledTimes(1);
    });
  });

  it('uses the registry name for the family row and keeps Jane direct as the child session', () => {
    const sessions: Session[] = [
      { sessionKey: 'agent:jane-whitmore---ceo:main', label: 'heartbeat', lastActivity: Date.now() - 5 * 60_000, updatedAt: Date.now() - 5 * 60_000, state: 'running', processing: true },
      { sessionKey: 'agent:jane-whitmore---ceo:imessage:direct:+447494722196', label: 'Jane Whitmore - CEO', lastActivity: Date.now() - 2 * 60_000, updatedAt: Date.now() - 2 * 60_000, state: 'idle' },
    ];
    const agents: GatewayAgentRegistration[] = [
      { id: 'jane-whitmore---ceo', name: 'Jane Registry' },
    ];

    renderSessionList({ sessions, agents });

    expect(screen.getByText('Jane Registry')).toBeInTheDocument();
    expect(screen.getByText('+447494722196')).toBeInTheDocument();
    expect(screen.queryByText('Jane Whitmore - CEO')).not.toBeInTheDocument();
    expect(screen.getAllByText(/Idle · 2m ago/i)).toHaveLength(2);
  });

  it('groups heartbeat-suffixed family rows and suppresses duplicate fallback roots', () => {
    const sessions: Session[] = [
      { sessionKey: 'agent:henry:main:heartbeat', label: 'heartbeat', status: 'running', totalTokens: 420, updatedAt: Date.now() - 2_000 },
      { sessionKey: 'agent:henry:subagent:abc:heartbeat', label: 'Evidence audit', status: 'running', totalTokens: 84, updatedAt: Date.now() - 1_000, parentId: 'agent:henry:main' },
    ];
    const agents: GatewayAgentRegistration[] = [
      { id: 'henry', name: 'Henry Registry' },
    ];

    renderSessionList({ sessions, agents });

    expect(screen.getByText('Henry Registry')).toBeInTheDocument();
    expect(screen.getByText('Evidence audit')).toBeInTheDocument();
    expect(screen.queryByText('Agent henry')).not.toBeInTheDocument();
  });

  it('hides non-agent root sessions from the AGENTS panel', () => {
    const sessions: Session[] = [
      { sessionKey: 'discord:sean', label: 'Discord Root' },
      { sessionKey: 'heartbeat-dispatch-2026-05-06', label: 'Dispatch Run' },
    ];

    renderSessionList({ sessions });

    expect(screen.getByText('No active sessions')).toBeInTheDocument();
    expect(screen.queryByText('Discord Root')).not.toBeInTheDocument();
    expect(screen.queryByText('Dispatch Run')).not.toBeInTheDocument();
  });
});
