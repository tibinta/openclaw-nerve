import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TokenUsage } from './TokenUsage';

vi.mock('./useLimits', () => ({
  useLimits: () => ({
    codexLimits: {
      available: true,
      five_hour_limit: { used_percent: 100, left_percent: 0, resets_at: null, resets_at_formatted: null },
      weekly_limit: { used_percent: 85, left_percent: 15, resets_at: null, resets_at_formatted: null },
      rotation: {
        available: false,
        blocker: 'No saved Codex profiles found',
        nextAction: 'Create ~/.codex/profiles.json or ~/.codex/profiles/*.json, then save each account once.',
        profileCount: 0,
      },
    },
    claudeLimits: null,
    codexLastChecked: Date.now(),
    claudeLastChecked: null,
  }),
}));

describe('TokenUsage', () => {
  it('shows active Codex account rotation status and blocker', () => {
    render(<TokenUsage data={{ entries: [], totalCost: 0 }} />);

    expect(screen.getAllByText(/^Codex account$/i)).toHaveLength(1);
    expect(screen.getByText(/^Codex accounts$/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Profiles missing/i)).not.toHaveLength(0);
    expect(screen.getAllByText(/No saved Codex profiles found/i)).toHaveLength(3);
    expect(screen.getAllByText(/Create ~\/\.codex\/profiles\.json/i)).toHaveLength(3);
    expect(screen.getByTitle('Save current login as Alex')).toBeInTheDocument();
    expect(screen.getByTitle('Save current login as ONYCHUK')).toBeInTheDocument();
    expect(screen.getByTitle('Save current login as Tiberia')).toBeInTheDocument();
    expect(screen.getByTitle('Save current login as nadella.tb@gmail.com')).toBeInTheDocument();
    expect(screen.getAllByText(/capture/i)).not.toHaveLength(0);
  });
});
