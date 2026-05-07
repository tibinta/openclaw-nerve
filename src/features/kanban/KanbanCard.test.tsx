import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { KanbanCard } from './KanbanCard';

vi.mock('@dnd-kit/sortable', () => ({
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
    transition: undefined,
    isDragging: false,
  }),
}));

describe('KanbanCard', () => {
  it('does not show an error badge when run status is missing', () => {
    render(
      <KanbanCard
        task={{
          id: 'legacy-run',
          title: 'Legacy run task',
          status: 'in-progress',
          priority: 'normal',
          createdBy: 'operator',
          createdAt: 1,
          updatedAt: 1,
          version: 1,
          labels: [],
          feedback: [],
          columnOrder: 0,
          run: {
            sessionKey: 'run-1',
            startedAt: 1,
          } as never,
        } as never}
        onClick={vi.fn()}
      />,
    );

    expect(screen.getByText('Legacy run task')).toBeInTheDocument();
    expect(screen.queryByText('Error')).not.toBeInTheDocument();
    expect(screen.queryByText('Live')).not.toBeInTheDocument();
  });
});
