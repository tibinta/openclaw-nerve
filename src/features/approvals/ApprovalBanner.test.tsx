import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApprovalBanner } from './ApprovalBanner';
import type { PendingApproval } from './useApprovals';

function commandApproval(overrides: Partial<PendingApproval> = {}): PendingApproval {
  return {
    id: 'exec-1',
    kind: 'exec',
    title: 'Command approval',
    description: 'Command: open [link] --user [email] --phone [phone] --token [token]',
    severity: 'warning',
    metadata: [
      { label: 'Type', value: 'Command' },
      { label: 'Agent', value: 'jane-whitmore---ceo' },
    ],
    allowedDecisions: ['allow-once', 'deny'],
    createdAtMs: Date.now(),
    expiresAtMs: Date.now() + 60_000,
    ...overrides,
  };
}

describe('ApprovalBanner', () => {
  it('renders command approvals with redacted details and allowed actions', () => {
    const onDecision = vi.fn();
    render(
      <ApprovalBanner
        pendingApprovals={[commandApproval()]}
        resolvingKeys={new Set()}
        onDecision={onDecision}
      />,
    );

    expect(screen.getByText('Approval needed')).toBeTruthy();
    expect(screen.getByText('Command approval')).toBeTruthy();
    expect(screen.getByText(/Command: open \[link\]/)).toBeTruthy();
    expect(screen.getByText(/--user \[email\]/)).toBeTruthy();
    expect(screen.getByText(/--phone \[phone\]/)).toBeTruthy();
    expect(screen.getByText(/--token \[token\]/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /always allow/i })).toBeFalsy();

    fireEvent.click(screen.getByRole('button', { name: /allow once/i }));

    expect(onDecision).toHaveBeenCalledWith(expect.objectContaining({ id: 'exec-1', kind: 'exec' }), 'allow-once');
  });

  it('shows the queue count when more than one approval is waiting', () => {
    render(
      <ApprovalBanner
        pendingApprovals={[
          commandApproval({ id: 'exec-1' }),
          commandApproval({ id: 'exec-2' }),
        ]}
        resolvingKeys={new Set()}
        onDecision={vi.fn()}
      />,
    );

    expect(screen.getByText('2 waiting')).toBeTruthy();
  });

  it('shows approval load errors when nothing is pending', () => {
    render(
      <ApprovalBanner
        pendingApprovals={[]}
        resolvingKeys={new Set()}
        error="Could not load approvals."
        onDecision={vi.fn()}
      />,
    );

    expect(screen.getByText('Could not load approvals.')).toBeTruthy();
  });
});
