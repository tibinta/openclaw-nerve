import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CronDialog } from './CronDialog';
import type { CronJob } from '../hooks/useCrons';

vi.mock('@/contexts/SessionContext', () => ({
  useSessionContext: () => ({ agentName: 'Jane' }),
}));

describe('CronDialog persistent session routing', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ models: [], channels: [] }) })));
    HTMLDialogElement.prototype.showModal = vi.fn();
    HTMLDialogElement.prototype.close = vi.fn();
  });

  it('keeps Jane Live routing, agent turn, and schedule anchor when saving', async () => {
    const onSubmit = vi.fn(async () => true);
    const initialData: CronJob = {
      id: 'cron-1', name: 'Something nice', enabled: true,
      agentId: 'main', scheduleKind: 'every', everyMs: 1800000,
      payloadKind: 'agentTurn', message: 'Tell me something nice.',
      sessionTarget: 'session:agent:main:voice:direct:nerve-live',
      delivery: { mode: 'none' },
      raw: {
        schedule: { kind: 'every', everyMs: 1800000, anchorMs: 1790291449594 },
        payload: { kind: 'agentTurn', message: 'Tell me something nice.', toolsAllow: ['*'] },
      },
    };
    render(<CronDialog open mode="edit" initialData={initialData} onClose={vi.fn()} onSubmit={onSubmit} />);
    expect((screen.getByLabelText('Session') as HTMLSelectElement).value)
      .toBe('session:agent:main:voice:direct:nerve-live');
    expect(screen.getByText('Jane Live')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Save Changes'));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(onSubmit.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      sessionTarget: 'session:agent:main:voice:direct:nerve-live',
      payload: { kind: 'agentTurn', message: 'Tell me something nice.', toolsAllow: ['*'] },
      schedule: { kind: 'every', everyMs: 1800000, anchorMs: 1790291449594 },
      sessionKey: undefined,
    }));
  });
});
