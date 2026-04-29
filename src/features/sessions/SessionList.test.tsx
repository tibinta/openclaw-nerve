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
  it('shows real live sessions instead of collapsing them into an empty state', () => {
    const sessions: Session[] = [
      { sessionKey: 'discord:sean', label: 'Discord Root' },
      { sessionKey: 'whatsapp:sean', label: 'WhatsApp Root' },
    ];

    renderSessionList({ sessions });

    expect(screen.getByText('Discord Root')).toBeInTheDocument();
    expect(screen.getByText('WhatsApp Root')).toBeInTheDocument();
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

  it('shows configured agents even when there are no live sessions', () => {
    const agents: GatewayAgentRegistration[] = [
      { id: 'jane', name: 'Jane' },
      { id: 'main', name: 'Main Controller' },
    ];

    renderSessionList({ agents });

    expect(screen.getByText('Jane')).toBeInTheDocument();
    expect(screen.queryByText('No active sessions')).not.toBeInTheDocument();
  });

  it('opens a confirmation dialog for deleting all sessions', async () => {
    const onDeleteAllSessions = vi.fn().mockResolvedValue(undefined);

    renderSessionList({
      sessions: [
        { sessionKey: 'agent:jane:main', label: 'Jane' },
      ],
      onDeleteAllSessions,
    });

    fireEvent.click(screen.getByRole('button', { name: /delete all sessions/i }));

    expect(screen.getByText(/delete all sessions/i)).toBeInTheDocument();
    expect(screen.getByText(/delete every loaded session and transcript/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^delete all$/i }));

    await waitFor(() => {
      expect(onDeleteAllSessions).toHaveBeenCalledTimes(1);
    });
  });

  it('prefers the live session row while keeping the registry label as fallback', () => {
    const sessions: Session[] = [
      { sessionKey: 'agent:jane:main', label: 'Live Jane', lastActivity: Date.now() - 5 * 60_000, updatedAt: Date.now() - 5 * 60_000, state: 'running', processing: true },
    ];
    const agents: GatewayAgentRegistration[] = [
      { id: 'jane', name: 'Jane Registry' },
    ];

    renderSessionList({ sessions, agents });

    expect(screen.getByText('Live Jane')).toBeInTheDocument();
    expect(screen.queryByText('Jane Registry')).not.toBeInTheDocument();
    expect(screen.getByText(/Working · 5m ago/i)).toBeInTheDocument();
  });
});
