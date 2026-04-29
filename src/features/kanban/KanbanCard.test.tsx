import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { KanbanCard } from './KanbanCard';
import type { KanbanTask } from './types';

function makeTask(overrides: Partial<KanbanTask> = {}): KanbanTask {
  return {
    id: 'task-1',
    title: 'Swarm task',
    description: 'Work split across agents',
    status: 'todo',
    priority: 'normal',
    createdBy: 'operator',
    createdAt: 1,
    updatedAt: 2,
    version: 1,
    labels: [],
    columnOrder: 0,
    feedback: [],
    ...overrides,
  };
}

describe('KanbanCard', () => {
  it('renders parent swarm summary without opening the drawer', () => {
    render(
      <KanbanCard
        isOverlay
        task={makeTask({
          swarmSummary: {
            sourceKind: 'crm_goal',
            objective: 'Get 20 customers today',
            packetsTotal: 5,
            packetsRunning: 3,
            packetsPassed: 1,
            packetsBlocked: 1,
          },
        })}
        onClick={vi.fn()}
      />,
    );

    expect(screen.getByText('Swarm: 5 packets, 3 running, 1 blocked')).toBeInTheDocument();
  });

  it('renders child packet status and owner', () => {
    render(
      <KanbanCard
        isOverlay
        task={makeTask({
          swarmPacket: {
            packetId: 'crm-copy-001',
            cluster: 'crm',
            ownerAgentId: 'benjamin-scott---outreach-lead',
            checkerAgentId: 'hannah-clark---validation-lead',
            evidencePath: '/tmp/crm-copy-001.md',
            stopCondition: 'Stop after copy is written.',
            dod: 'Copy is ready.',
            packetStatus: 'running',
            dedupeKey: 'parent:crm-copy-001',
          },
        })}
        onClick={vi.fn()}
      />,
    );

    expect(screen.getByText('crm')).toBeInTheDocument();
    expect(screen.getByText('running')).toBeInTheDocument();
    expect(screen.getByText('benjamin-scott---outreach-lead')).toBeInTheDocument();
  });
});
