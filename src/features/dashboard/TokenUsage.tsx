import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import type { TokenData, TokenEntry } from '@/types';
import { AnimatedNumber } from '@/components/ui/AnimatedNumber';
import { fmtTokens } from '@/lib/formatting';
import { useLimits } from './useLimits';
import type { CodexLimits, ClaudeCodeLimits } from './useLimits';

const ACCOUNT_SWITCHER_STORAGE_KEY = 'nerve:codex-active-account';
const FALLBACK_CODEX_ACCOUNTS = [
  { id: 'alex', label: 'Alex' },
  { id: 'onychuk', label: 'ONYCHUK' },
  { id: 'tiberia', label: 'Tiberia' },
  { id: 'nadella', label: 'nadella.tb@gmail.com' },
] as const;

function getAccountLabel(id: string, profiles?: Array<{ id: string; label: string }>) {
  return profiles?.find((account) => account.id === id)?.label ?? id;
}

// ── Reset time formatting helpers ───────────────────────────────────
function formatResetTime(tsMs: number, opts: { withDate?: boolean } = {}): string {
  const d = new Date(tsMs);
  if (opts.withDate) {
    return d.toLocaleString('en-GB', {
      month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    });
  }
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function formatTimeAgo(tsMs: number): string {
  const seconds = Math.floor((Date.now() - tsMs) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

function useTick(intervalMs: number) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick(n => n + 1), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
}

const PROVIDER_ICONS: Record<string, string> = {
  anthropic: '🟣',
  'openai-codex': '⚡',
  openai: '🟢',
  google: '🔵',
  gemini: '🔵',
};

const PROVIDER_BAR_CLASSES: Record<string, string> = {
  anthropic: 'bg-purple shadow-[0_0_4px_rgba(155,89,182,0.4)]',
  'openai-codex': 'bg-green shadow-[0_0_4px_rgba(76,175,80,0.4)]',
  openai: 'bg-green shadow-[0_0_4px_rgba(76,175,80,0.4)]',
};

const DEFAULT_BAR_CLASS = 'bg-primary shadow-[0_0_8px_rgba(232,168,56,0.3)]';

function LimitProgressBar({ label, usedPercent, barClass, resetText }: {
  label: string;
  usedPercent: number;
  barClass: string;
  resetText?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5 mb-1.5">
      <div className="flex items-baseline justify-between text-[0.733rem]">
        <span className="text-muted-foreground">{label}</span>
        <span className="text-foreground font-mono font-bold">{usedPercent.toFixed(0)}% used</span>
      </div>
      <div className="h-1.5 bg-background border border-border/60 overflow-hidden">
        <div className={`h-full ${barClass} transition-all duration-700`} style={{ width: `${Math.min(100, Math.max(0, usedPercent))}%` }} />
      </div>
      {resetText && <div className="text-[0.733rem] text-muted-foreground/60">resets {resetText}</div>}
    </div>
  );
}

function LimitsBlockShell({ icon, iconColor, title, lastChecked, loading, unavailable, children }: {
  icon: string;
  iconColor: string;
  title: string;
  lastChecked: number | null;
  loading: boolean;
  unavailable: boolean;
  children?: React.ReactNode;
}) {
  useTick(10_000);

  if (loading) return <div className="pt-1.5 mt-1 border-t border-border/30"><div className="text-[0.733rem] text-muted-foreground/50 flex items-center gap-1.5"><span className="animate-pulse">{icon}</span><span className="animate-pulse">Loading {title}…</span></div></div>;
  if (unavailable) return <div className="pt-1.5 mt-1 border-t border-border/30"><div className="text-[0.733rem] text-muted-foreground/40 flex items-center gap-1.5"><span>{icon}</span><span>{title} unavailable</span></div></div>;

  return <div className="pt-1.5 mt-1 border-t border-border/30"><div className="text-[0.733rem] text-muted-foreground uppercase tracking-[1px] flex items-center gap-1.5 mb-1"><span className={iconColor}>{icon}</span>{title}{lastChecked && <span className="text-[0.733rem] text-muted-foreground/50 ml-auto">{formatTimeAgo(lastChecked)}</span>}</div>{children}</div>;
}

const CODEX_BAR = 'bg-green shadow-[0_0_4px_rgba(76,175,80,0.4)]';
const CLAUDE_BAR = 'bg-purple shadow-[0_0_4px_rgba(155,89,182,0.4)]';

function CodexLimitsBlock({ limits, lastChecked }: { limits: CodexLimits | null; lastChecked: number | null }) {
  const five = limits?.five_hour_limit;
  const week = limits?.weekly_limit;

  return (
    <LimitsBlockShell icon="⚡" iconColor="text-green" title="Codex limits" lastChecked={lastChecked} loading={limits === null} unavailable={!limits?.available || !five}>
      {five && <LimitProgressBar label="5h limit" usedPercent={five.used_percent} barClass={CODEX_BAR} resetText={typeof five.resets_at === 'number' ? formatResetTime(five.resets_at * 1000) : undefined} />}
      {week && <LimitProgressBar label="Weekly limit" usedPercent={week.used_percent} barClass={CODEX_BAR} resetText={typeof week.resets_at === 'number' ? formatResetTime(week.resets_at * 1000, { withDate: true }) : undefined} />}
    </LimitsBlockShell>
  );
}

function ClaudeLimitsBlock({ limits, lastChecked }: { limits: ClaudeCodeLimits | null; lastChecked: number | null }) {
  const session = limits?.session_limit;
  const week = limits?.weekly_limit;
  const sessionResetText = session?.resets_at_epoch ? formatResetTime(session.resets_at_epoch) : session?.resets_at_raw?.replace(/\s*\(UTC\)\s*/g, '').trim();
  const weekResetText = week?.resets_at_epoch ? formatResetTime(week.resets_at_epoch, { withDate: true }) : week?.resets_at_raw?.replace(/\s*\(UTC\)\s*/g, '').trim();

  return (
    <LimitsBlockShell icon="🟣" iconColor="text-purple" title="Claude Code limits" lastChecked={lastChecked} loading={limits === null} unavailable={!limits?.available || !session}>
      {session && <LimitProgressBar label="Session limit" usedPercent={session.used_percent} barClass={CLAUDE_BAR} resetText={sessionResetText || undefined} />}
      {week && <LimitProgressBar label="Weekly limit" usedPercent={week.used_percent} barClass={CLAUDE_BAR} resetText={weekResetText || undefined} />}
    </LimitsBlockShell>
  );
}

function AccountSwitcher({ activeAccount, onChange, onCaptureProfile, savingProfileId, rotationAvailable, blocker, nextAction, profiles }: {
  activeAccount: string;
  onChange: (id: string) => void;
  onCaptureProfile: (profile: { id: string; label: string }) => void;
  savingProfileId: string | null;
  rotationAvailable: boolean;
  blocker?: string;
  nextAction?: string;
  profiles: Array<{ id: string; label: string }>;
}) {
  return (
    <div className="rounded-2xl border border-border/60 bg-background/50 p-2.5">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="text-[0.667rem] font-medium uppercase tracking-[0.22em] text-muted-foreground">Codex accounts</div>
          <div className="mt-0.5 text-sm font-semibold text-foreground">{getAccountLabel(activeAccount, profiles)}</div>
        </div>
        <span className="cockpit-badge" data-tone={rotationAvailable ? 'success' : 'warning'}>{rotationAvailable ? 'Auto-rotate ready' : 'Profiles missing'}</span>
      </div>
      <div className="mt-2 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
        {profiles.map((account) => (
          <button
            key={account.id}
            onClick={() => rotationAvailable ? onChange(account.id) : onCaptureProfile(account)}
            aria-pressed={rotationAvailable ? activeAccount === account.id : false}
            disabled={savingProfileId === account.id}
            className="cockpit-toolbar-button justify-between px-2 py-1.5 text-[0.667rem] uppercase tracking-[0.1em] disabled:cursor-not-allowed disabled:opacity-60"
            data-active={activeAccount === account.id}
            title={rotationAvailable ? account.id : `Save current login as ${account.label}`}
          >
            <span className="truncate">{account.label}</span>
            {rotationAvailable
              ? (activeAccount === account.id ? <span className="text-[0.6rem] text-muted-foreground">active</span> : null)
              : (savingProfileId === account.id ? <span className="text-[0.6rem] text-muted-foreground">saving</span> : <span className="text-[0.6rem] text-muted-foreground">capture</span>)}
          </button>
        ))}
      </div>
      <p className="mt-2 text-[0.667rem] leading-5 text-muted-foreground">
        {rotationAvailable
          ? 'When a Codex window hits 100%, the cockpit can rotate the shared auth file automatically.'
          : (blocker ? `${blocker}. ${nextAction || ''}`.trim() : 'Log into the desired Codex account, then click its slot here to capture the current auth snapshot.')}
      </p>
    </div>
  );
}

function CodexSummaryCard({ rotation, activeAccount, profiles }: { rotation: CodexLimits['rotation']; activeAccount: string; profiles: Array<{ id: string; label: string }>; }) {
  return (
    <div className="rounded-2xl border border-border/60 bg-card/70 p-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[0.667rem] font-medium uppercase tracking-[0.22em] text-muted-foreground">Codex account</div>
          <div className="truncate text-sm font-semibold text-foreground">{getAccountLabel(activeAccount, profiles)} <span className="text-muted-foreground font-normal">· {rotation?.available ? 'watcher armed' : 'manual only'}</span></div>
        </div>
        <span className="cockpit-badge" data-tone={rotation?.available ? 'success' : 'warning'}>{rotation?.available ? 'Auto-rotate ready' : 'Profiles missing'}</span>
      </div>
      <div className="mt-1 text-[0.667rem] leading-5 text-muted-foreground">
        {rotation?.available
          ? 'Flips to the next saved profile when 5h or weekly limit hits zero, or reaches 100%.'
          : ((rotation?.blocker || 'Saved profiles are missing') + ' ' + (rotation?.nextAction || '')).trim()}
      </div>
    </div>
  );
}
function ProviderRow({ entry, maxCost, codexLimits, claudeLimits, codexLastChecked, claudeLastChecked }: {
  entry: TokenEntry;
  maxCost: number;
  codexLimits: CodexLimits | null;
  claudeLimits: ClaudeCodeLimits | null;
  codexLastChecked: number | null;
  claudeLastChecked: number | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const pct = Math.max(2, (entry.cost / maxCost) * 100);
  const barClass = PROVIDER_BAR_CLASSES[entry.source] || DEFAULT_BAR_CLASS;
  const costCents = Math.round(entry.cost * 100);
  const icon = PROVIDER_ICONS[entry.source] || '●';
  const avgCost = entry.messageCount ? entry.cost / entry.messageCount : 0;
  const hasErrors = (entry.errorCount || 0) > 0;

  return (
    <div className="flex flex-col">
      <button onClick={() => setExpanded(!expanded)} aria-expanded={expanded} aria-label={`${entry.source} provider details`} className="flex items-center gap-2 text-[0.733rem] w-full hover:bg-muted/30 rounded px-0.5 py-0.5 transition-colors cursor-pointer group">
        <span className="w-3.5 text-center shrink-0 text-xs flex items-center justify-center">{icon}</span>
        <span className="text-foreground text-[0.733rem] font-bold w-16 shrink-0 uppercase tracking-[0.5px]">{entry.source}</span>
        <div className="flex-1 h-2 bg-background border border-border/60 overflow-hidden"><div className={`h-full ${barClass}`} style={{ width: `${pct}%`, transition: 'width 700ms cubic-bezier(0.25, 0.46, 0.45, 0.94)' }} /></div>
        <AnimatedNumber value={costCents} format={(n) => '$' + (n / 100).toFixed(2)} className="text-muted-foreground text-[0.733rem] w-13 text-right shrink-0" duration={600} />
        <span className={`text-[0.667rem] transition-transform duration-150 ${expanded ? 'rotate-180' : ''} text-muted-foreground/50 group-hover:text-muted-foreground`}>▼</span>
      </button>
      {expanded && <div className="pl-6 pr-1 pb-1.5 pt-0.5 flex flex-col gap-1 border-l-2 border-border/30 ml-[7px]"><div className="flex gap-3 text-[0.733rem] text-muted-foreground flex-wrap"><span>↑ <span className="text-foreground">{fmtTokens(entry.inputTokens || 0)}</span> in</span><span>↓ <span className="text-foreground">{fmtTokens(entry.outputTokens || 0)}</span> out</span>{(entry.cacheReadTokens || 0) > 0 && <span>📦 <span className="text-foreground">{fmtTokens(entry.cacheReadTokens || 0)}</span> cached</span>}</div><div className="flex gap-3 text-[0.733rem] text-muted-foreground flex-wrap"><span>💬 <span className="text-foreground">{(entry.messageCount || 0).toLocaleString()}</span> msgs</span><span>avg <span className="text-foreground">${avgCost.toFixed(4)}</span>/msg</span>{hasErrors && <span className="text-red">⚠ <span className="font-bold">{entry.errorCount}</span> errors</span>}</div>{entry.source === 'openai-codex' && <CodexLimitsBlock limits={codexLimits} lastChecked={codexLastChecked} />}{entry.source === 'anthropic' && <ClaudeLimitsBlock limits={claudeLimits} lastChecked={claudeLastChecked} />}</div>}
    </div>
  );
}

interface TokenUsageProps {
  data: TokenData | null;
}

export function TokenUsage({ data }: TokenUsageProps) {
  const entries = useMemo(() => (data?.entries || []).filter((e) => e.cost > 0 || (e.messageCount || 0) > 0 || (e.errorCount || 0) > 0), [data?.entries]);
  const maxCost = useMemo(() => Math.max(1, ...entries.map((e) => e.cost)), [entries]);
  const [limitsRefreshKey, setLimitsRefreshKey] = useState(0);
  const [savingProfileId, setSavingProfileId] = useState<string | null>(null);
  const [captureMessage, setCaptureMessage] = useState<string | null>(null);
  const { codexLimits, claudeLimits, codexLastChecked, claudeLastChecked } = useLimits(limitsRefreshKey);
  const [activeAccount, setActiveAccount] = useState(() => {
    try { return localStorage.getItem(ACCOUNT_SWITCHER_STORAGE_KEY) || FALLBACK_CODEX_ACCOUNTS[0].id; } catch { return FALLBACK_CODEX_ACCOUNTS[0].id; }
  });

  useEffect(() => {
    try { localStorage.setItem(ACCOUNT_SWITCHER_STORAGE_KEY, activeAccount); } catch { /* ignore */ }
  }, [activeAccount]);


  const rotation = codexLimits?.rotation;
  const rotationAvailable = Boolean(rotation?.available);
  const profilesMissing = !rotationAvailable;
  const profiles = rotation?.profiles?.length
    ? rotation.profiles.map((profile) => ({ id: profile.id, label: profile.label }))
    : FALLBACK_CODEX_ACCOUNTS.map((account) => ({ id: account.id, label: account.label }));
  const rotationInFlight = useRef(false);
  const captureCodexProfile = useCallback(async (profile: { id: string; label: string }) => {
    if (savingProfileId) return;
    setSavingProfileId(profile.id);
    setCaptureMessage(null);
    try {
      const res = await fetch('/api/codex-limits/profiles/capture', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: profile.id, label: profile.label }),
      });
      const json = await res.json().catch(() => null) as { ok?: boolean; message?: string } | null;
      if (!res.ok || !json?.ok) throw new Error(json?.message || 'Failed to capture Codex profile');
      setCaptureMessage(json.message || `Saved ${profile.label}`);
      setLimitsRefreshKey((n) => n + 1);
    } catch (error) {
      setCaptureMessage(error instanceof Error ? error.message : 'Failed to capture Codex profile');
    } finally {
      setSavingProfileId(null);
    }
  }, [savingProfileId]);
  const rotateCodex = useCallback(async (targetId?: string) => {
    if (rotationInFlight.current) return;
    rotationInFlight.current = true;
    try {
      await fetch('/api/codex-limits/rotate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(targetId ? { targetId } : {}),
      });
    } finally {
      rotationInFlight.current = false;
    }
  }, []);

  useEffect(() => {
    const hottest = Math.max(codexLimits?.five_hour_limit?.used_percent ?? 0, codexLimits?.weekly_limit?.used_percent ?? 0);
    const zeroLeft = (codexLimits?.five_hour_limit?.left_percent ?? 1) <= 0 || (codexLimits?.weekly_limit?.left_percent ?? 1) <= 0;
    if (!rotationAvailable || (!zeroLeft && hottest < 100)) return;
    void rotateCodex();
  }, [rotationAvailable, codexLimits?.five_hour_limit?.used_percent, codexLimits?.weekly_limit?.used_percent, codexLimits?.five_hour_limit?.left_percent, codexLimits?.weekly_limit?.left_percent, rotateCodex]);

  if (!data) {
    return <div className="h-full flex flex-col min-h-0"><div className="panel-header border-l-[3px] border-l-primary"><span className="panel-label text-primary"><span className="panel-diamond">◆</span>USAGE</span></div><div className="p-3 text-muted-foreground text-[0.667rem]">Loading…</div></div>;
  }

  const totalCostCents = Math.round((data.persistent?.totalCost ?? data.totalCost ?? 0) * 100);
  const codexFive = codexLimits?.five_hour_limit?.used_percent;
  const codexWeek = codexLimits?.weekly_limit?.used_percent;
  const accountPressure = typeof codexFive === 'number' || typeof codexWeek === 'number'
    ? Math.max(codexFive ?? 0, codexWeek ?? 0)
    : null;

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="panel-header border-l-[3px] border-l-primary">
        <span className="panel-label text-primary"><span className="panel-diamond">◆</span>USAGE</span>
      </div>
      <div className="flex-1 overflow-y-auto">
        <div className="px-3 py-2.5 flex flex-col gap-2">
          <div className="flex items-baseline gap-2 pb-1.5 border-b border-border/40 mb-0.5"><AnimatedNumber value={totalCostCents} format={(n) => '$' + (n / 100).toFixed(2)} className="text-xl font-bold text-primary [text-shadow:0_0_8px_rgba(232,168,56,0.3)]" duration={800} /><span className="text-[0.733rem] text-muted-foreground uppercase tracking-[1px]">all-time</span></div>
          <CodexSummaryCard rotation={rotation} activeAccount={activeAccount} profiles={profiles} />
          {captureMessage && <div className="cockpit-note" data-tone="primary"><div className="font-medium text-foreground">Profile capture</div><div className="mt-1 text-[0.667rem] leading-5 text-muted-foreground">{captureMessage}</div></div>}
          <div className="cockpit-note" data-tone={profilesMissing ? 'danger' : 'primary'}>
            <div className="font-medium text-foreground">Profiles status</div>
            <div className="mt-1 text-[0.667rem] leading-5 text-muted-foreground">
              {rotationAvailable
                ? 'Saved profiles are present. Rotation is live.'
                : `${rotation?.blocker || 'No saved Codex profiles found'}. ${rotation?.nextAction || 'Create ~/.codex/profiles.json or ~/.codex/profiles/*.json, then save each account once.'}`}
            </div>
          </div>
          <AccountSwitcher
            activeAccount={activeAccount}
            onChange={setActiveAccount}
            onCaptureProfile={captureCodexProfile}
            savingProfileId={savingProfileId}
            rotationAvailable={rotationAvailable}
            blocker={rotation?.blocker}
            nextAction={rotation?.nextAction}
            profiles={profiles}
          />
          <div className="cockpit-note" data-tone={accountPressure !== null && accountPressure >= 80 ? 'danger' : 'primary'}>
            <div className="font-medium text-foreground">Current limit posture</div>
            <div className="mt-1 text-[0.667rem] leading-5 text-muted-foreground">
              {accountPressure !== null
                ? `Selected account ${getAccountLabel(activeAccount, profiles)} is tracking at about ${accountPressure.toFixed(0)}% on the hottest Codex window.`
                : rotationAvailable ? 'Auto-rotate watcher armed. When Codex hits 100%, the backend will swap to the next profile.' : 'Codex status is loading. Use the account switcher above to prep a fallback account early.'}
            </div>
          </div>
          {entries.length > 0 ? entries.map((e) => (
            <ProviderRow key={e.source} entry={e} maxCost={maxCost} codexLimits={codexLimits} claudeLimits={claudeLimits} codexLastChecked={codexLastChecked} claudeLastChecked={claudeLastChecked} />
          )) : (
            <div className="text-[0.733rem] text-muted-foreground">No usage entries yet.</div>
          )}
          <div className="text-[0.667rem] text-muted-foreground/70">{rotationAvailable ? 'Auto-rotation now uses saved Codex profiles and updates ~/.codex/auth.json atomically.' : 'Auto-switch is blocked until saved Codex profiles exist.'}</div>
        </div>
      </div>
    </div>
  );
}
