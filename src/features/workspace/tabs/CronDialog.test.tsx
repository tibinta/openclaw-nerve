import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

  it('edits command job details without changing its payload or routing', async () => {
    const onSubmit = vi.fn(async () => true);
    const payload = {
      kind: 'command', argv: ['python3', 'scripts/openclaw_work_runner.py'],
      env: { PYTHONUNBUFFERED: '1' },
      cwd: '/Users/alexnedelea/.openclaw', noOutputTimeoutSeconds: 120,
      outputMaxBytes: 8192, timeoutSeconds: 900,
    };
    render(<CronDialog open mode="edit" initialData={{
      id: '2a8997bb-df41-46b9-9de6-2df636a11150', name: 'OpenClaw Work Runner', enabled: false,
      agentId: 'main', scheduleKind: 'every', everyMs: 900000, payloadKind: 'command', message: '',
      sessionTarget: 'isolated', delivery: { mode: 'none' },
      raw: {
        id: '2a8997bb-df41-46b9-9de6-2df636a11150', agentId: 'main', enabled: false,
        schedule: { kind: 'every', everyMs: 900000, anchorMs: 1781766298433 },
        sessionTarget: 'isolated', payload, delivery: { mode: 'none' },
        timeoutSeconds: 900,
      },
    }} onClose={vi.fn()} onSubmit={onSubmit} />);

    expect(screen.getByText('Saved command task')).toBeInTheDocument();
    expect(screen.queryByLabelText('Session')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('What should run?')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Agent ID')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Description')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Name * required'), { target: { value: 'Work Runner' } });
    fireEvent.change(screen.getByLabelText('Every *'), { target: { value: '20' } });
    fireEvent.click(screen.getByLabelText('Enabled'));
    await act(async () => fireEvent.click(screen.getByText('Save Changes')));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    const saved = onSubmit.mock.calls[0]?.[0];
    expect(saved).toEqual(expect.objectContaining({
      name: 'Work Runner', enabled: true,
      schedule: { kind: 'every', everyMs: 1200000, anchorMs: 1781766298433 },
      sessionTarget: 'isolated', agentId: 'main', payload,
      delivery: { mode: 'none' }, timeoutSeconds: 900,
    }));
    expect(saved).not.toHaveProperty('sessionKey');
  });
});
