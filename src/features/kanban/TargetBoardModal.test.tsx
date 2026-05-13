import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TargetBoardModal } from './TargetBoardModal';

vi.mock('@/features/markdown/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => (
    <div data-testid="markdown-renderer">{content}</div>
  ),
}));

vi.mock('@/features/file-browser/FileEditor', () => ({
  FileEditor: ({
    file,
    onContentChange,
  }: {
    file: { path: string; content: string };
    onContentChange: (path: string, content: string) => void;
  }) => (
    <textarea
      aria-label="markdown editor"
      value={file.content}
      onChange={(event) => onContentChange(file.path, event.target.value)}
    />
  ),
}));

function buildMarkdown(title: string): string {
  return `# ${title}

## Overview
- ${title} line one
- ${title} line two
`;
}

function createFetchMock(writeCapture?: { body?: unknown }) {
  const docContent = {
    'target-board/full-context.md': buildMarkdown('Full Context'),
    'target-board/index.md': buildMarkdown('Target Board Index'),
    'target-board-live-note.md': buildMarkdown('Live Note'),
    'target-board/actions-dashboard.md': buildMarkdown('Actions Dashboard'),
    'target-board/pipeline.md': buildMarkdown('Pipeline'),
    'target-board/money-map-and-targets.md': buildMarkdown('Money Map and Targets'),
    'target-board/cash-map.md': buildMarkdown('Cash Map'),
    'target-board/debt-pressure.md': buildMarkdown('Debt Pressure'),
    'target-board/monthly-costs.md': buildMarkdown('Monthly Costs'),
    'target-board/revenue-and-mrr.md': buildMarkdown('Revenue and MRR'),
    'target-board/money-wellness.md': buildMarkdown('Money Wellness'),
  } as Record<string, string>;

  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = typeof input === 'string' || input instanceof URL ? input.toString() : input.url;
    const parsedUrl = new URL(requestUrl, 'http://localhost');
    const path = parsedUrl.searchParams.get('path');

    if (init?.method === 'PUT') {
      writeCapture!.body = JSON.parse(String(init.body ?? '{}'));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    if (!path || !(path in docContent)) {
      return new Response(JSON.stringify({ ok: false, error: `Missing ${path ?? 'path'}` }), { status: 404 });
    }

    return new Response(JSON.stringify({ ok: true, content: docContent[path], mtime: 1_716_000_000_000 }), {
      status: 200,
    });
  });
}

describe('TargetBoardModal', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function openDashboardFromFullContext() {
    await waitFor(() => {
      const fullContextCard = screen.getAllByRole('button').find((button) => (
        button.textContent?.includes('Full Context')
        && button.textContent?.includes('target-board/full-context.md')
      ));
      expect(fullContextCard).toBeTruthy();
    });

    const fullContextCard = screen.getAllByRole('button').find((button) => (
      button.textContent?.includes('Full Context')
      && button.textContent?.includes('target-board/full-context.md')
    ));
    expect(fullContextCard).toBeTruthy();
    fireEvent.doubleClick(fullContextCard as HTMLElement);

    await waitFor(() => {
      const dashboardToggle = screen.getAllByRole('button', { name: 'Dashboard' }).find((button) => button.getAttribute('aria-pressed') === 'true');
      expect(dashboardToggle).toBeTruthy();
    });
    expect(screen.queryByRole('textbox', { name: 'markdown editor' })).not.toBeInTheDocument();
  }

  it('renders a full-screen dashboard first and then opens the editor', async () => {
    vi.stubGlobal('fetch', createFetchMock());

    render(
      <TargetBoardModal
        open
        onClose={vi.fn()}
        currentActiveTask={{ id: '1', title: 'Active target task', status: 'in-progress', priority: 'high', createdBy: 'operator', createdAt: 1, updatedAt: 1, version: 1, labels: [], columnOrder: 0, feedback: [] }}
        taskCount={7}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Open full context' })).toBeInTheDocument();
    });

    expect(screen.getByText('Coach the work')).toBeInTheDocument();
    expect(screen.getByText('Open full context')).toBeInTheDocument();
    expect(screen.getByText('Execution')).toBeInTheDocument();
    expect(screen.getByText('Finance')).toBeInTheDocument();

    await openDashboardFromFullContext();

    const editToggle = screen.getAllByRole('button', { name: 'Edit' }).find((button) => button.getAttribute('aria-pressed') === 'false');
    expect(editToggle).toBeTruthy();
    fireEvent.click(editToggle as HTMLElement);

    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: 'markdown editor' })).toBeInTheDocument();
    });

    expect(screen.getByRole('textbox', { name: 'markdown editor' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('saves edits from the fullscreen modal and keeps the board coherent', async () => {
    const writeCapture: { body?: unknown } = {};
    vi.stubGlobal('fetch', createFetchMock(writeCapture));

    render(
      <TargetBoardModal
        open
        onClose={vi.fn()}
        currentActiveTask={null}
        taskCount={2}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Open full context' })).toBeInTheDocument();
    });

    await openDashboardFromFullContext();

    const editToggle = screen.getAllByRole('button', { name: 'Edit' }).find((button) => button.getAttribute('aria-pressed') === 'false');
    expect(editToggle).toBeTruthy();
    fireEvent.click(editToggle as HTMLElement);

    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: 'markdown editor' })).toBeInTheDocument();
    });

    fireEvent.change(screen.getByRole('textbox', { name: 'markdown editor' }), {
      target: { value: '# Full Context\n\nUpdated text for the board.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(writeCapture.body).toMatchObject({
        path: 'target-board/full-context.md',
        content: '# Full Context\n\nUpdated text for the board.',
        agentId: 'main',
      });
    });
  });

  it('cancels an edit without writing when the user confirms discard', async () => {
    const writeCapture: { body?: unknown } = {};
    vi.stubGlobal('fetch', createFetchMock(writeCapture));
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(
      <TargetBoardModal
        open
        onClose={vi.fn()}
        currentActiveTask={null}
        taskCount={2}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Open full context' })).toBeInTheDocument();
    });

    await openDashboardFromFullContext();

    const editToggle = screen.getAllByRole('button', { name: 'Edit' }).find((button) => button.getAttribute('aria-pressed') === 'false');
    expect(editToggle).toBeTruthy();
    fireEvent.click(editToggle as HTMLElement);

    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: 'markdown editor' })).toBeInTheDocument();
    });

    fireEvent.change(screen.getByRole('textbox', { name: 'markdown editor' }), {
      target: { value: '# Full Context\n\nDraft text that should be discarded.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => {
      expect(screen.queryByRole('textbox', { name: 'markdown editor' })).not.toBeInTheDocument();
    });

    expect(writeCapture.body).toBeUndefined();
  });
});
