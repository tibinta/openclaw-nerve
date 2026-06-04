import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CronsTab } from './CronsTab';

const mockUseCrons = vi.fn(() => ({
  jobs: [],
  isLoading: false,
  error: null,
  cronWarning: null,
  fetchJobs: vi.fn(),
  toggleJob: vi.fn(),
  runJob: vi.fn(),
  fetchRuns: vi.fn(),
  addJob: vi.fn(),
  updateJob: vi.fn(),
  deleteJob: vi.fn(),
}));

vi.mock('../hooks/useCrons', () => ({
  useCrons: () => mockUseCrons(),
  CRON_GATEWAY_TOOL_ALLOWLIST: ['cron', 'gateway', 'sessions_spawn'],
}));

vi.mock('./CronDialog', () => ({
  CronDialog: () => null,
}));

vi.mock('@/contexts/SessionContext', () => ({
  useSessionContext: () => ({ refreshSessions: vi.fn() }),
}));

describe('CronsTab', () => {
  it('shows a structured remediation state when cron is unavailable on the gateway', () => {
    mockUseCrons.mockReturnValue({
      jobs: [],
      isLoading: false,
      error: 'Gateway tool invoke failed: 404 {"ok":false,"error":{"type":"not_found","message":"Tool not available: cron"}}',
      cronWarning: 'This gateway does not expose cron management, so Nerve can’t load or edit crons right now.',
      fetchJobs: vi.fn(),
      toggleJob: vi.fn(),
      runJob: vi.fn(),
      fetchRuns: vi.fn(),
      addJob: vi.fn(),
      updateJob: vi.fn(),
      deleteJob: vi.fn(),
    });

    render(<CronsTab />);

    expect(screen.getByText(/cron unavailable/i)).toBeInTheDocument();
    expect(screen.getByText(/openclaw config/i)).toBeInTheDocument();
    expect(screen.getAllByText(/openclaw\.json/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/gateway\.tools\.allow/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/sessions_spawn/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/local install shortcut/i)).toBeInTheDocument();
    expect(screen.queryByText(/no scheduled tasks yet/i)).not.toBeInTheDocument();
  });

  it('shows live and disabled jobs in separate groups', () => {
    mockUseCrons.mockReturnValue({
      jobs: [
        {
          id: 'live-1',
          name: 'Morning digest',
          enabled: true,
          scheduleKind: 'every',
          everyMs: 300000,
          payloadKind: 'agentTurn',
          message: 'Check inbox',
        },
        {
          id: 'off-1',
          name: 'Nightly summary',
          enabled: false,
          scheduleKind: 'every',
          everyMs: 86400000,
          payloadKind: 'systemEvent',
          message: 'Send summary',
        },
      ],
      isLoading: false,
      error: null,
      cronWarning: null,
      fetchJobs: vi.fn(),
      toggleJob: vi.fn(),
      runJob: vi.fn(),
      fetchRuns: vi.fn(),
      addJob: vi.fn(),
      updateJob: vi.fn(),
      deleteJob: vi.fn(),
    });

    render(<CronsTab />);

    expect(screen.getAllByText('Live').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Off').length).toBeGreaterThan(0);
    expect(screen.getByText('Morning digest')).toBeInTheDocument();
    expect(screen.getByText('Nightly summary')).toBeInTheDocument();
  });
});
