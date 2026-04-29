import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { TopBar } from './TopBar';

vi.mock('@/features/dashboard/useLimits', () => ({
  useLimits: () => ({ codexLimits: { available: true, rotation: { available: true, activeAccount: 'alex', profileCount: 2 } } })
}));

vi.mock('./NerveLogo', () => ({
  default: () => <div data-testid="nerve-logo" />,
}));

function renderTopBar(props: Partial<React.ComponentProps<typeof TopBar>> = {}) {
  return render(
    <TopBar
      onSettings={vi.fn()}
      agentLogEntries={[]}
      tokenData={null}
      logGlow={false}
      eventEntries={[]}
      eventsVisible={false}
      logVisible={false}
      viewMode="chat"
      onViewModeChange={vi.fn()}
      {...props}
    />,
  );
}

describe('TopBar', () => {
  it('shows the tasks view toggle by default', () => {
    renderTopBar();

    expect(screen.getByRole('button', { name: /switch to tasks view/i })).toBeInTheDocument();
  });

  it('shows a Codex status pill in the top bar', () => {
    renderTopBar();
    expect(screen.getByLabelText(/Codex watcher armed, active account alex/i)).toBeInTheDocument();
    expect(screen.getByText(/alex/i)).toBeInTheDocument();
    expect(screen.getByText(/watcher armed/i)).toBeInTheDocument();
  });

  it('hides the tasks view toggle when kanban visibility is disabled', () => {
    renderTopBar({ showKanbanView: false });

    expect(screen.queryByRole('button', { name: /switch to tasks view/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /switch to chat view/i })).toBeInTheDocument();
  });

  it('shows Targets beside Chat and Tasks when enabled', async () => {
    const user = userEvent.setup();
    const onOpenAccountability = vi.fn();
    renderTopBar({ onOpenAccountability });

    const chat = screen.getByRole('button', { name: /switch to chat view/i });
    const tasks = screen.getByRole('button', { name: /switch to tasks view/i });
    const targets = screen.getByRole('button', { name: /open targets/i });

    expect(chat.compareDocumentPosition(tasks) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(tasks.compareDocumentPosition(targets) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await user.click(targets);
    expect(onOpenAccountability).toHaveBeenCalledTimes(1);
  });
});
