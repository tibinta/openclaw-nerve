import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { KanbanBoard } from './KanbanBoard';

vi.mock('./hooks/useKanbanDragDrop', () => ({
  useKanbanDragDrop: () => ({
    sensors: [],
    collisionDetection: undefined,
    activeTask: null,
    onDragStart: vi.fn(),
    onDragOver: vi.fn(),
    onDragEnd: vi.fn(),
    onDragCancel: vi.fn(),
  }),
}));

vi.mock('./KanbanCard', () => ({
  KanbanCard: ({ task }: { task: { title: string } }) => <div>{task.title}</div>,
}));

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { children: React.ReactNode }) => (
    <button {...props}>{children}</button>
  ),
}));

const tasks = {
  backlog: [{ id: 'b1', title: 'Queue task', status: 'backlog', priority: 'normal', version: 1, labels: [], feedback: [], createdBy: 'operator', createdAt: 1, updatedAt: 1, columnOrder: 0 }],
  todo: [{ id: 't1', title: 'Ready task', status: 'todo', priority: 'normal', version: 1, labels: [], feedback: [], createdBy: 'operator', createdAt: 1, updatedAt: 1, columnOrder: 0 }],
  'in-progress': [{ id: 'a1', title: 'Active task', status: 'in-progress', priority: 'high', version: 1, labels: [], feedback: [], createdBy: 'operator', createdAt: 1, updatedAt: 1, columnOrder: 0 }],
  review: [{ id: 'r1', title: 'Review task', status: 'review', priority: 'normal', version: 1, labels: [], feedback: [], createdBy: 'operator', createdAt: 1, updatedAt: 1, columnOrder: 0 }],
  done: [{ id: 'd1', title: 'Archived task', status: 'done', priority: 'low', version: 1, labels: [], feedback: [], createdBy: 'operator', createdAt: 1, updatedAt: 1, columnOrder: 0 }],
};

describe('KanbanBoard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows Queue and Active first, then reveals Archive on demand', async () => {
    const user = userEvent.setup();
    render(
      <KanbanBoard
        tasksByStatus={(status) => tasks[status as keyof typeof tasks] ?? []}
        onCardClick={vi.fn()}
        loading={false}
        error={null}
        onRetry={vi.fn()}
        hasAnyTasks
        onCreateTask={vi.fn()}
        reorderTask={vi.fn(async (id, version, targetStatus, targetIndex) => ({ id, title: 'x', status: targetStatus, priority: 'normal', version, labels: [], feedback: [], createdBy: 'operator', createdAt: 1, updatedAt: 1, columnOrder: targetIndex }))}
        archivedTasks={tasks.done}
        onRestoreArchivedTask={vi.fn(async (id) => tasks.done[0])}
        onArchiveDone={vi.fn()}
        currentActiveTask={tasks['in-progress'][0]}
      />,
    );

    expect(screen.getByText('Queue')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('Archive')).toBeInTheDocument();
    expect(screen.getAllByText('Current active task').length).toBeGreaterThan(1);
    expect(screen.getAllByText('Active task').length).toBeGreaterThan(0);
    expect(screen.queryByText('Archived task')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^archive\s*1$/i }));
    expect(screen.getAllByText('Archived task').length).toBeGreaterThan(0);
  });
});
