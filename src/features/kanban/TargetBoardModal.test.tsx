import '@testing-library/jest-dom';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TargetBoardModal } from './TargetBoardModal';

describe('TargetBoardModal', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads target metrics from split markdown sections', async () => {
    const indexContent = `# Target Board Sections

## Sections
- cash-map.md
- actions-dashboard.md
`;
    const cashContent = `# Cash Position

## Today’s cash position
- Cash available: ~£200
- Car fund: £0
`;
    const actionsContent = `# Actions

## Auto-Coach Rules
- If activity is below target, Jane creates a growth packet bundle.

## Next Actions
1. Confirm live CRM source and stream endpoints.
`;

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, content: indexContent }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, content: cashContent }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, content: actionsContent }), { status: 200 }));

    vi.stubGlobal('fetch', fetchMock);

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
      expect(screen.getByText('Source: target-board/index.md')).toBeInTheDocument();
    });

    expect(screen.getAllByText('Cash available').length).toBeGreaterThan(0);
    expect(screen.getByText('~£200')).toBeInTheDocument();
    expect(screen.getByText('If activity is below target, Jane creates a growth packet bundle.')).toBeInTheDocument();
    expect(screen.getAllByText('Confirm live CRM source and stream endpoints.').length).toBe(2);
    expect(screen.getByText('Active target task')).toBeInTheDocument();
    expect(screen.getByText('7 board items visible, reused from the existing task state.')).toBeInTheDocument();

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('/api/files/read?path=target-board%2Fcash-map.md&agentId=main'),
      expect.any(Object),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('/api/files/read?path=target-board%2Factions-dashboard.md&agentId=main'),
      expect.any(Object),
    );
  });

  it('falls back to legacy note if split target sections fail', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('not-json', { status: 500 })));

    render(
      <TargetBoardModal
        open
        onClose={vi.fn()}
        currentActiveTask={null}
        taskCount={2}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Source: safe fallback')).toBeInTheDocument();
    });

    expect(screen.getByText('Lead universe')).toBeInTheDocument();
    expect(screen.getByText('11%')).toBeInTheDocument();
  });
});
