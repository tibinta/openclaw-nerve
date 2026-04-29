import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskDetailDrawer } from './TaskDetailDrawer';
import type { KanbanTask } from './types';

const mockUseSessionContext = vi.fn();

vi.mock('@/contexts/SessionContext', () => ({
  useSessionContext: () => mockUseSessionContext(),
}));

function makeTask(overrides: Partial<KanbanTask> = {}): KanbanTask {
  return {
    id: 'task-1',
    title: 'Existing task',
    description: 'Hello',
    status: 'todo',
    priority: 'normal',
    createdBy: 'operator',
    createdAt: 1,
    updatedAt: 2,
    version: 3,
    assignee: 'agent:designer',
    labels: ['frontend'],
    columnOrder: 0,
    feedback: [],
    ...overrides,
  };
}

function renderDrawer(task: KanbanTask | null, onUpdate = vi.fn(async () => task as KanbanTask)) {
  const onDelete = vi.fn(async () => {});
  const onClose = vi.fn();
  render(
    <TaskDetailDrawer
      task={task}
      onClose={onClose}
      onUpdate={onUpdate}
      onDelete={onDelete}
    />,
  );
  return { onUpdate, onDelete, onClose };
}

describe('TaskDetailDrawer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
    mockUseSessionContext.mockReturnValue({
      sessions: [
        { sessionKey: 'agent:designer:main', label: 'Designer' },
        { sessionKey: 'agent:reviewer:main', label: 'Reviewer' },
      ],
      agentName: 'Kim',
    });
  });

  it('shows the friendly current assignee label when the task assignee is active', () => {
    renderDrawer(makeTask({ assignee: 'agent:designer' }));

    expect(screen.getByRole('combobox', { name: 'Assignee' })).toHaveValue('Designer');
  });

  it('does not render the assignee combobox inside an extra input-styled shell', () => {
    renderDrawer(makeTask({ assignee: 'agent:designer' }));

    const combobox = screen.getByRole('combobox', { name: 'Assignee' });
    expect(combobox.parentElement).not.toHaveClass('cockpit-input');
  });

  it('shows a disabled stale-current option when the current assignee is no longer active', async () => {
    const user = userEvent.setup();
    renderDrawer(makeTask({ assignee: 'agent:ghost-reviewer' }));

    await user.click(screen.getByRole('combobox', { name: 'Assignee' }));

    const staleOption = await screen.findByRole('option', { name: /ghost reviewer.*inactive/i });
    expect(staleOption).toHaveAttribute('aria-disabled', 'true');
  });

  it('saves assignee as null when Unassigned is selected', async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn(async () => makeTask({ assignee: undefined }));
    renderDrawer(makeTask({ assignee: 'agent:designer' }), onUpdate);

    await user.click(screen.getByRole('combobox', { name: 'Assignee' }));
    await user.click(await screen.findByRole('option', { name: 'Unassigned' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(onUpdate).toHaveBeenCalledWith('task-1', expect.objectContaining({ assignee: null }));
    });
  });

  it('replaces a stale assignee with an active canonical value on save', async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn(async () => makeTask({ assignee: 'agent:reviewer' }));
    renderDrawer(makeTask({ assignee: 'agent:ghost-reviewer' }), onUpdate);

    await user.click(screen.getByRole('combobox', { name: 'Assignee' }));
    await user.click(await screen.findByRole('option', { name: 'Reviewer' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(onUpdate).toHaveBeenCalledWith('task-1', expect.objectContaining({ assignee: 'agent:reviewer' }));
    });
  });

  it('shows proof fields in the review drawer and lets the user add proof and unlock approve', async () => {
    const user = userEvent.setup();
    const task = makeTask({
      status: 'review',
      delegation_proof: {
        packetId: 'packet://delegation-proof',
        worker: {
          agentId: 'agent:designer',
          sessionKey: 'worker-session',
          verdict: 'pass',
          at: Date.now(),
          summary: 'Worker completed the packet',
        },
        checker: {
          agentId: 'agent:checker',
          sessionKey: 'checker-session',
          verdict: 'pass',
          at: Date.now(),
          summary: 'Checker verified the packet',
        },
        blocker: 'Waiting on final signoff',
      },
      evidence_links: [],
      proof_gate: {
        reindex_verified: false,
        read_back_verified: false,
        live_link_or_canvas_checked: false,
        proof_log_updated: false,
      },
    });
    const updates: Array<Partial<KanbanTask> & { version: number }> = [];
    const approvals: string[] = [];
    const onUpdate = vi.fn(async (_id: string, payload: any) => {
      updates.push(payload);
      return makeTask({
        ...task,
        version: payload.version + 1,
        evidence_links: payload.evidence_links ?? task.evidence_links,
        proof_gate: payload.proof_gate ?? task.proof_gate,
        delegation_proof: payload.delegation_proof ?? task.delegation_proof,
      });
    });
    const onApprove = vi.fn(async (_id: string) => {
      approvals.push(_id);
      return makeTask({ status: 'done', evidence_links: ['https://proof.example'] });
    });

    render(
      <TaskDetailDrawer
        task={task}
        onClose={vi.fn()}
        onUpdate={onUpdate}
        onDelete={vi.fn()}
        onApprove={onApprove}
      />,
    );

    const approveButton = screen.getByRole('button', { name: 'Approve' });
    expect(approveButton).toBeDisabled();
    expect(screen.getByText('Delegation proof')).toBeInTheDocument();
    expect(screen.getByText('Missing proof')).toBeInTheDocument();
    expect(screen.getByText('packet://delegation-proof')).toBeInTheDocument();
    expect(screen.getByText('agent:designer')).toBeInTheDocument();
    expect(screen.getByText('agent:checker')).toBeInTheDocument();
    expect(screen.getByText('Waiting on final signoff')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Proof gate/i })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Proof URL' })).toBeVisible();

    await user.type(screen.getByRole('textbox', { name: 'Proof URL' }), 'https://proof.example');
    await user.click(screen.getByRole('button', { name: 'Add proof' }));

    await waitFor(() => {
      expect(onUpdate).toHaveBeenCalledWith('task-1', expect.objectContaining({
        evidence_links: ['https://proof.example'],
        version: 3,
      }));
    });

    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: 'Proof URL' })).toHaveValue('');
    });

    await user.click(screen.getByRole('checkbox', { name: 'Reindex verified' }));
    await user.click(screen.getByRole('checkbox', { name: 'Read-back verified' }));
    await user.click(screen.getByRole('checkbox', { name: 'Live link/canvas checked' }));
    await user.click(screen.getByRole('checkbox', { name: 'Proof log updated' }));

    await waitFor(() => {
      expect(onUpdate).toHaveBeenCalledWith('task-1', expect.objectContaining({
        proof_gate: expect.objectContaining({
          reindex_verified: true,
          read_back_verified: true,
          live_link_or_canvas_checked: true,
          proof_log_updated: true,
        }),
      }));
    });

    await waitFor(() => {
      expect(screen.getByText('Ready to close')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled();
    });

    expect(screen.getByText('Proof attached')).toBeInTheDocument();
    expect(approvals).toEqual([]);
    expect(updates.length).toBeGreaterThanOrEqual(5);
  });

  it('shows parent swarm summary in the drawer', () => {
    renderDrawer(makeTask({
      status: 'in-progress',
      swarmSummary: {
        sourceKind: 'crm_goal',
        objective: 'Get 20 customers today',
        packetsTotal: 5,
        packetsRunning: 3,
        packetsPassed: 1,
        packetsBlocked: 1,
      },
    }));

    expect(screen.getByText('Swarm')).toBeInTheDocument();
    expect(screen.getByText('Packets')).toBeInTheDocument();
    expect(screen.getByText('Running')).toBeInTheDocument();
    expect(screen.getByText('Passed')).toBeInTheDocument();
    expect(screen.getByText('Blocked')).toBeInTheDocument();
    expect(screen.getByText('Missing proof')).toBeInTheDocument();
  });

  it('shows child packet status, evidence path, session key, and blocker', () => {
    renderDrawer(makeTask({
      status: 'in-progress',
      swarmPacket: {
        packetId: 'crm-copy-001',
        cluster: 'crm',
        ownerAgentId: 'benjamin-scott---outreach-lead',
        checkerAgentId: 'hannah-clark---validation-lead',
        evidencePath: '/Users/alexnedelea/.openclaw/workspace/docs/evidence/crm-copy-001.md',
        stopCondition: 'Stop after copy is written.',
        dod: 'Copy is ready.',
        packetStatus: 'blocked',
        dedupeKey: 'parent:crm-copy-001',
        childSessionKey: 'agent:benjamin-scott---outreach-lead:subagent:crm-copy-001',
        error: 'CRM source unavailable',
      },
    }));

    expect(screen.getByText('crm-copy-001')).toBeInTheDocument();
    expect(screen.getByText('blocked')).toBeInTheDocument();
    expect(screen.getByText('benjamin-scott---outreach-lead')).toBeInTheDocument();
    expect(screen.getByText('hannah-clark---validation-lead')).toBeInTheDocument();
    expect(screen.getByText('/Users/alexnedelea/.openclaw/workspace/docs/evidence/crm-copy-001.md')).toBeInTheDocument();
    expect(screen.getByText('agent:benjamin-scott---outreach-lead:subagent:crm-copy-001')).toBeInTheDocument();
    expect(screen.getByText('CRM source unavailable')).toBeInTheDocument();
  });
});
