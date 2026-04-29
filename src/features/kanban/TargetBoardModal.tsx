import { memo, useEffect, useMemo, useState } from 'react';
import { X, Target, TrendingUp, Users, CircleCheckBig, ChevronRight, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { KanbanTask } from './types';

interface TargetBoardModalProps {
  open: boolean;
  onClose: () => void;
  currentActiveTask: KanbanTask | null;
  taskCount: number;
}

const TARGET_NOTE_PATH = 'target-board-live-note.md';
const TARGET_NOTE_URL = `/api/files/read?${new URLSearchParams({ path: TARGET_NOTE_PATH, agentId: 'main' }).toString()}`;

const targetSource = `# Target Board Live Note

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

const targetFallbacks: Record<string, string> = {
  '50,000 leads': 'Total pipeline target',
  '250/day': 'Daily throughput',
  '1,600 reachouts/day': 'Outreach motion',
  '200 new leads processed/day': 'Intake motion',
  '8-step conversion': 'Funnel depth',
  '11% conversion': 'Primary rate',
  '£75 software': 'Operating input',
  '£300,000 revenue target': 'Revenue goal',
  '4,000 clients monthly recurring': 'Scale target',
};

const metrics = [
  { icon: TrendingUp, label: 'Growth', value: 'live' },
  { icon: Users, label: 'Activity', value: 'tracked' },
  { icon: CircleCheckBig, label: 'Proof', value: 'ready' },
];

const targetKeys = Object.keys(targetFallbacks);

function extractTargetLine(source: string, key: string): string | null {
  const match = source.split('\n').map((line) => line.trim().replace(/^[-*]\s+/, '')).find((line) => line.includes(key));
  if (!match) return null;
  const [, value] = match.split(':', 2);
  return value?.trim() || match;
}

function extractSectionBullets(source: string, heading: string, maxItems = 4): string[] {
  const lines = source.split('\n');
  const startIndex = lines.findIndex((line) => line.trim().toLowerCase() === `## ${heading}`.toLowerCase());
  if (startIndex === -1) return [];
  const items: string[] = [];
  for (const line of lines.slice(startIndex + 1)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('## ')) break;
    const bullet = trimmed.match(/^(?:[-*]|\d+\.)\s+(.+)/)?.[1]?.trim();
    if (bullet) items.push(bullet);
    if (items.length >= maxItems) break;
  }
  return items;
}

export const TargetBoardModal = memo(function TargetBoardModal({ open, onClose, currentActiveTask, taskCount }: TargetBoardModalProps) {
  const [source, setSource] = useState(targetSource);
  const [sourceState, setSourceState] = useState<'loading' | 'live' | 'fallback'>('fallback');

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const prev = document.body.style.overflow;
    if (open) document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setSourceState('loading');
    void fetch(TARGET_NOTE_URL, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error('target note unavailable');
        const data = await res.json() as { ok?: boolean; content?: string };
        if (!data.ok || !data.content) throw new Error('target note empty');
        setSource(data.content);
        setSourceState('live');
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setSource(targetSource);
          setSourceState('fallback');
        }
      });
    return () => controller.abort();
  }, [open]);

  const targetRows = useMemo(() => targetKeys.map((key) => ({
    label: key,
    value: extractTargetLine(source, key) ?? targetFallbacks[key],
  })), [source]);

  const coachRules = useMemo(() => extractSectionBullets(source, 'Auto-Coach Rules', 4), [source]);
  const nextActions = useMemo(() => extractSectionBullets(source, 'Next Actions', 4), [source]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 px-4 py-6 backdrop-blur-sm">
      <div className="shell-panel w-[min(920px,100%)] max-h-[calc(100vh-3rem)] overflow-hidden rounded-[28px] animate-[targetBoardIn_180ms_ease-out]">
        <div className="flex items-center justify-between border-b border-border/50 bg-secondary/35 px-5 py-4">
          <div>
            <div className="cockpit-kicker text-[0.6rem]"><span className="text-primary">◆</span> Targets</div>
            <h2 className="mt-1 text-lg font-semibold text-foreground">Coach the work</h2>
            <div className="mt-1 text-[0.733rem] text-muted-foreground">
              Source: {sourceState === 'live' ? TARGET_NOTE_PATH : sourceState === 'loading' ? 'loading target note' : 'safe fallback'}
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
              {targetRows.map((item) => (
                <div key={item.label} className="flex items-center justify-between rounded-2xl border border-border/50 bg-secondary/25 px-3 py-2.5">
                  <div>
                    <div className="text-sm font-medium text-foreground">{item.label}</div>
                    <div className="text-[0.733rem] text-muted-foreground">{item.value}</div>
                  </div>
                  <ChevronRight size={14} className="text-muted-foreground" />
                </div>
              ))}
            </div>
          </section>

          <section className="space-y-4 rounded-[24px] border border-border/55 bg-background/70 p-4">
            <div className="grid grid-cols-3 gap-2">
              {metrics.map(({ icon: Icon, label, value }) => (
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
              <div className="mt-1 text-sm text-foreground">{nextActions[0] ?? 'Confirm live CRM source and stream endpoints.'}</div>
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
