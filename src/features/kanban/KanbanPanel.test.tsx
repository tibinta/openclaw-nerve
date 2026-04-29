import type React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { KanbanPanel } from './KanbanPanel';

const mockUseKanban = vi.fn();
const mockUseProposals = vi.fn();
const mockUseSessionContext = vi.fn();

vi.mock('./hooks/useKanban', () => ({
  useKanban: () => mockUseKanban(),
}));

vi.mock('./hooks/useProposals', () => ({
  useProposals: () => mockUseProposals(),
}));

vi.mock('@/contexts/SessionContext', () => ({
  useSessionContext: () => mockUseSessionContext(),
}));

vi.mock('./KanbanHeader', () => ({
  KanbanHeader: ({ onArchiveDone }: { onArchiveDone?: () => void }) => (
    <div>
      <button type="button" onClick={() => onArchiveDone?.()}>Archive Done</button>
    </div>
  ),
}));

vi.mock('./KanbanBoard', () => ({
  KanbanBoard: ({ currentActiveTask, archivedTasks = [] }: { currentActiveTask?: { title: string } | null; archivedTasks?: { title: string }[] }) => (
    <div data-testid="board">
      <span>{currentActiveTask?.title ?? 'none'}</span>
      <span>{archivedTasks.length}</span>
    </div>
  ),
}));

vi.mock('./CreateTaskDialog', () => ({
  CreateTaskDialog: () => null,
}));

vi.mock('./TaskDetailDrawer', () => ({
  TaskDetailDrawer: () => null,
}));

vi.mock('@/components/ui/button', () => ({
  Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} />,
}));

describe('KanbanPanel', () => {
  beforeEach(() => {
    mockUseKanban.mockReset();
    mockUseProposals.mockReset();
    mockUseSessionContext.mockReset();
    mockUseSessionContext.mockReturnValue({ currentSession: 'main' });
  });

  it('shows the current active task and archive access', async () => {
    const user = userEvent.setup();
    const archiveDoneTasks = vi.fn(async () => {});
    mockUseKanban.mockReturnValue({
      tasks: [
        { id: '1', title: 'Do the thing', status: 'in-progress', priority: 'high', version: 1, labels: [], feedback: [], createdBy: 'operator', createdAt: 1, updatedAt: 1, columnOrder: 0, assignee: 'agent:designer', swarmSummary: { sourceKind: 'crm_goal', objective: 'Get 20 customers today', packetsTotal: 5, packetsRunning: 3, packetsPassed: 1, packetsBlocked: 1 } },
        { id: '2', title: 'Later task', status: 'todo', priority: 'normal', version: 1, labels: [], feedback: [], createdBy: 'operator', createdAt: 1, updatedAt: 1, columnOrder: 0 },
      ],
      loading: false,
      error: null,
      filters: { q: '', priority: [], assignee: '', labels: [] },
      setFilters: vi.fn(),
      fetchTasks: vi.fn(),
      createTask: vi.fn(),
      updateTask: vi.fn(),
      deleteTask: vi.fn(),
      reorderTask: vi.fn(),
      tasksByStatus: vi.fn((status: string) => {
        if (status === 'in-progress') return [{ id: '1', title: 'Do the thing', status: 'in-progress', priority: 'high', version: 1, labels: [], feedback: [], createdBy: 'operator', createdAt: 1, updatedAt: 1, columnOrder: 0, assignee: 'agent:designer', swarmSummary: { sourceKind: 'crm_goal', objective: 'Get 20 customers today', packetsTotal: 5, packetsRunning: 3, packetsPassed: 1, packetsBlocked: 1 } }];
        if (status === 'todo') return [{ id: '2', title: 'Later task', status: 'todo', priority: 'normal', version: 1, labels: [], feedback: [], createdBy: 'operator', createdAt: 1, updatedAt: 1, columnOrder: 0 }];
        if (status === 'done') return [{ id: 'done-1', title: 'Completed task', status: 'done', priority: 'normal', version: 1, labels: [], feedback: [], createdBy: 'operator', createdAt: 1, updatedAt: 1, columnOrder: 0 }];
        return [];
      }),
      statusCounts: { backlog: 0, todo: 1, 'in-progress': 1, review: 0, done: 1 },
      boardColumns: ['todo', 'in-progress', 'done'],
      executeTask: vi.fn(),
      approveTask: vi.fn(),
      rejectTask: vi.fn(),
      abortTask: vi.fn(),
      archivedTasks: [{ id: 'arch-1', title: 'Archived task', status: 'done', priority: 'normal', version: 1, labels: [], feedback: [], createdBy: 'operator', createdAt: 1, updatedAt: 1, columnOrder: 0 }],
      archiveDoneTasks,
      restoreArchivedTask: vi.fn(async () => ({ id: 'arch-1', title: 'Archived task', status: 'done', priority: 'normal', version: 1, labels: [], feedback: [], createdBy: 'operator', createdAt: 1, updatedAt: 1, columnOrder: 0 })),
    });
    mockUseProposals.mockReturnValue({
      proposals: [],
      pendingCount: 0,
      approveProposal: vi.fn(),
      rejectProposal: vi.fn(),
    });

    render(<KanbanPanel />);

    expect(screen.getByText('Current active task')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Do the thing' })).toBeInTheDocument();
    expect(screen.getByTestId('board')).toHaveTextContent('Do the thing');
    expect(screen.getByText('Swarm: 5 packets, 3 running, 1 blocked')).toBeInTheDocument();
    expect(screen.getByText('Queue feeds Active. Archive stays visible, but out of the main work lane.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /archive done/i }));
    expect(archiveDoneTasks).toHaveBeenCalled();
  });

  it('prefers the in-progress task with a unique owner session when multiple are present', async () => {
    mockUseKanban.mockReturnValue({
      tasks: [
        { id: '1', title: 'Unowned active', status: 'in-progress', priority: 'high', version: 1, labels: [], feedback: [], createdBy: 'operator', createdAt: 1, updatedAt: 1, columnOrder: 0 },
        { id: '2', title: 'Owned active', status: 'in-progress', priority: 'normal', version: 1, labels: [], feedback: [], createdBy: 'operator', createdAt: 1, updatedAt: 2, columnOrder: 1, assignee: 'agent:codex' },
      ],
      loading: false,
      error: null,
      filters: { q: '', priority: [], assignee: '', labels: [] },
      setFilters: vi.fn(),
      fetchTasks: vi.fn(),
      createTask: vi.fn(),
      updateTask: vi.fn(),
      deleteTask: vi.fn(),
      reorderTask: vi.fn(),
      tasksByStatus: vi.fn((status: string) => {
        if (status === 'in-progress') {
          return [
            { id: '1', title: 'Unowned active', status: 'in-progress', priority: 'high', version: 1, labels: [], feedback: [], createdBy: 'operator', createdAt: 1, updatedAt: 1, columnOrder: 0 },
            { id: '2', title: 'Owned active', status: 'in-progress', priority: 'normal', version: 1, labels: [], feedback: [], createdBy: 'operator', createdAt: 1, updatedAt: 2, columnOrder: 1, assignee: 'agent:codex' },
          ];
        }
        return [];
      }),
      statusCounts: { backlog: 0, todo: 0, 'in-progress': 2, review: 0, done: 0 },
      boardColumns: ['in-progress'],
      executeTask: vi.fn(),
      approveTask: vi.fn(),
      rejectTask: vi.fn(),
      abortTask: vi.fn(),
      archivedTasks: [],
      archiveDoneTasks: vi.fn(),
      restoreArchivedTask: vi.fn(),
    });
    mockUseProposals.mockReturnValue({
      proposals: [],
      pendingCount: 0,
      approveProposal: vi.fn(),
      rejectProposal: vi.fn(),
    });

    render(<KanbanPanel />);

    expect(screen.getByTestId('board')).toHaveTextContent('Unowned active');
    expect(screen.getByText('Current active task')).toBeInTheDocument();
  });
});
