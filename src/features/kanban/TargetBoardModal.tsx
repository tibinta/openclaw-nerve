import { memo, useEffect, useMemo, useState } from 'react';
import { X, Target, TrendingUp, Users, CircleCheckBig, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { KanbanTask } from './types';

interface TargetBoardModalProps {
  open: boolean;
  onClose: () => void;
  currentActiveTask: KanbanTask | null;
  taskCount: number;
}

const TARGET_INDEX_PATH = 'target-board/index.md';
const TARGET_LEGACY_PATH = 'target-board-live-note.md';
const AGENT_ID = 'main';

const TARGET_NOTE_URL = (path: string) => `/api/files/read?${new URLSearchParams({ path, agentId: AGENT_ID }).toString()}`;
const SPLIT_LOADING_MESSAGE = 'loading target sections';

const targetSourceFallback = `# Target Board Live Note

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
- If conversion drops, Jane creates a sales/copy/QA packet bundle.
- If CRM data is missing, Jane creates a data-source blocker instead of guessing.

## Next Actions
1. Confirm live CRM source and stream endpoints.
2. Map CRM fields to target metrics.
3. Add live actuals beside each target.
`;

const METRICS_LABELS = [
  { icon: TrendingUp, label: 'Targets', value: 'loading' },
  { icon: Users, label: 'Sections', value: 'loading' },
  { icon: CircleCheckBig, label: 'Coach', value: 'loading' },
];

interface CategoryNotes {
  title: string;
  metrics: string[];
  autoCoachRules: string[];
  nextActions: string[];
  extras: string[];
  sourcePath: string;
}

interface TargetLoadState {
  mode: 'loading' | 'live' | 'partial' | 'fallback';
  source: string;
}

const metricsState = (state: TargetLoadState): string => {
  switch (state.mode) {
    case 'live':
      return 'live';
    case 'partial':
      return 'partial';
    case 'loading':
      return 'loading';
    default:
      return 'fallback';
  }
};

function parseListItem(line: string): string | null {
  return line.match(/^\s*(?:[-*+]|(?:\d+\.)|\[[ xX]\])\s+(.*)$/)?.[1]?.trim() ?? null;
}

function normalizedHeading(line: string): string {
  return line.trim().toLowerCase();
}

function isCoachHeading(heading: string): boolean {
  return /auto-?coach|coach rules|coach/.test(heading);
}

function isNextActionsHeading(heading: string): boolean {
  return /\bnext action\b/.test(heading);
}

function isMetricsHeading(heading: string): boolean {
  return /^(metrics|targets?|revenue|financial|monthly|debt|pipeline|cash|mrr|wellness|action|target)/.test(heading);
}

function parseCategoryFile(source: string, path: string): CategoryNotes {
  const titleCandidate = source.match(/^#\s+(.*)$/m)?.[1]?.trim();
  const lines = source.split('\n');

  let heading = '';
  const category: CategoryNotes = {
    title: titleCandidate || path.replace('.md', ''),
    metrics: [],
    autoCoachRules: [],
    nextActions: [],
    extras: [],
    sourcePath: path,
  };

  const metricValues = new Set<string>();
  const coachValues = new Set<string>();
  const actionValues = new Set<string>();
  const extraValues = new Set<string>();

  for (const raw of lines) {
    const headingMatch = raw.match(/^#{1,6}\s+(.*)$/);
    if (headingMatch) {
      heading = normalizedHeading(headingMatch[1]);
      continue;
    }

    const item = parseListItem(raw);
    if (!item) continue;
    if (isCoachHeading(heading)) {
      coachValues.add(item);
      continue;
    }

    if (isNextActionsHeading(heading)) {
      actionValues.add(item);
      continue;
    }

    if (isMetricsHeading(heading) || /:/.test(item)) {
      metricValues.add(item);
      continue;
    }

    if (item) {
      extraValues.add(item);
    }
  }

  category.metrics = [...metricValues];
  category.autoCoachRules = [...coachValues];
  category.nextActions = [...actionValues];
  category.extras = [...extraValues];

  return category;
}

function extractSectionList(source: string): string[] {
  const lines = source.split('\n');
  const pathList: string[] = [];
  const indexDir = TARGET_INDEX_PATH.replace(/\/[^/]+$/, '');
  let inSections = false;

  for (const line of lines) {
    const heading = line.match(/^#{1,6}\s+(.*)$/)?.[1]?.toLowerCase();
    if (heading) {
      inSections = heading === 'sections' || heading === 'files';
      continue;
    }

    const item = parseListItem(line);
    if (!item) continue;
    if (!inSections) continue;
    if (!item.toLowerCase().endsWith('.md')) continue;

    const cleaned = item.replace(/^\s*\//, '').trim();
    if (!cleaned) continue;
    if (cleaned.includes('/')) {
      pathList.push(cleaned);
    } else {
      pathList.push(`${indexDir}/${cleaned}`);
    }
  }

  return pathList;
}

function splitMetricLine(line: string): { label: string; value: string } {
  const [label = '', ...rest] = line.split(':');
  if (line.includes(':') && rest.length >= 1) {
    return {
      label: label.trim(),
      value: rest.join(':').trim(),
    };
  }

  return {
    label: line,
    value: 'set',
  };
}

function dedupeLines(items: string[]): string[] {
  return [...new Set(items)];
}

function fallbackCategory(): CategoryNotes[] {
  return [parseCategoryFile(targetSourceFallback, TARGET_LEGACY_PATH)];
}

export const TargetBoardModal = memo(function TargetBoardModal({ open, onClose, currentActiveTask, taskCount }: TargetBoardModalProps) {
  const [categories, setCategories] = useState<CategoryNotes[]>(fallbackCategory);
  const [sourceState, setSourceState] = useState<TargetLoadState>({
    mode: 'fallback',
    source: TARGET_LEGACY_PATH,
  });

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const prev = document.body.style.overflow;
    if (open) document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let ignore = false;
    const controller = new AbortController();
    const loadFromSplit = async () => {
      setSourceState({ mode: 'loading', source: TARGET_INDEX_PATH });
      try {
        const indexResponse = await fetch(TARGET_NOTE_URL(TARGET_INDEX_PATH), { signal: controller.signal });
        if (!indexResponse.ok) throw new Error('index unavailable');

        const indexData = await indexResponse.json() as { ok?: boolean; content?: string };
        if (!indexData.ok || !indexData.content) throw new Error('index empty');

        const sectionPaths = dedupeLines(extractSectionList(indexData.content));
        if (sectionPaths.length === 0) {
          throw new Error('no section files listed');
        }

        const resolvedSections = await Promise.allSettled(sectionPaths.map(async (sectionPath) => {
          const response = await fetch(TARGET_NOTE_URL(sectionPath), { signal: controller.signal });
          if (!response.ok) throw new Error(`section unavailable: ${sectionPath}`);
          const data = await response.json() as { ok?: boolean; content?: string };
          if (!data.ok || !data.content) throw new Error(`empty section: ${sectionPath}`);
          return parseCategoryFile(data.content, sectionPath);
        }));

        const loadedSections = resolvedSections.flatMap((section) => (
          section.status === 'fulfilled' ? [section.value] : []
        ));

        if (ignore) return;
        if (loadedSections.length === 0) {
          throw new Error('no section content loaded');
        }

        setCategories(loadedSections);
        setSourceState({
          mode: resolvedSections.every((section) => section.status === 'fulfilled') ? 'live' : 'partial',
          source: TARGET_INDEX_PATH,
        });
      } catch {
        if (!ignore && !controller.signal.aborted) {
          setCategories(fallbackCategory());
          setSourceState({ mode: 'fallback', source: TARGET_LEGACY_PATH });
        }
      }
    };

    void loadFromSplit();
    return () => {
      ignore = true;
      controller.abort();
    };
  }, [open]);

  const sectionRows = useMemo(() => (
    categories.flatMap((category) => [...category.metrics, ...category.extras].map((metric) => ({
      ...splitMetricLine(metric),
      section: category.title,
    })))
  ), [categories]);

  const coachRules = useMemo(() => dedupeLines(categories.flatMap((category) => category.autoCoachRules)).slice(0, 6), [categories]);
  const nextActions = useMemo(() => dedupeLines(categories.flatMap((category) => category.nextActions)).slice(0, 6), [categories]);
  const activeMetrics = useMemo(() => [
    { ...METRICS_LABELS[0], value: `${sectionRows.length} metrics` },
    { ...METRICS_LABELS[1], value: `${categories.length} sections` },
    { ...METRICS_LABELS[2], value: metricsState(sourceState) },
  ], [categories.length, sectionRows.length]);

  const sourceLine = sourceState.mode === 'loading'
    ? SPLIT_LOADING_MESSAGE
    : sourceState.mode === 'live'
      ? sourceState.source
      : sourceState.mode === 'partial'
        ? `${sourceState.source} (partial)`
        : 'safe fallback';

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 px-4 py-6 backdrop-blur-sm">
      <div className="shell-panel w-[min(920px,100%)] max-h-[calc(100vh-3rem)] overflow-hidden rounded-[28px] animate-[targetBoardIn_180ms_ease-out]">
        <div className="flex items-center justify-between border-b border-border/50 bg-secondary/35 px-5 py-4">
          <div>
            <div className="cockpit-kicker text-[0.6rem]"><span className="text-primary">◆</span> Targets</div>
            <h2 className="mt-1 text-lg font-semibold text-foreground">Coach the work</h2>
            <div className="mt-1 text-[0.733rem] text-muted-foreground">
              Source: {sourceLine}
            </div>
          </div>
          <Button variant="outline" size="icon-sm" onClick={onClose} aria-label="Close target board">
            <X size={14} />
          </Button>
        </div>

        <div className="grid gap-4 p-5 md:grid-cols-[1.1fr_0.9fr]">
          <section className="rounded-[24px] border border-border/55 bg-background/70 p-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <Target size={16} className="text-primary" />
              Real targets
            </div>
            <div className="mt-4 grid gap-2">
              {sectionRows.length > 0 ? (
                sectionRows.map((item) => (
                  <div
                    key={`${item.section}:${item.label}:${item.value}`}
                    className="rounded-2xl border border-border/50 bg-secondary/25 px-3 py-2.5"
                  >
                    <div className="text-sm font-medium text-foreground">{item.label}</div>
                    <div className="text-[0.733rem] text-muted-foreground">
                      {item.value}
                      <span className="ml-2 text-[0.65rem] text-muted-foreground/85">({item.section})</span>
                    </div>
                  </div>
                ))
              ) : (
                <div className="rounded-2xl border border-border/50 bg-secondary/25 p-3 text-sm text-muted-foreground">
                  No live targets loaded. Showing fallback targets.
                </div>
              )}
            </div>
          </section>

          <section className="space-y-4 rounded-[24px] border border-border/55 bg-background/70 p-4">
            <div className="grid grid-cols-3 gap-2">
              {activeMetrics.map(({ icon: Icon, label, value }) => (
                <div key={label} className="rounded-2xl border border-border/50 bg-secondary/25 p-3 text-center">
                  <Icon size={16} className="mx-auto text-primary" />
                  <div className="mt-2 text-[0.667rem] uppercase tracking-[0.14em] text-muted-foreground">{label}</div>
                  <div className="mt-1 text-sm font-semibold text-foreground">{value}</div>
                </div>
              ))}
            </div>

            <div className="rounded-2xl border border-primary/15 bg-primary/[0.06] p-4">
              <div className="flex items-center gap-2 text-[0.667rem] uppercase tracking-[0.14em] text-muted-foreground">
                <ShieldCheck size={13} className="text-primary" />
                Auto-coach
              </div>
              <ul className="mt-2 space-y-2 text-sm font-medium text-foreground">
                {(coachRules.length ? coachRules : ['If data is missing, record a blocker instead of guessing.']).map((item) => (
                  <li key={item} className="leading-5">{item}</li>
                ))}
              </ul>
            </div>

            <div className="rounded-2xl border border-border/50 bg-secondary/20 p-4">
              <div className="text-[0.667rem] uppercase tracking-[0.14em] text-muted-foreground">Next action</div>
              <div className="mt-1 text-sm text-foreground">
                {nextActions.join('\n') || 'Confirm live CRM source and stream endpoints.'}
              </div>
            </div>

            <div className="rounded-2xl border border-border/50 bg-secondary/20 p-4">
              <div className="text-[0.667rem] uppercase tracking-[0.14em] text-muted-foreground">Active work</div>
              <div className="mt-1 text-sm text-foreground">{currentActiveTask ? currentActiveTask.title : 'No active task selected.'}</div>
              <div className="mt-1 text-[0.733rem] text-muted-foreground">{taskCount} board items visible, reused from the existing task state.</div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
});
