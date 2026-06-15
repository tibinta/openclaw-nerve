import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { KanbanQuickView } from './KanbanQuickView';

const mockCreateTask = vi.fn(async () => {});

vi.mock('./hooks/useKanban', () => ({
  useKanban: () => ({
    tasks: [],
    tasksByStatus: () => [],
    statusCounts: {},
    loading: false,
    error: null,
    createTask: mockCreateTask,
    updateTask: vi.fn(),
    deleteTask: vi.fn(),
    executeTask: vi.fn(),
    approveTask: vi.fn(),
    rejectTask: vi.fn(),
    abortTask: vi.fn(),
  }),
}));

vi.mock('./CreateTaskDialog', () => ({
  CreateTaskDialog: ({ open }: { open: boolean }) => (
    <div data-testid="create-task-dialog">{open ? 'open' : 'closed'}</div>
  ),
}));

vi.mock('./TaskDetailDrawer', () => ({
  TaskDetailDrawer: () => null,
}));

describe('KanbanQuickView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('opens the create task dialog from the add task button', async () => {
    const user = userEvent.setup();

    render(<KanbanQuickView onOpenBoard={vi.fn()} />);

    expect(screen.getByTestId('create-task-dialog')).toHaveTextContent('closed');

    await user.click(screen.getByRole('button', { name: /add task/i }));

    expect(screen.getByTestId('create-task-dialog')).toHaveTextContent('open');
  });
});
