import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { KanbanQuickView } from './KanbanQuickView';
import type { KanbanTask, TaskStatus } from './types';

const mockCreateTask = vi.fn(async () => {});
const mockTask: KanbanTask = {
  id: 'task-1',
  title: 'Open this task',
  description: 'Task details',
  status: 'in-progress',
  priority: 'normal',
  createdBy: 'operator',
  createdAt: 1,
  updatedAt: 1,
  version: 1,
  labels: [],
  columnOrder: 0,
  feedback: [],
};
let mockTasks: KanbanTask[] = [];

vi.mock('./hooks/useKanban', () => ({
  useKanban: () => ({
    tasks: mockTasks,
    tasksByStatus: (status: TaskStatus) => mockTasks.filter((task) => task.status === status),
    statusCounts: mockTasks.reduce<Record<string, number>>((counts, task) => {
      counts[task.status] = (counts[task.status] || 0) + 1;
      return counts;
    }, {}),
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
  TaskDetailDrawer: ({ task, variant }: { task: KanbanTask | null; variant?: string }) => (
    <div data-testid="task-detail-drawer" data-variant={variant ?? 'drawer'}>
      {task?.title ?? 'closed'}
    </div>
  ),
}));

describe('KanbanQuickView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTasks = [];
  });

  it('opens the create task dialog from the add task button', async () => {
    const user = userEvent.setup();

    render(<KanbanQuickView onOpenBoard={vi.fn()} />);

    expect(screen.getByTestId('create-task-dialog')).toHaveTextContent('closed');

    await user.click(screen.getByRole('button', { name: /add task/i }));

    expect(screen.getByTestId('create-task-dialog')).toHaveTextContent('open');
  });

  it('opens clicked task details in the modal variant', async () => {
    const user = userEvent.setup();
    mockTasks = [mockTask];

    render(<KanbanQuickView onOpenBoard={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /open this task/i }));

    expect(screen.getByTestId('task-detail-drawer')).toHaveTextContent('Open this task');
    expect(screen.getByTestId('task-detail-drawer')).toHaveAttribute('data-variant', 'modal');
  });

  it('shows every task in a status section', () => {
    mockTasks = Array.from({ length: 9 }, (_, index) => ({
      ...mockTask,
      id: `task-${index + 1}`,
      title: `Task ${index + 1}`,
      status: 'todo',
      columnOrder: index,
    }));

    render(<KanbanQuickView onOpenBoard={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Task 9' })).toBeInTheDocument();
    expect(screen.queryByText('+4 more')).not.toBeInTheDocument();
  });
});
