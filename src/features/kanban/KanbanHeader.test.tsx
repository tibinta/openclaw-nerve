import { fireEvent, render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { KanbanHeader } from './KanbanHeader';
import type { KanbanFilters } from './hooks/useKanban';
import type { TaskStatus } from './types';
import type { KanbanProposal } from './hooks/useProposals';

const filters: KanbanFilters = {
  q: '',
  priority: [],
  assignee: '',
  labels: [],
};

const statusCounts: Record<TaskStatus, number> = {
  backlog: 2,
  todo: 3,
  'in-progress': 2,
  review: 1,
  done: 4,
};

describe('KanbanHeader', () => {
  it('keeps queue, active, and archive controls visible in the header', () => {
    render(
      <KanbanHeader
        filters={filters}
        onFiltersChange={vi.fn()}
        statusCounts={statusCounts}
        workflowCounts={{ queue: 5, active: 3, archive: 4 }}
        onCreateTask={vi.fn()}
        onArchiveDone={vi.fn()}
      />,
    );

    expect(screen.getByPlaceholderText('Search tasks…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /archive done/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /new task/i })).toBeInTheDocument();
    expect(screen.getByText('Queue')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('Archive')).toBeInTheDocument();
  });

  it('opens agent proposals as a viewport-wide review panel', () => {
    const proposals: KanbanProposal[] = [
      {
        id: 'proposal-1',
        type: 'create',
        status: 'pending',
        version: 1,
        proposedAt: Date.now(),
        proposedBy: 'agent:test',
        payload: {
          title: 'Tim - new normal daily notes needs confirmation',
          description: 'Use enough room to read the full proposal before approving or rejecting it.',
          labels: ['daily-notes', 'needs-confirmation'],
        },
      },
    ];

    render(
      <KanbanHeader
        filters={filters}
        onFiltersChange={vi.fn()}
        statusCounts={statusCounts}
        workflowCounts={{ queue: 5, active: 3, archive: 4 }}
        onCreateTask={vi.fn()}
        onArchiveDone={vi.fn()}
        proposals={proposals}
        pendingProposalCount={proposals.length}
      />,
    );

    fireEvent.click(screen.getByTitle('Agent proposals'));

    const panel = screen.getByRole('dialog', { name: 'Agent proposals' });
    expect(panel).toHaveClass('fixed', 'left-2', 'right-2', 'sm:left-6', 'sm:right-6');
    expect(screen.getByText('Tim - new normal daily notes needs confirmation')).toBeInTheDocument();
    expect(screen.getByText(/Use enough room to read the full proposal/)).toBeInTheDocument();
  });
});
