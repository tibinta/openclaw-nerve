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
    expect(screen.getByText('Worker')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /load more sessions/i })).toBeInTheDocument();
    expect(screen.queryByText('No active sessions')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /load more sessions/i }));
    expect(screen.getByText('WhatsApp Root')).toBeInTheDocument();
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
      { sessionKey: 'agent:main:imessage:direct:+447494722196', label: 'Jane Whitmore - CEO', lastActivity: Date.now() - 2 * 60_000, updatedAt: Date.now() - 2 * 60_000, state: 'idle' },
    ];
    const agents: GatewayAgentRegistration[] = [
      { id: 'main', name: 'Jane Registry' },
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

  it('renders one Jane Nerve Live row when direct and heartbeat records coexist', () => {
    const sessions: Session[] = [
      { sessionKey: 'agent:main:voice:direct:nerve-live', label: 'Nerve Live', status: 'idle', updatedAt: Date.now() },
      { sessionKey: 'agent:main:voice:direct:nerve-live:heartbeat', label: 'heartbeat', status: 'idle', updatedAt: Date.now() - 1_000 },
    ];

    renderSessionList({ sessions, agents: [{ id: 'main', identityName: 'Jane Whitmore - CEO' }] });

    expect(screen.getAllByText('nerve-live')).toHaveLength(1);
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

  it('hides only the title when embedded and keeps the compact title by default', () => {
    renderSessionList({ hideTitle: true, onDeleteAllSessions: vi.fn().mockResolvedValue(undefined) });

    expect(screen.queryByText('AGENTS', { exact: true })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete all sessions' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh sessions' })).toBeInTheDocument();

    renderSessionList({ compact: true });
    expect(screen.getByText('AGENTS', { exact: true })).toBeInTheDocument();
  });

  it('shows only the first 3 live sessions by default and loads in batches of 5', () => {
    const now = Date.now();
    renderSessionList({
      sessions: Array.from({ length: 10 }, (_, i) => ({
        sessionKey: `agent:agent${i}:main`,
        label: `Agent ${i}`,
        updatedAt: now - i * 1000,
      })),
    });

    const initialAgentLabelCount = screen.getAllByText((text) => /^Agent \d+$/.test(text)).length;
    expect(initialAgentLabelCount).toBeGreaterThan(0);
    expect(screen.queryAllByText('Agent 3')).toHaveLength(0);
    const loadMoreBtn = screen.getByRole('button', { name: /load more sessions/i });
    expect(loadMoreBtn).toBeInTheDocument();
    expect(loadMoreBtn.textContent).toMatch(/Load \d+ more sessions/);

    fireEvent.click(screen.getByRole('button', { name: /load more sessions/i }));
    const loadedAgentLabelCount = screen.getAllByText((text) => /^Agent \d+$/.test(text)).length;

    expect(loadedAgentLabelCount).toBeGreaterThan(initialAgentLabelCount);
    expect(screen.queryByText('Agent 8')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /load more sessions/i }).textContent).toMatch(/Load \d+ more sessions/);
  });

  it('keeps the current selected session visible when it is beyond the live batch window', () => {
    const now = Date.now();
    renderSessionList({
      currentSession: 'agent:agent3:main',
      sessions: [
        { sessionKey: 'agent:agent0:main', label: 'Agent 0', updatedAt: now - 5_000 },
        { sessionKey: 'agent:agent1:main', label: 'Agent 1', updatedAt: now - 4_000 },
        { sessionKey: 'agent:agent2:main', label: 'Agent 2', updatedAt: now - 3_000 },
        { sessionKey: 'agent:agent3:main', label: 'Agent 3', updatedAt: now - 2_000 },
        { sessionKey: 'agent:agent4:main', label: 'Agent 4', updatedAt: now - 1_000 },
        { sessionKey: 'agent:agent5:main', label: 'Agent 5', updatedAt: now },
      ],
    });

    expect(screen.getAllByText('Agent 3').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /load more sessions/i })).toBeInTheDocument();
  });
});
