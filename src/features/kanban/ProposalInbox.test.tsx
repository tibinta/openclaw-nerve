import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ProposalInbox } from './ProposalInbox';
import type { KanbanTask } from './types';
import type { KanbanProposal } from './hooks/useProposals';

function makeTask(overrides: Partial<KanbanTask>): KanbanTask {
  return {
    id: 'task-1',
    title: 'Sync data from Omni Brain',
    status: 'todo',
    priority: 'normal',
    createdBy: 'agent:omnibrain-sync',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    version: 1,
    labels: ['omnibrain'],
    columnOrder: 0,
    feedback: [],
    ...overrides,
  };
}

describe('ProposalInbox suggested tasks section', () => {
  it('shows the action error when a failed decision restores a row', () => {
    render(<ProposalInbox proposals={[{
      id: 'retry-me', type: 'create', payload: { title: 'Retry me' }, proposedBy: 'agent:codex',
      proposedAt: Date.now(), status: 'pending', version: 1, actionError: 'Could not approve. Try again.',
    }]} onApprove={vi.fn()} onReject={vi.fn()} />);

    expect(screen.getByRole('alert')).toHaveTextContent('Could not approve. Try again.');
    expect(screen.getByRole('button', { name: 'Approve proposal' })).toBeEnabled();
  });

  it('shows direct proposals first and keeps background proposals collapsed with a count', () => {
    const direct: KanbanProposal = {
      id: 'direct', type: 'create', payload: { title: 'Direct proposal' }, proposedBy: 'agent:codex',
      proposedAt: Date.now(), status: 'pending', version: 1,
    };
    const background: KanbanProposal = {
      id: 'background', type: 'create', payload: { title: 'Background proposal' }, proposedBy: 'agent:omnibrain-sync',
      proposedAt: Date.now(), status: 'pending', version: 1,
    };

    render(<ProposalInbox proposals={[background, direct]} onApprove={vi.fn()} onReject={vi.fn()} />);

    expect(screen.getByText('Direct proposal')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Background proposals (1)' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Background proposal')).not.toBeInTheDocument();
  });

  it('confirms the current background count before requesting batch rejection', async () => {
    const background: KanbanProposal = {
      id: 'background', type: 'create', payload: { title: 'Background proposal' }, proposedBy: 'agent:omnibrain-sync',
      proposedAt: Date.now(), status: 'pending', version: 1,
    };
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const rejectBackground = vi.fn(async () => 1);

    render(
      <ProposalInbox
        proposals={[background]}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onRejectBackground={rejectBackground}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reject remaining background proposals' }));

    expect(confirm).toHaveBeenCalledWith('Reject up to 1 background proposals shown?');
    await waitFor(() => expect(rejectBackground).toHaveBeenCalledOnce());
    expect(rejectBackground).toHaveBeenCalledWith(['background']);
  });

  it('shows a rejected batch error inline', async () => {
    const background: KanbanProposal = {
      id: 'background', type: 'create', payload: { title: 'Background proposal' }, proposedBy: 'agent:omnibrain-sync',
      proposedAt: Date.now(), status: 'pending', version: 1,
    };
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const rejectBackground = vi.fn(async () => { throw new Error('Server unavailable'); });
    render(
      <ProposalInbox
        proposals={[background]}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onRejectBackground={rejectBackground}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Reject remaining background proposals' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not reject background proposals: Server unavailable',
    );
  });

  it('keeps proposal context in one compact row until VIEW (CONV) is clicked', async () => {
    const proposal: KanbanProposal = {
      id: 'proposal-1',
      type: 'create',
      payload: {
        title: 'Prepare the follow-up',
        description: 'Source: Omni Brain conversation "Client call"\n\nContext: The follow-up is due in two weeks.\n\n[omni:omni-1]\n\nFull conversation snapshot:\nAlex: We should do this in two weeks.\nJane: Noted.',
      },
      proposedBy: 'agent:omnibrain-sync',
      proposedAt: Date.now(),
      status: 'pending',
      version: 1,
    };

    const onApprove = vi.fn();
    render(<ProposalInbox proposals={[proposal]} onApprove={onApprove} onReject={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Background proposals (1)' }));

    expect(screen.getByText(/Source: Omni Brain conversation/)).toBeInTheDocument();
    expect(screen.queryByText(/due in two weeks/)).not.toBeInTheDocument();
    expect(screen.queryByText(/We should do this in two weeks/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /View full conversation for Prepare the follow-up/i }));
    expect(screen.getByText(/due in two weeks/)).toBeInTheDocument();
    expect(screen.getByText(/We should do this in two weeks/)).toBeInTheDocument();

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Approve proposal' })); });
    expect(onApprove).toHaveBeenCalledWith('proposal-1');
  });

  it('does not approve a legacy Omni suggestion whose source context is gone', () => {
    const proposal: KanbanProposal = {
      id: 'legacy-proposal',
      type: 'create',
      payload: {
        title: 'Old suggestion',
        labels: ['omnibrain'],
        description: 'Source: Omni Brain conversation "Old call"\n\n[omni:old-action]',
      },
      proposedBy: 'agent:omnibrain-sync',
      proposedAt: Date.now(),
      status: 'pending',
      version: 1,
    };

    render(<ProposalInbox proposals={[proposal]} onApprove={vi.fn()} onReject={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Background proposals (1)' }));

    expect(screen.getByText(/Full source context is unavailable/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve proposal' })).toBeDisabled();
  });

  it('renders agent-suggested tasks with labels', () => {
    render(
      <ProposalInbox
        proposals={[]}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        suggestedTasks={[makeTask({})]}
        onOpenTask={vi.fn()}
      />,
    );

    expect(screen.getByText('Suggested tasks')).toBeInTheDocument();
    expect(screen.getByText('Sync data from Omni Brain')).toBeInTheDocument();
    expect(screen.getByText('omnibrain')).toBeInTheDocument();
  });

  it('fires onOpenTask when a suggested task row is clicked', () => {
    const onOpenTask = vi.fn();
    render(
      <ProposalInbox
        proposals={[]}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        suggestedTasks={[makeTask({ id: 'task-42' })]}
        onOpenTask={onOpenTask}
      />,
    );

    fireEvent.click(screen.getByText('Sync data from Omni Brain'));
    expect(onOpenTask).toHaveBeenCalledWith('task-42');
  });

  it('shows the empty state when there are no proposals and no suggested tasks', () => {
    render(
      <ProposalInbox
        proposals={[]}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        suggestedTasks={[]}
        onOpenTask={vi.fn()}
      />,
    );

    expect(screen.getByText('Inbox clear')).toBeInTheDocument();
  });
});
