import '@testing-library/jest-dom';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TargetBoardModal } from './TargetBoardModal';

describe('TargetBoardModal', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads target and auto-coach context from the target board markdown note', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      content: `# Target Board Live Note

## Revenue Model
- Lead universe: 50,000 leads
- Daily throughput: 250/day
- Outreach target: 1,600 reachouts/day
- New leads processed: 200/day
- Funnel: 8-step conversion
- Conversion rate: 11%
- Software value input: £75
- Revenue target: £300,000
- Monthly recurring scale target: 4,000 clients

## Auto-Coach Rules
- If activity is below target, Jane creates a growth packet bundle.
- If CRM data is missing, Jane creates a data-source blocker instead of guessing.

## Next Actions
1. Confirm live CRM source and stream endpoints.
`,
    }), { status: 200 })));

    render(
      <TargetBoardModal
        open
        onClose={vi.fn()}
        currentActiveTask={{ id: '1', title: 'Active target task', status: 'in-progress', priority: 'high', createdBy: 'operator', createdAt: 1, updatedAt: 1, version: 1, labels: [], columnOrder: 0, feedback: [] }}
        taskCount={7}
      />,
    );

    expect(screen.getByText('Coach the work')).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText('Source: target-board-live-note.md')).toBeInTheDocument();
    });

    expect(screen.getAllByText('50,000 leads').length).toBeGreaterThan(0);
    expect(screen.getByText('If activity is below target, Jane creates a growth packet bundle.')).toBeInTheDocument();
    expect(screen.getByText('Confirm live CRM source and stream endpoints.')).toBeInTheDocument();
    expect(screen.getByText('Active target task')).toBeInTheDocument();
    expect(screen.getByText('7 board items visible, reused from the existing task state.')).toBeInTheDocument();
  });
});
