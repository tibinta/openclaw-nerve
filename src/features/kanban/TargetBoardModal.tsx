import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  Clock3,
  FileText,
  Loader2,
  PencilLine,
  RefreshCcw,
  Search,
  Target,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { MarkdownRenderer } from '@/features/markdown/MarkdownRenderer';
import { FileEditor } from '@/features/file-browser/FileEditor';
import type { OpenFile } from '@/features/file-browser/types';
import { cn } from '@/lib/utils';
import type { KanbanTask } from './types';

interface TargetBoardModalProps {
  open: boolean;
  onClose: () => void;
  currentActiveTask: KanbanTask | null;
  taskCount: number;
  onOpenSection?: (path: string) => void | Promise<void>;
}

type DocMode = 'preview' | 'edit';
type DocStatus = 'loading' | 'ready' | 'error';

interface TargetDoc {
  group: 'Overview' | 'Execution' | 'Finance';
  label: string;
  path: string;
  description: string;
  primary?: boolean;
}

interface ParsedHeading {
  depth: number;
  text: string;
  anchor: string;
}

interface LoadedTargetDoc extends TargetDoc {
  status: DocStatus;
  content: string;
  originalContent: string;
  mtime: number | null;
  error: string | null;
  wordCount: number;
  lineCount: number;
  headingCount: number;
  excerpt: string;
  headings: ParsedHeading[];
  lastUpdatedLabel: string;
}

interface TargetModalState {
  path: string;
  mode: DocMode;
  draft: {
    content: string;
    savedContent: string;
    mtime: number | null;
  } | null;
  error: string | null;
  saving: boolean;
}

const AGENT_ID = 'main';
const DEFAULT_SELECTED_PATH = 'target-board/full-context.md';

const TARGET_DOCS: TargetDoc[] = [
  {
    group: 'Overview',
    label: 'Full Context',
    path: 'target-board/full-context.md',
    description: 'Paste the full conversation here so models read the whole thread first.',
    primary: true,
  },
  {
    group: 'Overview',
    label: 'Target Board Index',
    path: 'target-board/index.md',
    description: 'Navigation hub for the split markdown target board.',
  },
  {
    group: 'Overview',
    label: 'Live Note',
    path: 'target-board-live-note.md',
    description: 'Emergency fallback note and active coaching source.',
  },
  {
    group: 'Execution',
    label: 'Actions Dashboard',
    path: 'target-board/actions-dashboard.md',
    description: 'Today’s actions, ownership, and proof checkpoints.',
  },
  {
    group: 'Execution',
    label: 'Pipeline',
    path: 'target-board/pipeline.md',
    description: 'Current opportunities, statuses, and next moves.',
  },
  {
    group: 'Execution',
    label: 'Money Map and Targets',
    path: 'target-board/money-map-and-targets.md',
    description: 'Revenue model, gap map, and target ladder.',
  },
  {
    group: 'Finance',
    label: 'Cash Map',
    path: 'target-board/cash-map.md',
    description: 'Protected cash, car rule, and available spend.',
  },
  {
    group: 'Finance',
    label: 'Debt Pressure',
    path: 'target-board/debt-pressure.md',
    description: 'Hard debt, arrears, and the real pressure total.',
  },
  {
    group: 'Finance',
    label: 'Monthly Costs',
    path: 'target-board/monthly-costs.md',
    description: 'Base monthly outgoings and calm target.',
  },
  {
    group: 'Finance',
    label: 'Revenue and MRR',
    path: 'target-board/revenue-and-mrr.md',
    description: 'Known client revenue, MRR, and the current gap.',
  },
  {
    group: 'Finance',
    label: 'Money Wellness',
    path: 'target-board/money-wellness.md',
    description: 'DMP and Breathing Space guidance for priority debts.',
  },
];

const GROUP_ORDER: TargetDoc['group'][] = ['Overview', 'Execution', 'Finance'];

function baseName(path: string): string {
  return path.split('/').pop() || path;
}

function pluralize(value: number, singular: string, plural = `${singular}s`): string {
  return `${value} ${value === 1 ? singular : plural}`;
}

function formatRelativeTime(mtime: number | null): string {
  if (!mtime) return 'not loaded yet';

  const deltaMs = Date.now() - mtime;
  const deltaMinutes = Math.round(deltaMs / 60000);
  if (Math.abs(deltaMinutes) < 1) return 'just now';
  if (Math.abs(deltaMinutes) < 60) return deltaMinutes > 0 ? `${deltaMinutes}m ago` : `in ${Math.abs(deltaMinutes)}m`;

  const deltaHours = Math.round(deltaMinutes / 60);
  if (Math.abs(deltaHours) < 24) return deltaHours > 0 ? `${deltaHours}h ago` : `in ${Math.abs(deltaHours)}h`;

  const deltaDays = Math.round(deltaHours / 24);
  return deltaDays > 0 ? `${deltaDays}d ago` : `in ${Math.abs(deltaDays)}d`;
}

function slugifyHeading(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '') || 'section';
}

function parseMarkdownDocument(
  content: string,
  mtime: number | null,
): Pick<LoadedTargetDoc, 'wordCount' | 'lineCount' | 'headingCount' | 'excerpt' | 'headings' | 'lastUpdatedLabel'> {
  const lines = content.split(/\r?\n/);
  const wordCount = (content.match(/\S+/g) ?? []).length;
  const headings: ParsedHeading[] = [];

  for (const line of lines) {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    headings.push({
      depth: match[1].length,
      text: match[2].trim(),
      anchor: slugifyHeading(match[2]),
    });
  }

  const excerptSource: string[] = [];
  let seenContent = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (seenContent) break;
      continue;
    }
    if (/^#{1,6}\s+/.test(trimmed)) continue;
    seenContent = true;
    excerptSource.push(trimmed);
    if (excerptSource.join(' ').length >= 200) break;
  }

  const excerpt = excerptSource.length > 0
    ? excerptSource.join(' ').replace(/\s+/g, ' ').slice(0, 220)
    : 'No readable body text yet.';

  return {
    wordCount,
    lineCount: lines.length,
    headingCount: headings.length,
    excerpt,
    headings,
    lastUpdatedLabel: formatRelativeTime(mtime),
  };
}

async function readMarkdownDocument(
  path: string,
  signal?: AbortSignal,
): Promise<{ content: string; mtime: number | null }> {
  const params = new URLSearchParams({ path, agentId: AGENT_ID });
  const res = await fetch(`/api/files/read?${params.toString()}`, { signal });
  const data = await res.json().catch(() => null) as {
    ok?: boolean;
    content?: string;
    mtime?: number;
    error?: string;
  } | null;

  if (!res.ok || !data?.ok || typeof data.content !== 'string') {
    throw new Error(data?.error || `Failed to load ${path}`);
  }

  return {
    content: data.content,
    mtime: typeof data.mtime === 'number' ? data.mtime : null,
  };
}

async function writeMarkdownDocument(
  path: string,
  content: string,
  expectedMtime: number | null,
): Promise<void> {
  const res = await fetch('/api/files/write', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      path,
      content,
      expectedMtime: expectedMtime ?? undefined,
      agentId: AGENT_ID,
    }),
  });

  const data = await res.json().catch(() => null) as { ok?: boolean; error?: string } | null;
  if (!res.ok || !data?.ok) {
    throw new Error(data?.error || `Failed to save ${path}`);
  }
}

function createInitialDocs(): Record<string, LoadedTargetDoc> {
  return Object.fromEntries(TARGET_DOCS.map((doc) => [
    doc.path,
    {
      ...doc,
      status: 'loading' as const,
      content: '',
      originalContent: '',
      mtime: null,
      error: null,
      wordCount: 0,
      lineCount: 0,
      headingCount: 0,
      excerpt: 'Loading document…',
      headings: [],
      lastUpdatedLabel: 'loading',
    },
  ]));
}

function groupDocs(docs: LoadedTargetDoc[]): Array<{ group: TargetDoc['group']; docs: LoadedTargetDoc[] }> {
  return GROUP_ORDER
    .map((group) => ({
      group,
      docs: docs.filter((doc) => doc.group === group),
    }))
    .filter((group) => group.docs.length > 0);
}

function findDocPathBySearch(doc: LoadedTargetDoc, query: string): boolean {
  if (!query.trim()) return true;
  const haystack = [
    doc.label,
    doc.path,
    doc.description,
    doc.excerpt,
    doc.headings.map((heading) => heading.text).join(' '),
    doc.content,
  ].join(' ').toLowerCase();
  return haystack.includes(query.toLowerCase().trim());
}

function metricTile({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: string;
  tone?: 'default' | 'primary' | 'success';
}) {
  return (
    <div className={cn(
      'rounded-2xl border border-border/70 bg-card/50 px-4 py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]',
      tone === 'primary' && 'border-primary/20 bg-primary/6',
      tone === 'success' && 'border-green/20 bg-green/8',
    )}>
      <div className="cockpit-field-label">{label}</div>
      <div className="mt-1 text-[1.05rem] font-semibold tracking-[-0.03em] text-foreground">{value}</div>
    </div>
  );
}

function DocCard({
  doc,
  selected,
  onSelect,
  onOpen,
  onEdit,
}: {
  doc: LoadedTargetDoc;
  selected: boolean;
  onSelect: (path: string) => void;
  onOpen: (path: string, mode?: DocMode) => void;
  onEdit: (path: string) => void;
}) {
  const toneClass = doc.status === 'ready'
    ? 'text-green'
    : doc.status === 'error'
      ? 'text-destructive'
      : 'text-orange';

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelect(doc.path)}
      onDoubleClick={() => onOpen(doc.path, 'preview')}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          onOpen(doc.path, 'preview');
        }
        if (event.key === ' ') {
          event.preventDefault();
          onSelect(doc.path);
        }
      }}
      className={cn(
        'group w-full rounded-[22px] border px-4 py-4 text-left transition-all duration-150 outline-none',
        'border-border/70 bg-card/55 hover:-translate-y-px hover:border-primary/28 hover:bg-card/75',
        selected && 'border-primary/35 bg-primary/8 shadow-[0_16px_36px_rgba(0,0,0,0.16)]',
      )}
      aria-pressed={selected}
    >
      <div className="flex items-start gap-3">
        <span className={cn(
          'mt-0.5 inline-flex size-10 shrink-0 items-center justify-center rounded-2xl border',
          doc.status === 'ready' && 'border-green/20 bg-green/10 text-green',
          doc.status === 'error' && 'border-destructive/20 bg-destructive/10 text-destructive',
          doc.status === 'loading' && 'border-orange/20 bg-orange/10 text-orange',
        )}>
          {doc.status === 'loading' ? <Loader2 size={16} className="animate-spin" /> : <FileText size={16} />}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <div className="truncate text-[0.95rem] font-semibold tracking-[-0.02em] text-foreground">
              {doc.label}
            </div>
            <span className={cn('cockpit-badge', toneClass)} data-tone={doc.status === 'ready' ? 'success' : doc.status === 'error' ? 'danger' : 'warning'}>
              {doc.status}
            </span>
          </div>

          <div className="mt-1 truncate font-mono text-[0.72rem] text-muted-foreground">
            {doc.path}
          </div>

          <p className="mt-2 line-clamp-3 text-[0.833rem] leading-6 text-muted-foreground/90">
            {doc.description}
          </p>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="cockpit-badge" data-tone="primary">{pluralize(doc.wordCount, 'word')}</span>
            <span className="cockpit-badge">{pluralize(doc.headingCount, 'section')}</span>
            <span className="cockpit-badge">{pluralize(doc.lineCount, 'line')}</span>
          </div>

          <div className="mt-3 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-[0.733rem] text-muted-foreground">
              <Clock3 size={12} />
              <span>{doc.lastUpdatedLabel}</span>
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="px-3"
                onClick={(event) => {
                  event.stopPropagation();
                  onOpen(doc.path, 'preview');
                }}
              >
                Open
                <ArrowUpRight size={12} />
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="xs"
                className="px-3"
                onClick={(event) => {
                  event.stopPropagation();
                  onEdit(doc.path);
                }}
              >
                <PencilLine size={12} />
                Edit
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function TargetModal({
  doc,
  open,
  mode,
  draft,
  saving,
  error,
  onOpenChange,
  onModeChange,
  onSave,
  onContentChange,
  onRetry,
  onOpenSection,
}: {
  doc: LoadedTargetDoc | null;
  open: boolean;
  mode: DocMode;
  draft: TargetModalState['draft'];
  saving: boolean;
  error: string | null;
  onOpenChange: (open: boolean) => void;
  onModeChange: (mode: DocMode) => void;
  onSave: (path: string) => Promise<void>;
  onContentChange: (path: string, content: string) => void;
  onRetry: (path: string) => void;
  onOpenSection?: (path: string) => void | Promise<void>;
}) {
  const file = useMemo<OpenFile | null>(() => {
    if (!doc) return null;
    const activeContent = draft?.content ?? doc.content;
    const savedContent = draft?.savedContent ?? doc.originalContent;
    return {
      path: doc.path,
      name: baseName(doc.path),
      content: activeContent,
      savedContent,
      dirty: activeContent !== savedContent,
      locked: false,
      mtime: draft?.mtime ?? doc.mtime ?? Date.now(),
      loading: doc.status === 'loading',
      error: doc.status === 'error' ? doc.error ?? 'Failed to load document' : undefined,
    };
  }, [doc, draft]);

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    if (nextOpen) {
      onOpenChange(true);
      return;
    }

    if (draft && draft.content !== draft.savedContent && !window.confirm('Discard unsaved changes?')) {
      return;
    }

    onOpenChange(false);
  }, [draft, onOpenChange]);

  if (!doc) return null;

  const activeContent = draft?.content ?? doc.content;
  const savedContent = draft?.savedContent ?? doc.originalContent;
  const hasChanges = activeContent !== savedContent;
  const outline = doc.headings.slice(0, 8);
  const previewContent = activeContent.slice(0, 1800);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="fixed left-0 top-0 h-[100dvh] w-[100dvw] max-w-none translate-x-0 translate-y-0 overflow-y-auto overscroll-contain rounded-none border-0 bg-card/96 p-0 shadow-none sm:max-w-none">
        <div className="flex min-h-full flex-col">
          <DialogHeader className="shrink-0 border-b border-border/60 bg-background/85 px-5 py-4 text-left backdrop-blur-md sm:px-6">
            <div className="flex flex-wrap items-start gap-3">
              <div className="min-w-0 flex-1">
                <div className="cockpit-kicker">
                  <span className="text-primary">◆</span>
                  Target doc
                </div>
                <DialogTitle className="mt-1 text-[1.25rem] font-semibold tracking-[-0.03em] text-foreground sm:text-[1.4rem]">
                  {doc.label}
                </DialogTitle>
                <DialogDescription className="mt-1 max-w-[58ch] text-sm leading-6 text-muted-foreground">
                  Full-screen workspace. Save keeps the board live; cancel discards the draft.
                </DialogDescription>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => onOpenSection?.(doc.path)}
                >
                  <ArrowUpRight size={14} />
                  Open in workspace
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => onRetry(doc.path)}
                >
                  <RefreshCcw size={14} />
                  Reload
                </Button>
              </div>
            </div>

            <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-4 2xl:grid-cols-4">
              {metricTile({ label: 'Words', value: pluralize(doc.wordCount, 'word'), tone: 'primary' })}
              {metricTile({ label: 'Sections', value: pluralize(doc.headingCount, 'section') })}
              {metricTile({ label: 'Lines', value: pluralize(doc.lineCount, 'line') })}
              {metricTile({ label: 'Updated', value: doc.lastUpdatedLabel, tone: 'success' })}
            </div>

            <div className="mt-4 inline-flex rounded-2xl border border-border/70 bg-background/55 p-1">
              <button
                type="button"
                aria-pressed={mode === 'preview'}
                onClick={() => onModeChange('preview')}
                className={cn(
                  'inline-flex min-h-9 items-center gap-2 rounded-[10px] px-3 text-[0.733rem] font-medium transition-colors',
                  mode === 'preview' ? 'bg-card text-foreground shadow-[0_10px_30px_rgba(0,0,0,0.12)]' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <CheckCircle2 size={14} />
                Dashboard
              </button>
              <button
                type="button"
                aria-pressed={mode === 'edit'}
                onClick={() => onModeChange('edit')}
                className={cn(
                  'inline-flex min-h-9 items-center gap-2 rounded-[10px] px-3 text-[0.733rem] font-medium transition-colors',
                  mode === 'edit' ? 'bg-card text-foreground shadow-[0_10px_30px_rgba(0,0,0,0.12)]' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <PencilLine size={14} />
                Edit
              </button>
            </div>
          </DialogHeader>

          <div className="grid min-h-0 flex-1 gap-0 lg:grid-cols-[17rem_minmax(0,1fr)] 2xl:grid-cols-[17rem_minmax(0,1fr)_20rem]">
            <aside className="min-h-0 border-b border-border/60 bg-background/45 lg:border-b-0 lg:border-r lg:border-border/60">
              <div className="flex items-center justify-between gap-3 border-b border-border/60 px-5 py-3 sm:px-6">
                <div className="flex items-center gap-2">
                  <span className={cn('cockpit-badge', hasChanges ? 'text-orange' : 'text-green')} data-tone={hasChanges ? 'warning' : 'success'}>
                    {saving ? 'Saving…' : hasChanges ? 'Draft changes' : 'Saved'}
                  </span>
                </div>
                <div className="text-[0.733rem] text-muted-foreground">
                  {mode === 'edit' ? 'Editor open' : 'Dashboard open'}
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-6">
                <div className="cockpit-note">
                  <div className="cockpit-field-label">Doc facts</div>
                  <div className="mt-2 space-y-2 text-[0.833rem] text-muted-foreground">
                    <div className="flex items-center justify-between gap-3">
                      <span>Group</span>
                      <span className="font-medium text-foreground">{doc.group}</span>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <span>File</span>
                      <span className="font-mono text-[0.72rem] text-foreground">{baseName(doc.path)}</span>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <span>Path</span>
                      <span className="max-w-[10rem] truncate font-mono text-[0.72rem] text-foreground">{doc.path}</span>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <span>Updated</span>
                      <span className="text-foreground">{doc.lastUpdatedLabel}</span>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <span>Mode</span>
                      <span className="text-foreground">{mode === 'edit' ? 'Editing' : 'Reviewing'}</span>
                    </div>
                  </div>
                </div>

                {error && (
                  <div className="cockpit-note mt-4 border-dashed" data-tone="danger">
                    {error}
                  </div>
                )}

                <div className="mt-4 grid gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => onOpenSection?.(doc.path)}
                  >
                    <ArrowUpRight size={14} />
                    Open in workspace
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => onRetry(doc.path)}
                  >
                    <RefreshCcw size={14} />
                    Reload
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => onModeChange(mode === 'edit' ? 'preview' : 'edit')}
                  >
                    <PencilLine size={14} />
                    {mode === 'edit' ? 'Dashboard' : 'Edit'}
                  </Button>
                </div>

                <div className="mt-4 cockpit-note">
                  <div className="cockpit-field-label">Quick read</div>
                  <p className="mt-2 text-[0.833rem] leading-6 text-foreground/80">
                    {doc.excerpt}
                  </p>
                </div>

                <div className="mt-4 cockpit-note">
                  <div className="cockpit-field-label">Trackable cues</div>
                  <div className="mt-2 space-y-2 text-[0.8rem] leading-6 text-muted-foreground">
                    <div>{pluralize(doc.wordCount, 'word')}</div>
                    <div>{pluralize(doc.headingCount, 'section')}</div>
                    <div>{pluralize(doc.lineCount, 'line')}</div>
                  </div>
                </div>
              </div>
            </aside>

            <main className="min-h-0 border-b border-border/60 lg:border-b-0 lg:border-r lg:border-border/60">
              <div className="flex items-center justify-between gap-3 border-b border-border/60 px-5 py-3 sm:px-6">
                <div className="flex items-center gap-2">
                  <span className={cn('cockpit-badge', hasChanges ? 'text-orange' : 'text-green')} data-tone={hasChanges ? 'warning' : 'success'}>
                    {saving ? 'Saving…' : hasChanges ? 'Draft changes' : 'Saved'}
                  </span>
                  <span className="font-mono text-[0.72rem] text-muted-foreground">{doc.path}</span>
                </div>

                <div className="text-[0.733rem] text-muted-foreground">
                  {mode === 'edit' ? 'Editor open' : 'Dashboard open'}
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-6">
                {doc.status === 'loading' ? (
                  <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
                    <Loader2 size={16} className="animate-spin" />
                    Loading document…
                  </div>
                ) : doc.status === 'error' ? (
                  <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-muted-foreground">
                    <AlertTriangle size={28} className="text-destructive" />
                    <div className="text-sm">
                      Failed to load <span className="font-mono text-foreground">{doc.path}</span>
                    </div>
                    <div className="text-xs">{doc.error}</div>
                    <Button type="button" variant="outline" size="sm" onClick={() => onRetry(doc.path)}>
                      <RefreshCcw size={14} />
                      Retry
                    </Button>
                  </div>
                ) : mode === 'edit' && file ? (
                  <div className="h-full min-h-[48rem] rounded-[26px] border border-border/60 bg-background/55 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
                    <div className="mb-3 flex items-center justify-between gap-2">
                      <div>
                        <div className="cockpit-field-label">Editor</div>
                        <p className="mt-1 text-[0.733rem] text-muted-foreground">
                          Edit the full markdown file, then save or cancel.
                        </p>
                      </div>
                      <span className="cockpit-badge" data-tone="primary">Markdown</span>
                    </div>
                    <FileEditor
                      file={file}
                      onContentChange={onContentChange}
                      onSave={onSave}
                      onRetry={onRetry}
                    />
                  </div>
                ) : (
                  <div className="min-h-0 rounded-[26px] border border-border/60 bg-background/55 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
                    <div className="mb-3 flex items-center justify-between gap-2">
                      <div>
                        <div className="cockpit-field-label">Dashboard preview</div>
                        <p className="mt-1 text-[0.733rem] text-muted-foreground">
                          Read the file first. Switch to Edit when you need to change it.
                        </p>
                      </div>
                      <span className="cockpit-badge" data-tone="primary">Dashboard</span>
                    </div>

                    <div className="rounded-[22px] border border-border/60 bg-background/45 p-4">
                      <MarkdownRenderer
                        content={activeContent}
                        className="markdown-document-content"
                        currentDocumentPath={doc.path}
                        onOpenWorkspacePath={(targetPath) => onOpenSection?.(targetPath)}
                      />
                    </div>

                    {activeContent.trim().length === 0 && (
                      <div className="cockpit-note mt-4">
                        This file is empty right now. Double-click the card or hit Edit to start the draft.
                      </div>
                    )}

                    {outline.length > 0 && (
                      <div className="mt-6 grid gap-3 lg:grid-cols-[minmax(0,1fr)_19rem]">
                        <div className="cockpit-note">
                          <div className="cockpit-field-label">Source</div>
                          <p className="mt-2 text-[0.833rem] leading-6 text-foreground/80">
                            {doc.description}
                          </p>
                        </div>

                        <div className="cockpit-note">
                          <div className="cockpit-field-label">Outline</div>
                          <ul className="mt-2 space-y-1.5">
                            {outline.map((heading) => (
                              <li
                                key={`${heading.anchor}-${heading.text}`}
                                className={cn(
                                  'truncate text-[0.8rem] leading-5 text-muted-foreground',
                                  heading.depth <= 2 && 'text-foreground/88',
                                )}
                              >
                                <span className="mr-2 font-mono text-[0.667rem] text-muted-foreground/70">
                                  {heading.depth === 1 ? 'H1' : heading.depth === 2 ? 'H2' : `H${heading.depth}`}
                                </span>
                                {heading.text}
                              </li>
                            ))}
                          </ul>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </main>

            <aside className="flex min-h-0 flex-col bg-background/30 2xl:border-l 2xl:border-border/60">
              <div className="border-b border-border/60 px-5 py-4 sm:px-6">
                <div className="cockpit-field-label">Live preview</div>
                <p className="mt-1 text-[0.733rem] text-muted-foreground">
                  A compact readout of the current markdown.
                </p>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 sm:px-6">
                <div className="rounded-[22px] border border-border/70 bg-card/55 p-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <span className="text-[0.733rem] text-muted-foreground">
                      {mode === 'edit' ? 'Draft snapshot' : 'Saved snapshot'}
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      className="px-3"
                      onClick={() => onModeChange('edit')}
                    >
                      <PencilLine size={12} />
                      Edit
                    </Button>
                  </div>

                  <div className="max-h-[calc(100dvh-22rem)] overflow-y-auto rounded-2xl border border-border/60 bg-background/40 p-3">
                    <MarkdownRenderer
                      content={previewContent}
                      className="markdown-document-content"
                      currentDocumentPath={doc.path}
                      onOpenWorkspacePath={(targetPath) => onOpenSection?.(targetPath)}
                    />
                  </div>
                </div>

                <div className="cockpit-note mt-4">
                  <div className="cockpit-field-label">Why this works</div>
                  <p className="mt-2 text-[0.833rem] leading-6 text-foreground/80">
                    The board stays visible, the editor stays central, and the context stays split into readable lanes.
                  </p>
                </div>
              </div>
            </aside>
          </div>

          <DialogFooter className="shrink-0 border-t border-border/60 bg-background/90 px-5 py-4 backdrop-blur-md sm:px-6">
            <div className="flex w-full flex-col-reverse gap-2 sm:flex-row sm:justify-between">
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    if (hasChanges && !window.confirm('Discard unsaved changes?')) return;
                    onOpenChange(false);
                  }}
                >
                  Cancel
                </Button>
                <span className="hidden text-[0.733rem] text-muted-foreground sm:inline">
                  Double-click the card to open dashboard mode, then switch to edit when ready.
                </span>
              </div>

              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="default"
                  onClick={() => onSave(doc.path)}
                  disabled={!hasChanges || doc.status !== 'ready' || saving}
                >
                  {saving ? (
                    <>
                      <Loader2 size={14} className="animate-spin" />
                      Saving
                    </>
                  ) : (
                    <>
                      <CheckCircle2 size={14} />
                      Save
                    </>
                  )}
                </Button>
              </div>
            </div>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export const TargetBoardModal = memo(function TargetBoardModal({
  open,
  onClose,
  currentActiveTask,
  taskCount,
  onOpenSection,
}: TargetBoardModalProps) {
  const [docs, setDocs] = useState<Record<string, LoadedTargetDoc>>(() => createInitialDocs());
  const [selectedPath, setSelectedPath] = useState(DEFAULT_SELECTED_PATH);
  const [search, setSearch] = useState('');
  const [refreshTick, setRefreshTick] = useState(0);
  const [modalState, setModalState] = useState<TargetModalState | null>(null);
  const requestIdRef = useRef(0);
  const isMountedRef = useRef(true);

  useEffect(() => () => {
    isMountedRef.current = false;
  }, []);

  const selectedDoc = docs[selectedPath] ?? docs[DEFAULT_SELECTED_PATH] ?? null;

  const reloadAllDocs = useCallback(() => {
    setRefreshTick((value) => value + 1);
  }, []);

  useEffect(() => {
    if (!open) return;

    const controller = new AbortController();
    requestIdRef.current += 1;
    const requestId = requestIdRef.current;
    const nextDocs = createInitialDocs();
    setDocs(nextDocs);
    setSelectedPath(DEFAULT_SELECTED_PATH);

    const docList = TARGET_DOCS.map((doc) => doc.path);

    void Promise.all(docList.map(async (path) => {
      try {
        const loaded = await readMarkdownDocument(path, controller.signal);
        if (controller.signal.aborted || requestIdRef.current !== requestId) return;
        const parsed = parseMarkdownDocument(loaded.content, loaded.mtime);
        setDocs((prev) => ({
          ...prev,
          [path]: {
            ...(prev[path] ?? nextDocs[path]),
            status: 'ready',
            content: loaded.content,
            originalContent: loaded.content,
            mtime: loaded.mtime,
            error: null,
            ...parsed,
          },
        }));
      } catch (error) {
        if (controller.signal.aborted || requestIdRef.current !== requestId) return;
        const message = error instanceof Error ? error.message : `Failed to load ${path}`;
        setDocs((prev) => ({
          ...prev,
          [path]: {
            ...(prev[path] ?? nextDocs[path]),
            status: 'error',
            error: message,
            excerpt: 'This document could not be loaded.',
          },
        }));
      }
    }));

    return () => controller.abort();
  }, [open, refreshTick]);

  useEffect(() => {
    if (!modalState) return;
    const currentDoc = docs[modalState.path];
    if (!currentDoc) return;

    const draft = modalState.draft;
    if (draft && draft.content !== draft.savedContent) {
      return;
    }

    if (
      draft
      && draft.content === currentDoc.content
      && draft.savedContent === currentDoc.originalContent
      && draft.mtime === currentDoc.mtime
    ) {
      return;
    }

    setModalState((current) => {
      if (!current || current.path !== currentDoc.path) return current;
      return {
        ...current,
        draft: {
          content: currentDoc.content,
          savedContent: currentDoc.originalContent,
          mtime: currentDoc.mtime,
        },
        error: null,
      };
    });
  }, [docs, modalState]);

  const availableDocs = useMemo(() => (
    TARGET_DOCS.map((doc) => docs[doc.path]).filter(Boolean) as LoadedTargetDoc[]
  ), [docs]);

  const filteredDocs = useMemo(() => (
    availableDocs.filter((doc) => findDocPathBySearch(doc, search))
  ), [availableDocs, search]);

  const groupedDocs = useMemo(() => groupDocs(filteredDocs), [filteredDocs]);

  const selectedVisibleDoc = filteredDocs.find((doc) => doc.path === selectedPath)
    ?? selectedDoc
    ?? availableDocs[0]
    ?? null;

  const readyDocs = availableDocs.filter((doc) => doc.status === 'ready');
  const totalWords = readyDocs.reduce((total, doc) => total + doc.wordCount, 0);
  const totalSections = readyDocs.reduce((total, doc) => total + doc.headingCount, 0);
  const loadedCount = availableDocs.filter((doc) => doc.status === 'ready').length;

  const openModal = useCallback((path: string, mode: DocMode = 'preview') => {
    const doc = docs[path];
    if (!doc) return;

    setSelectedPath(path);
    setModalState({
      path,
      mode,
      draft: doc.status === 'ready'
        ? {
            content: doc.content,
            savedContent: doc.originalContent,
            mtime: doc.mtime,
          }
        : null,
      error: doc.status === 'error' ? doc.error : null,
      saving: false,
    });
  }, [docs]);

  const handleModalContentChange = useCallback((path: string, content: string) => {
    setModalState((current) => {
      if (!current || current.path !== path || !current.draft) return current;
      return {
        ...current,
        draft: {
          ...current.draft,
          content,
        },
      };
    });
  }, []);

  const handleModalSave = useCallback(async (path: string) => {
    const current = modalState;
    if (!current || current.path !== path || !current.draft || current.saving) return;
    const draft = current.draft;

    setModalState((prev) => (prev ? { ...prev, saving: true, error: null } : prev));

    try {
      await writeMarkdownDocument(path, draft.content, draft.mtime);
      const savedAt = Date.now();

      setDocs((prev) => {
        const existing = prev[path];
        if (!existing) return prev;
        const parsed = parseMarkdownDocument(draft.content ?? existing.content, savedAt);
        return {
          ...prev,
          [path]: {
            ...existing,
            status: 'ready',
            content: draft.content ?? existing.content,
            originalContent: draft.content ?? existing.originalContent,
            mtime: savedAt,
            error: null,
            ...parsed,
          },
        };
      });

      setModalState((prev) => (prev && prev.path === path
        ? {
            ...prev,
            mode: 'preview',
            saving: false,
            draft: {
              content: draft.content,
              savedContent: draft.content,
              mtime: savedAt,
            },
            error: null,
          }
        : prev));
    } catch (saveError) {
      const message = saveError instanceof Error ? saveError.message : `Failed to save ${path}`;
      setModalState((prev) => (prev ? { ...prev, saving: false, error: message } : prev));
    }
  }, [modalState]);

  const handleModalRetry = useCallback((path: string) => {
    void readMarkdownDocument(path).then((loaded) => {
      const parsed = parseMarkdownDocument(loaded.content, loaded.mtime);
      setDocs((prev) => {
        const existing = prev[path];
        if (!existing) return prev;
        return {
          ...prev,
          [path]: {
            ...existing,
            status: 'ready',
            content: loaded.content,
            originalContent: loaded.content,
            mtime: loaded.mtime,
            error: null,
            ...parsed,
          },
        };
      });
    }).catch((error) => {
      const message = error instanceof Error ? error.message : `Failed to load ${path}`;
      setDocs((prev) => {
        const existing = prev[path];
        if (!existing) return prev;
        return {
          ...prev,
          [path]: {
            ...existing,
            status: 'error',
            error: message,
          },
        };
      });
    });
  }, []);

  const modalDoc = modalState ? docs[modalState.path] ?? null : null;

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 px-0 py-0 backdrop-blur-sm">
      <div className="shell-panel h-[100dvh] w-[100dvw] overflow-y-auto overscroll-contain rounded-none animate-[targetBoardIn_180ms_ease-out]">
        <div className="flex min-h-full flex-col">
          <div className="shrink-0 border-b border-border/50 bg-secondary/35 px-5 py-4">
            <div className="flex flex-wrap items-start gap-4">
              <div className="min-w-0 flex-1">
                <div className="cockpit-kicker text-[0.6rem]">
                  <span className="text-primary">◆</span>
                  Targets
                </div>
                <h2 className="mt-1 text-lg font-semibold text-foreground">Coach the work</h2>
                <div className="mt-1 text-[0.733rem] text-muted-foreground">
                  Source: target-board/full-context.md first. Double-click any card to open the dashboard.
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => openModal(DEFAULT_SELECTED_PATH, 'preview')}>
                  <ArrowUpRight size={14} />
                  Open full context
                </Button>
                <Button type="button" variant="secondary" size="sm" onClick={reloadAllDocs}>
                  <RefreshCcw size={14} />
                  Refresh
                </Button>
                <Button type="button" variant="outline" size="icon-sm" onClick={onClose} aria-label="Close target board">
                  <X size={14} />
                </Button>
              </div>
            </div>

            <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
              {metricTile({ label: 'Docs', value: pluralize(availableDocs.length, 'doc'), tone: 'primary' })}
              {metricTile({ label: 'Ready', value: pluralize(loadedCount, 'doc'), tone: 'success' })}
              {metricTile({ label: 'Sections', value: pluralize(totalSections, 'section') })}
              {metricTile({ label: 'Words', value: pluralize(totalWords, 'word') })}
            </div>

            <div className="mt-4 flex flex-col gap-3 md:flex-row md:items-center">
              <div className="relative flex-1">
                <Search size={15} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <input
                  type="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search docs, headings, or text…"
                  className="cockpit-input h-11 w-full px-11 text-sm"
                />
                {search && (
                  <button
                    type="button"
                    onClick={() => setSearch('')}
                    className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full p-1 text-muted-foreground hover:text-foreground"
                    aria-label="Clear search"
                  >
                    <X size={14} />
                  </button>
                )}
              </div>

              <div className="flex items-center gap-2 text-[0.733rem] text-muted-foreground">
                <Target size={14} className="text-primary" />
                <span>Double-click opens the dashboard.</span>
              </div>
            </div>
          </div>

          <div className="grid min-h-0 flex-1 gap-4 px-4 py-4 sm:px-5 xl:grid-cols-[minmax(0,1.55fr)_minmax(320px,0.95fr)]">
            <div className="min-h-0 overflow-y-auto pr-1">
              <div className="space-y-4">
                {groupedDocs.map((group) => (
                  <section key={group.group} className="space-y-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="cockpit-kicker">
                        <span className="text-primary">◆</span>
                        {group.group}
                      </div>
                      <span className="cockpit-badge" data-tone="primary">
                        {pluralize(group.docs.length, 'doc')}
                      </span>
                    </div>

                    <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
                      {group.docs.map((doc) => (
                        <DocCard
                          key={doc.path}
                          doc={doc}
                          selected={doc.path === selectedPath}
                          onSelect={setSelectedPath}
                          onOpen={openModal}
                          onEdit={(path) => openModal(path, 'edit')}
                        />
                      ))}
                    </div>
                  </section>
                ))}

                {filteredDocs.length === 0 && (
                  <div className="cockpit-note border-dashed text-center">
                    <div className="mx-auto flex size-11 items-center justify-center rounded-2xl border border-border/70 bg-background/60 text-muted-foreground">
                      <Search size={16} />
                    </div>
                    <div className="mt-3 text-sm font-medium text-foreground">No docs match that search.</div>
                    <p className="mt-1 text-[0.8rem] text-muted-foreground">
                      Try “context”, “pipeline”, or clear the search to bring the full board back.
                    </p>
                    <Button type="button" variant="outline" size="sm" className="mt-4" onClick={() => setSearch('')}>
                      Clear search
                    </Button>
                  </div>
                )}
              </div>
            </div>

            <aside className="min-h-0 overflow-y-auto rounded-[26px] border border-border/70 bg-card/55 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] xl:sticky xl:top-4 xl:self-start">
              {selectedVisibleDoc ? (
                <div className="flex h-full min-h-0 flex-col">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="cockpit-kicker">
                        <span className="text-primary">◆</span>
                        Selected
                      </div>
                      <h3 className="mt-1 truncate text-[1.05rem] font-semibold tracking-[-0.03em] text-foreground">
                        {selectedVisibleDoc.label}
                      </h3>
                      <p className="mt-1 text-[0.8rem] leading-6 text-muted-foreground">
                        {selectedVisibleDoc.description}
                      </p>
                    </div>

                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="xs"
                        className="px-3"
                        onClick={() => openModal(selectedVisibleDoc.path, 'preview')}
                      >
                        Open
                        <ArrowUpRight size={12} />
                      </Button>
                      <Button
                        type="button"
                        variant="secondary"
                        size="xs"
                        className="px-3"
                        onClick={() => openModal(selectedVisibleDoc.path, 'edit')}
                      >
                        <PencilLine size={12} />
                        Edit
                      </Button>
                    </div>
                  </div>

                  <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-2">
                    {metricTile({ label: 'Words', value: pluralize(selectedVisibleDoc.wordCount, 'word'), tone: 'primary' })}
                    {metricTile({ label: 'Sections', value: pluralize(selectedVisibleDoc.headingCount, 'section') })}
                    {metricTile({ label: 'Lines', value: pluralize(selectedVisibleDoc.lineCount, 'line') })}
                    {metricTile({ label: 'Updated', value: selectedVisibleDoc.lastUpdatedLabel, tone: 'success' })}
                  </div>

                  <div className="mt-4 space-y-4 min-h-0 flex-1">
                    <div className="cockpit-note">
                      <div className="cockpit-field-label">Quick read</div>
                      <p className="mt-2 text-[0.833rem] leading-6 text-foreground/80">
                        {selectedVisibleDoc.excerpt}
                      </p>
                    </div>

                    {selectedVisibleDoc.headings.length > 0 && (
                      <div className="cockpit-note">
                        <div className="cockpit-field-label">Outline</div>
                        <ul className="mt-2 space-y-1.5">
                          {selectedVisibleDoc.headings.slice(0, 8).map((heading) => (
                            <li
                              key={`${heading.anchor}-${heading.text}`}
                              className={cn(
                                'truncate text-[0.8rem] leading-5 text-muted-foreground',
                                heading.depth <= 2 && 'text-foreground/88',
                                heading.depth > 2 && 'pl-3',
                              )}
                            >
                              <span className="mr-2 font-mono text-[0.667rem] text-muted-foreground/70">
                                {heading.depth === 1 ? 'H1' : heading.depth === 2 ? 'H2' : `H${heading.depth}`}
                              </span>
                              {heading.text}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    <div className="min-h-0 flex-1 rounded-[24px] border border-border/70 bg-background/40 p-4">
                      <div className="mb-3 flex items-center justify-between gap-2">
                        <div>
                          <div className="cockpit-field-label">Live preview</div>
                          <p className="mt-1 text-[0.733rem] text-muted-foreground">
                            Rendered markdown from the current saved file.
                          </p>
                        </div>
                        <span
                          className={cn(
                            'cockpit-badge',
                            selectedVisibleDoc.status === 'ready' ? 'text-green' : selectedVisibleDoc.status === 'error' ? 'text-destructive' : 'text-orange',
                          )}
                          data-tone={selectedVisibleDoc.status === 'ready' ? 'success' : selectedVisibleDoc.status === 'error' ? 'danger' : 'warning'}
                        >
                          {selectedVisibleDoc.status}
                        </span>
                      </div>

                      <div className="max-h-[28rem] overflow-y-auto pr-1">
                        {selectedVisibleDoc.status === 'loading' ? (
                          <div className="flex h-48 items-center justify-center gap-2 text-sm text-muted-foreground">
                            <Loader2 size={16} className="animate-spin" />
                            Loading…
                          </div>
                        ) : selectedVisibleDoc.status === 'error' ? (
                          <div className="cockpit-note border-dashed text-center">
                            <AlertTriangle size={20} className="mx-auto text-destructive" />
                            <div className="mt-2 text-sm font-medium text-foreground">This doc did not load.</div>
                            <p className="mt-1 text-[0.8rem] text-muted-foreground">{selectedVisibleDoc.error}</p>
                            <Button type="button" variant="outline" size="sm" className="mt-4" onClick={() => handleModalRetry(selectedVisibleDoc.path)}>
                              <RefreshCcw size={14} />
                              Reload
                            </Button>
                          </div>
                        ) : (
                          <MarkdownRenderer
                            content={selectedVisibleDoc.content}
                            className="markdown-document-content"
                            currentDocumentPath={selectedVisibleDoc.path}
                            onOpenWorkspacePath={(targetPath) => onOpenSection?.(targetPath)}
                          />
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex h-full items-center justify-center text-muted-foreground">
                  <div className="cockpit-note text-center">
                    <div className="mx-auto flex size-11 items-center justify-center rounded-2xl border border-border/70 bg-background/60 text-muted-foreground">
                      <Target size={16} />
                    </div>
                    <div className="mt-3 text-sm font-medium text-foreground">Select a doc to see it here.</div>
                    <p className="mt-1 text-[0.8rem] text-muted-foreground">The right rail stays live with the saved version and headings.</p>
                  </div>
                </div>
              )}
            </aside>
          </div>

          <TargetModal
            doc={modalDoc}
            open={Boolean(modalState)}
            mode={modalState?.mode ?? 'preview'}
            draft={modalState?.draft ?? null}
            saving={modalState?.saving ?? false}
            error={modalState?.error ?? null}
            onOpenChange={(nextOpen) => {
              if (!nextOpen) {
                if (modalState?.draft && modalState.draft.content !== modalState.draft.savedContent && !window.confirm('Discard unsaved changes?')) {
                  return;
                }
                setModalState(null);
                return;
              }
            }}
            onModeChange={(nextMode) => {
              setModalState((current) => (current ? { ...current, mode: nextMode } : current));
            }}
            onSave={handleModalSave}
            onContentChange={handleModalContentChange}
            onRetry={handleModalRetry}
            onOpenSection={onOpenSection}
          />

          <div className="sr-only" aria-live="polite">
            {currentActiveTask ? `Active work: ${currentActiveTask.title}` : 'No active task selected.'}
            {' '}
            {taskCount} board items visible.
          </div>
        </div>
      </div>
    </div>
  );
});

export default TargetBoardModal;
