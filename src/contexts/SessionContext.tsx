/* eslint-disable react-refresh/only-export-components -- hook intentionally co-located with provider */
import { createContext, useContext, useCallback, useRef, useEffect, useState, useMemo, type ReactNode } from 'react';
import { useGateway } from './GatewayContext';
import { useSettings } from './SettingsContext';
import { getSessionKey, type Session, type AgentLogEntry, type EventEntry, type GatewayEvent, type EventPayload, type AgentEventPayload, type ChatEventPayload, type ContentBlock, type SessionsListResponse, type ChatMessage, type GranularAgentState } from '@/types';
import { CONTEXT_CRITICAL_THRESHOLD } from '@/lib/constants';
import { playPing } from '@/features/voice/audio-feedback';
import { describeToolUse } from '@/utils/helpers';
import { buildAgentSidebarTree, buildSessionTree } from '@/features/sessions/sessionTree';
import {
  buildAgentRootSessionKey,
  getAgentRegistrationName,
  LEGACY_MAIN_SESSION_KEY,
  JANE_DIRECT_CHAT_SESSION_KEY,
  PRIMARY_AGENT_SESSION_KEY,
  getRootAgentSessionKey,
  getSessionDisplayLabel,
  getTopLevelAgentSessions,
  inferParentSessionKey,
  isSubagentSessionKey,
  isTopLevelAgentSessionKey,
  pickDefaultSessionKey,
  getRootAgentId,
  normalizeSessionKey,
} from '@/features/sessions/sessionKeys';

const BUSY_STATES = new Set(['running', 'thinking', 'tool_use', 'delta', 'started']);
const IDLE_STATES = new Set(['idle', 'done', 'error', 'final', 'aborted', 'completed']);
const SESSION_BUSY_STATES = new Set(['running', 'thinking', 'tool_use', 'streaming', 'started', 'busy', 'working']);

// Keep the sidebar list broad enough for older roots, but avoid dragging the
// gateway with a 1000-row fetch on every refresh cycle.
const INITIAL_SESSIONS_LIMIT = 3;
const FULL_SESSIONS_LIMIT = 50;
// Nerve should not ask the gateway for the full historical store on every
// startup/poll. A bounded recent window keeps the sidebar useful while avoiding
// multi-minute sessions.list calls when old heartbeat/subagent ledgers are huge.
const SESSION_REFRESH_ACTIVE_MINUTES = 7 * 24 * 60;
// When the gateway is already slow, backing off the fallback polling keeps the
// session list from piling on top of live event-driven refreshes.
const SESSION_REFRESH_POLL_INTERVAL_MS = 300_000;
const FULL_SESSION_REFRESH_DELAY_MS = 60_000;
const DELAYED_SESSION_REFRESH_MS = 30_000;

export interface GatewayAgentRegistration {
  id: string;
  name?: string;
  identityName?: string;
  label?: string;
}

export type SubagentCleanupMode = 'keep' | 'delete';

export interface SpawnSessionOpts {
  kind: 'root' | 'subagent';
  task: string;
  model?: string;
  thinking?: string;
  label?: string;
  cleanup?: SubagentCleanupMode;
  agentName?: string;
  parentSessionKey?: string;
}

interface SessionContextValue {
  sessions: Session[];
  sessionsLoading: boolean;
  agents: GatewayAgentRegistration[];
  agentsLoading: boolean;
  currentSession: string;
  setCurrentSession: (key: string) => void;
  busyState: Record<string, boolean>;
  agentStatus: Record<string, GranularAgentState>;
  unreadSessions: Record<string, boolean>;
  markSessionRead: (key: string) => void;
  abortSession: (sessionKey: string) => Promise<void>;
  refreshSessions: () => Promise<void>;
  deleteSession: (sessionKey: string) => Promise<void>;
  deleteAllSessions: () => Promise<void>;
  spawnSession: (opts: SpawnSessionOpts) => Promise<void>;
  renameSession: (sessionKey: string, label: string) => Promise<void>;
  updateSession: (sessionKey: string, updates: Partial<Session>) => void;
  agentLogEntries: AgentLogEntry[];
  eventEntries: EventEntry[];
  agentName: string;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function isSessionActivelyBusy(session: Session | undefined, granularBusy: boolean): boolean {
  if (!session) return false;
  if (granularBusy) return true;
  if (session.hasActiveRun === true) return true;

  const state = String(session.state ?? '').toLowerCase();
  const agentState = String(session.agentState ?? '').toLowerCase();
  const status = String(session.status ?? '').toLowerCase();

  if (session.hasActiveRun === false) {
    // Gateway stores can keep "running" after provider timeout/overload.
    // The explicit active-run marker is safer, so the UI recovers instead of
    // trapping the user behind a stale working state.
    return false;
  }

  return session.busy === true
    || session.processing === true
    || SESSION_BUSY_STATES.has(state)
    || SESSION_BUSY_STATES.has(agentState)
    || SESSION_BUSY_STATES.has(status);
}

function isProtectedRootSessionKey(sessionKey: string): boolean {
  return sessionKey === PRIMARY_AGENT_SESSION_KEY || sessionKey === LEGACY_MAIN_SESSION_KEY;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const { connectionState, rpc, subscribe } = useGateway();
  const { soundEnabled } = useSettings();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [agents, setAgents] = useState<GatewayAgentRegistration[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(true);
  const [currentSession, setCurrentSessionRaw] = useState(JANE_DIRECT_CHAT_SESSION_KEY);
  const [agentLogEntries, setAgentLogEntries] = useState<AgentLogEntry[]>([]);
  const [eventEntries, setEventEntries] = useState<EventEntry[]>([]);
  const [agentStatus, setAgentStatus] = useState<Record<string, GranularAgentState>>({});
  const [agentName, setAgentName] = useState('Agent');
  const [unreadSessionKeys, setUnreadSessionKeys] = useState<Set<string>>(new Set());
  const unreadSessionKeysRef = useRef(unreadSessionKeys);
  const soundEnabledRef = useRef(soundEnabled);
  const logStateRef = useRef<Record<string, boolean>>({});
  const toolSeenRef = useRef<Map<string, number>>(new Map());
  const doneTimeoutsRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const delayedRefreshTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fullRefreshTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshSessionsInFlightRef = useRef(false);
  const listAuthoritativeSessionsInFlightRef = useRef<Promise<Session[]> | null>(null);
  const emptySnapshotSeenRef = useRef(false);
  const initialSessionSnapshotLoadedRef = useRef(false);

  // Derive busyState from agentStatus for backward compatibility
  const busyState = useMemo(() => {
    const result: Record<string, boolean> = {};
    for (const [key, state] of Object.entries(agentStatus)) {
      result[key] = state.status !== 'IDLE' && state.status !== 'DONE';
    }
    return result;
  }, [agentStatus]);
  
  // Derive unreadSessions as a stable Record<string, boolean> for consumers
  const unreadSessions = useMemo(() => {
    const result: Record<string, boolean> = {};
    for (const key of unreadSessionKeys) {
      result[key] = true;
    }
    return result;
  }, [unreadSessionKeys]);

  useEffect(() => {
    unreadSessionKeysRef.current = unreadSessionKeys;
  }, [unreadSessionKeys]);

  useEffect(() => {
    soundEnabledRef.current = soundEnabled;
  }, [soundEnabled]);

  const markSessionRead = useCallback((key: string) => {
    if (!unreadSessionKeysRef.current.has(key)) return;
    const next = new Set(unreadSessionKeysRef.current);
    next.delete(key);
    unreadSessionKeysRef.current = next;
    setUnreadSessionKeys(next);
  }, []);

  const setCurrentSession = useCallback((key: string) => {
    currentSessionRef.current = key;
    setCurrentSessionRaw(key);
    markSessionRead(key);
  }, [markSessionRead]);

  const fetchHiddenCronSessions = useCallback(async (activeMinutes: number, limit: number): Promise<Session[]> => {
    try {
      const params = new URLSearchParams({
        activeMinutes: String(activeMinutes),
        limit: String(limit),
      });
      const res = await fetch(`/api/sessions/hidden?${params.toString()}`);
      if (!res.ok) return [];
      const data = await res.json() as { ok?: boolean; sessions?: Session[] };
      return Array.isArray(data.sessions) ? data.sessions : [];
    } catch {
      return [];
    }
  }, []);

  const mergeSessionLists = useCallback((primary: Session[], supplemental: Session[]): Session[] => {
    if (supplemental.length === 0) return primary;
    const merged = [...primary];
    const seen = new Set(primary.map(getSessionKey));
    for (const session of supplemental) {
      const key = getSessionKey(session);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      merged.push(session);
    }
    return merged;
  }, []);

  const refreshAgents = useCallback(async () => {
    setAgentsLoading(true);
    try {
      const res = await fetch('/api/gateway/agents');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { agents?: GatewayAgentRegistration[] };
      setAgents(Array.isArray(data.agents) ? data.agents : []);
    } catch (err) {
      console.debug('[SessionContext] Failed to load agents registry, deriving from live sessions:', err);
      const derivedAgents: GatewayAgentRegistration[] = [];
      for (const node of buildAgentSidebarTree(sessionsRef.current)) {
        const familyId = node.familyId || getRootAgentId(node.selectKey || node.key);
        if (!familyId) continue;
        derivedAgents.push({
            id: familyId,
            name: node.displayLabel?.trim() || node.session.displayName?.trim() || node.session.label?.trim() || undefined,
            identityName: node.displayLabel?.trim() || node.session.displayName?.trim() || undefined,
            label: node.displayLabel?.trim() || node.session.displayName?.trim() || node.session.label?.trim() || undefined,
        });
      }
      setAgents(derivedAgents);
    } finally {
      setAgentsLoading(false);
    }
  }, []);

  // Fetch agent name from server-info on mount
  useEffect(() => {
    void refreshAgents();
  }, [refreshAgents]);

  useEffect(() => {
    if (connectionState !== 'connected') return;
    if (currentSessionRef.current) return;
    // Seed the operator chat lane immediately so the UI has a usable default
    // before the first sessions poll finishes. The live session list will
    // reconcile this once data arrives, but we never want to sit on a blank
    // chat frame when Jane direct is available.
    setCurrentSession(JANE_DIRECT_CHAT_SESSION_KEY);
  }, [connectionState, setCurrentSession]);

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch('/api/server-info', { signal: controller.signal });
        if (!res.ok) return;
        const data = await res.json();
        if (data.agentName) {
          setAgentName(data.agentName);
        }
      } catch (err) {
        if (err instanceof Error && err.name !== 'AbortError') {
          // silent fail - use default
        }
      }
    })();
    return () => controller.abort();
  }, []);
  const sessionsRef = useRef(sessions);
  const autoCompactTokensRef = useRef<Record<string, number>>({});
  
  // Update refs in effect to avoid render-time mutations
  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);
  
  const currentSessionRef = useRef(currentSession);
  useEffect(() => {
    currentSessionRef.current = currentSession;
  }, [currentSession]);

  const currentSessionData = useMemo(
    () => sessions.find((session) => getSessionKey(session) === currentSession),
    [currentSession, sessions],
  );

  const markSessionUnread = useCallback((sessionKey: string) => {
    if (!sessionKey || currentSessionRef.current === sessionKey || unreadSessionKeysRef.current.has(sessionKey)) return;
    const next = new Set(unreadSessionKeysRef.current);
    next.add(sessionKey);
    unreadSessionKeysRef.current = next;
    setUnreadSessionKeys(next);
  }, []);

  const pingSession = useCallback((sessionKey: string) => {
    if (!sessionKey || currentSessionRef.current === sessionKey || !soundEnabledRef.current) return;
    playPing();
  }, []);

  const findDescendantSessionKeys = useCallback((sessionKey: string, sourceSessions: Session[] = sessionsRef.current) => {
    const roots = buildSessionTree(sourceSessions);
    const queue = [...roots];
    let targetNode: (typeof roots)[number] | null = null;

    while (queue.length > 0) {
      const node = queue.shift()!;
      if (node.key === sessionKey) {
        targetNode = node;
        break;
      }
      queue.push(...node.children);
    }

    if (!targetNode) return [] as string[];

    const descendants: string[] = [];
    const collectPostOrder = (node: (typeof roots)[number]) => {
      for (const child of node.children) collectPostOrder(child);
      descendants.push(node.key);
    };
    for (const child of targetNode.children) collectPostOrder(child);

    return descendants;
  }, []);

  const listAuthoritativeSessions = useCallback(async (mode: 'initial' | 'full' = 'full') => {
    if (connectionState !== 'connected') return sessionsRef.current;
    if (listAuthoritativeSessionsInFlightRef.current) {
      return listAuthoritativeSessionsInFlightRef.current;
    }

    const inFlight = (async () => {
      try {
        const limit = mode === 'initial' ? INITIAL_SESSIONS_LIMIT : FULL_SESSIONS_LIMIT;
        const res = await rpc('sessions.list', { activeMinutes: SESSION_REFRESH_ACTIVE_MINUTES, limit }) as SessionsListResponse;
        if (mode === 'initial') {
          return res?.sessions ?? [];
        }

        const hiddenCronSessions = await fetchHiddenCronSessions(24 * 60, FULL_SESSIONS_LIMIT);
        return mergeSessionLists(res?.sessions ?? [], hiddenCronSessions);
      } catch (err) {
        console.debug('[SessionContext] Failed to fetch authoritative session list:', err);
        return sessionsRef.current;
      } finally {
        listAuthoritativeSessionsInFlightRef.current = null;
      }
    })();

    listAuthoritativeSessionsInFlightRef.current = inFlight;
    try {
      return await inFlight;
    } finally {
      if (listAuthoritativeSessionsInFlightRef.current === inFlight) {
        listAuthoritativeSessionsInFlightRef.current = null;
      }
    }
  }, [connectionState, fetchHiddenCronSessions, mergeSessionLists, rpc]);

  const setGranularStatus = useCallback((sessionKey: string, state: GranularAgentState) => {
    if (!sessionKey) return;
    // Cancel any pending DONE→IDLE timeout for this session
    if (doneTimeoutsRef.current[sessionKey]) {
      clearTimeout(doneTimeoutsRef.current[sessionKey]);
      delete doneTimeoutsRef.current[sessionKey];
    }
    // If transitioning to DONE, schedule auto-transition to IDLE after 3s
    if (state.status === 'DONE') {
      // Mark subagent sessions as unread when they complete (unless currently viewing)
      if (isSubagentSessionKey(sessionKey)) {
        markSessionUnread(sessionKey);
      }
      doneTimeoutsRef.current[sessionKey] = setTimeout(() => {
        setAgentStatus(prev => {
          const current = prev[sessionKey];
          // Only transition if still in DONE state
          if (!current || current.status !== 'DONE') return prev;
          return { ...prev, [sessionKey]: { status: 'IDLE', since: Date.now() } };
        });
        delete doneTimeoutsRef.current[sessionKey];
      }, 3000);
    }
    setAgentStatus(prev => {
      const existing = prev[sessionKey];
      // Optimization: skip update if status/tool haven't changed
      if (existing && existing.status === state.status && existing.toolName === state.toolName) return prev;
      return { ...prev, [sessionKey]: state };
    });
  }, [markSessionUnread]);

  const shouldLogTool = useCallback((toolId: string) => {
    if (!toolId) return false;
    const now = Date.now();
    const map = toolSeenRef.current;
    const DEDUP_MS = 5 * 60 * 1000;
    const last = map.get(toolId);
    if (last && now - last < DEDUP_MS) return false;
    map.set(toolId, now);
    // Prune expired entries when map grows too large
    if (map.size > 500) {
      for (const [key, ts] of map) {
        if (now - ts > DEDUP_MS) map.delete(key);
      }
    }
    return true;
  }, []);

  const addAgentLogEntry = useCallback((icon: string, text: string) => {
    const entry: AgentLogEntry = { icon, text, ts: Date.now() };
    setAgentLogEntries(prev => [entry, ...prev].slice(0, 100));
    fetch('/api/agentlog', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entry)
    }).catch(() => {});
  }, []);

  const friendlyName = useCallback((sk: string) => {
    if (!sk) return 'unknown';
    const sess = sessionsRef.current.find(s => getSessionKey(s) === sk);
    if (sess) return getSessionDisplayLabel(sess, agentName);
    if (isSubagentSessionKey(sk)) return 'sub-agent ' + sk.split(':').pop()?.slice(0, 8);
    return sk.split(':').pop() || sk;
  }, [agentName]);

  const rpcRef = useRef(rpc);
  
  useEffect(() => {
    rpcRef.current = rpc;
  }, [rpc]);

  const addEvent = useCallback((msg: GatewayEvent) => {
    const evt = msg.event || 'response';
    const p = (msg.payload || {}) as EventPayload;

    const chatStateDescs: Record<string, string> = {
      delta: 'Response streaming', final: 'Response complete',
      error: 'Chat error', aborted: 'Response aborted',
    };

    let badge = 'SYSTEM', badgeCls = 'badge-system', desc = evt;

    if (evt.startsWith('chat')) {
      badge = 'CHAT'; badgeCls = 'badge-chat';
      desc = chatStateDescs[p.state || ''] || (p.sessionKey ? 'Message from ' + p.sessionKey : 'Chat event');
    } else if (evt.startsWith('agent')) {
      badge = 'AGENT'; badgeCls = 'badge-agent';
      const ap = p as AgentEventPayload;
      if (ap.stream === 'lifecycle') {
        const phase = String((ap.data as Record<string, unknown> | undefined)?.phase || '');
        desc = 'Agent lifecycle: ' + (phase || 'unknown');
      } else if (ap.stream === 'assistant') {
        desc = 'Agent assistant output';
      } else {
        const state = p.state || p.agentState || '';
        desc = state ? 'Agent state: ' + state : 'Agent event';
      }
    } else if (evt.startsWith('cron')) {
      badge = 'CRON'; badgeCls = 'badge-cron';
      desc = p.name ? 'Cron job: ' + p.name : 'Cron job triggered';
    } else if (evt === 'connect.challenge') {
      desc = 'Connection challenge received';
    } else if (evt.startsWith('presence')) {
      desc = 'Presence update';
    } else if (evt.startsWith('exec.approval')) {
      desc = 'Exec approval ' + (evt.includes('request') ? 'requested' : 'resolved');
    } else if (evt.includes('error')) {
      badge = 'ERROR'; badgeCls = 'badge-error';
      desc = (typeof p.message === 'string' ? p.message : p.error) || 'Error occurred';
    }

    setEventEntries(prev => [{ badge, badgeCls, desc, ts: new Date() }, ...prev].slice(0, 50));
  }, []);

  const feedAgentLog = useCallback((evt: string, p: EventPayload) => {
    const sk = p.sessionKey || '';
    const name = friendlyName(sk);
    const isSubagent = isSubagentSessionKey(sk);
    const isMain = isTopLevelAgentSessionKey(sk);

    const processToolBlocks = (blocks: ContentBlock[]) => {
      for (const block of blocks) {
        if (block.type !== 'tool_use' && block.type !== 'toolCall') continue;
        if (!block.name) continue;
        let toolInput: Record<string, unknown> = typeof block.input === 'object' && block.input ? block.input : {};
        if (!toolInput || Object.keys(toolInput).length === 0) {
          const args = block.arguments;
          if (typeof args === 'string') {
            try { toolInput = JSON.parse(args); } catch { toolInput = {}; }
          } else if (typeof args === 'object' && args) {
            toolInput = args;
          }
        }
        const toolId = String(block.id || block.toolCallId || block.name);
        if (shouldLogTool(toolId)) {
          const desc = describeToolUse(block.name, toolInput);
          if (desc) addAgentLogEntry('🔧', desc);
        }
      }
    };

    const processMessages = (msgs: ChatMessage[]) => {
      for (const m of msgs) {
        if (m.role === 'assistant' && Array.isArray(m.content)) {
          processToolBlocks(m.content as ContentBlock[]);
        }
      }
    };

    // Handle lifecycle events from CLI agents (Codex, Claude Code CLI)
    if (evt === 'agent') {
      const ap = p as AgentEventPayload;
      if (ap.stream === 'lifecycle') {
        const phase = (ap.data as Record<string, unknown> | undefined)?.phase;
        if (phase === 'start') {
          logStateRef.current['_conv_' + sk] = true;
          addAgentLogEntry(isMain ? '🧠' : '⚡', isMain ? 'thinking…' : isSubagent ? 'spawned ' + name : name + ' started');
        } else if (phase === 'end') {
          addAgentLogEntry(isMain ? '✦' : '✅', isMain ? 'finished response' : name + ' completed');
          delete logStateRef.current['_conv_' + sk];
        } else if (phase === 'error') {
          addAgentLogEntry('❌', isMain ? 'generation failed' : name + ' failed');
          delete logStateRef.current['_conv_' + sk];
        }
        return;
      }
    }

    if (evt === 'chat') {
      if ((p.state === 'delta' || p.state === 'started') && !logStateRef.current['_conv_' + sk]) {
        logStateRef.current['_conv_' + sk] = true;
        addAgentLogEntry(isMain ? '🧠' : '⚡', isMain ? 'thinking…' : isSubagent ? 'spawned ' + name : name + ' started');
      }
      if (Array.isArray(p.content)) processToolBlocks(p.content as ContentBlock[]);
      if (Array.isArray(p.messages)) processMessages(p.messages as ChatMessage[]);
      if (p.state === 'final') {
        // Do not tail chat.history for every final event. During gateway
        // saturation those tiny tails can keep running server-side for minutes,
        // while the event payload already carries the useful activity-log text.
        addAgentLogEntry(isMain ? '✦' : '✅', isMain ? 'finished response' : name + ' completed');
        delete logStateRef.current['_conv_' + sk];
      } else if (p.state === 'error' || p.state === 'aborted') {
        const icon = p.state === 'error' ? '❌' : '⛔';
        const verb = p.state === 'error' ? 'failed' : 'aborted';
        addAgentLogEntry(icon, isMain ? (p.state === 'error' ? 'generation failed' : 'response aborted') : name + ' ' + verb);
        delete logStateRef.current['_conv_' + sk];
      }
    } else if (evt === 'cron') {
      addAgentLogEntry('⏰', 'cron: ' + (p.name || 'scheduled task fired'));
    } else if (evt === 'connect.challenge') {
      addAgentLogEntry('🔗', 'connected to gateway');
    } else if (evt.includes('error')) {
      addAgentLogEntry('❌', (typeof p.message === 'string' ? p.message : p.error) || 'something went wrong');
    } else if (evt === 'exec.approval.request') {
      addAgentLogEntry('🔐', 'requesting exec approval');
    } else if (evt === 'exec.approval.resolved') {
      addAgentLogEntry('🔓', 'exec approved');
    }
  }, [addAgentLogEntry, friendlyName, shouldLogTool]);

  const refreshSessions = useCallback(async (mode: 'initial' | 'full' = 'full') => {
    if (connectionState !== 'connected') return;
    if (refreshSessionsInFlightRef.current) return;
    refreshSessionsInFlightRef.current = true;
    try {
      const newSessions = await listAuthoritativeSessions(mode);
      const hasLiveSnapshot = sessionsRef.current.length > 0;
      if (newSessions.length === 0 && hasLiveSnapshot) {
        if (!emptySnapshotSeenRef.current) {
          // A single empty poll during gateway degradation should not wipe a
          // previously valid live snapshot. Keep the last known state and try
          // again on the next poll.
          emptySnapshotSeenRef.current = true;
          return;
        }
      }
      emptySnapshotSeenRef.current = false;
      const nextCurrentSession = pickDefaultSessionKey(newSessions, currentSessionRef.current);
      
      // Smart diffing: preserve object references for unchanged sessions.
      // This prevents unnecessary re-renders in child components.
      setSessions(prev => {
        // Fast path: if lengths differ, structure changed
        if (prev.length !== newSessions.length) return newSessions;
        
        // Create lookup for efficient comparison
        const prevMap = new Map(prev.map(s => [getSessionKey(s), s]));
        
        let hasChanges = false;
        const merged = newSessions.map(newSession => {
          const key = getSessionKey(newSession);
          const existing = prevMap.get(key);
          
          // If session doesn't exist in prev, it's new
          if (!existing) {
            hasChanges = true;
            return newSession;
          }
          
          // Compare relevant fields to detect changes
          const changed = (
            existing.state !== newSession.state ||
            existing.totalTokens !== newSession.totalTokens ||
            existing.contextTokens !== newSession.contextTokens ||
            existing.model !== newSession.model ||
            existing.thinking !== newSession.thinking ||
            existing.thinkingLevel !== newSession.thinkingLevel ||
            existing.label !== newSession.label ||
            existing.displayName !== newSession.displayName ||
            existing.parentId !== newSession.parentId
          );
          
          if (changed) {
            hasChanges = true;
            return newSession;
          }
          
          // No change - keep the existing reference
          return existing;
        });
        
        // If nothing changed, return the same array reference
        return hasChanges ? merged : prev;
      });
      setCurrentSession(nextCurrentSession);
      if (mode === 'initial') {
        initialSessionSnapshotLoadedRef.current = true;
      }
    } catch (err) {
      console.debug('[SessionContext] Failed to refresh sessions:', err);
    } finally {
      refreshSessionsInFlightRef.current = false;
      setSessionsLoading(false);
    }
  }, [connectionState, listAuthoritativeSessions, setCurrentSession]);

  useEffect(() => {
    if (connectionState !== 'connected') return;
    if (!currentSession) return;

    const session = currentSessionData;
    if (!session) return;
    if (isSessionActivelyBusy(session, Boolean(busyState[currentSession]))) return;

    const sessionKey = getSessionKey(session);
    const totalTokens = typeof session.totalTokens === 'number' ? session.totalTokens : 0;
    const contextTokens = typeof session.contextTokens === 'number' ? session.contextTokens : 0;

    if (!sessionKey || totalTokens <= 0 || contextTokens <= 0) return;

    const percent = (totalTokens / contextTokens) * 100;
    if (percent < CONTEXT_CRITICAL_THRESHOLD) return;

    const lastTriggeredTokens = autoCompactTokensRef.current[sessionKey] ?? 0;
    if (totalTokens <= lastTriggeredTokens) return;

    autoCompactTokensRef.current[sessionKey] = totalTokens;

    void rpc('sessions.compact', { sessionKey })
      .then(() => {
        // Refresh after compaction so the UI and future threshold checks use the updated token count.
        void refreshSessions();
      })
      .catch((err) => {
        console.debug('[SessionContext] Auto compact failed:', err);
      });
  }, [busyState, connectionState, currentSession, currentSessionData, refreshSessions, rpc]);

  const refreshSessionsRef = useRef(refreshSessions);
  useEffect(() => {
    refreshSessionsRef.current = refreshSessions;
  }, [refreshSessions]);

  // Update session in list from WebSocket event data
  const updateSessionFromEvent = useCallback((sessionKey: string, updates: Partial<Session>) => {
    const normalizedSessionKey = normalizeSessionKey(sessionKey);
    setSessions(prev => {
      const idx = prev.findIndex(s => normalizeSessionKey(getSessionKey(s)) === normalizedSessionKey);
      if (idx === -1) {
        // New session appeared before the full sessions.list call returned.
        // Show it immediately under the owning agent. Coalesced delayed refresh
        // fills in model/token details without launching sessions.list per event.
        const now = Date.now();
        const state = updates.state || updates.agentState || updates.status || 'running';
        const optimisticSession: Session = {
          sessionKey,
          key: sessionKey,
          label: updates.label || (isSubagentSessionKey(sessionKey) ? `Subagent ${sessionKey.split(':').pop()?.slice(0, 8) || ''}` : undefined),
          parentId: updates.parentId || inferParentSessionKey(sessionKey) || undefined,
          state,
          status: updates.status || state,
          agentState: updates.agentState || state,
          updatedAt: now,
          lastActivity: now,
          ...updates,
        };
        return [...prev, optimisticSession];
      }
      
      // Check if the update actually changes anything
      const existing = prev[idx];
      const hasChanges = Object.entries(updates).some(
        ([key, value]) => existing[key as keyof Session] !== value
      );
      
      // If nothing changed, return the same array reference
      if (!hasChanges) return prev;
      
      // Update only the changed session, preserving other references
      return prev.map((s, i) => {
        if (i !== idx) return s;
        return { ...s, ...updates, lastActivity: Date.now() };
      });
    });
  }, []);

  // Extract session updates (state + token data) from a typed agent event payload
  const extractSessionUpdates = useCallback((state: string | undefined, payload: AgentEventPayload | ChatEventPayload): Partial<Session> => {
    const updates: Partial<Session> = {};
    if (state) updates.state = state;
    if ('totalTokens' in payload && typeof payload.totalTokens === 'number') updates.totalTokens = payload.totalTokens;
    if ('contextTokens' in payload && typeof payload.contextTokens === 'number') updates.contextTokens = payload.contextTokens;
    return updates;
  }, []);

  const scheduleDelayedRefresh = useCallback(() => {
    if (delayedRefreshTimeoutRef.current) {
      clearTimeout(delayedRefreshTimeoutRef.current);
    }
    delayedRefreshTimeoutRef.current = setTimeout(() => {
      delayedRefreshTimeoutRef.current = null;
      void refreshSessionsRef.current();
    }, DELAYED_SESSION_REFRESH_MS);
  }, []);

  // Subscribe to gateway events for granular status tracking + session state sync + agent log + event log
  useEffect(() => {
    const unsub = subscribe((msg: GatewayEvent) => {
      const evt = msg.event;
      const p = (msg.payload || {}) as EventPayload;

      addEvent(msg);

      // Session granular status tracking + state sync from agent/chat events
      if ((evt === 'agent' || evt === 'chat') && p.sessionKey) {
        const sk = p.sessionKey;
        const typedPayload = evt === 'agent'
          ? (msg.payload || {}) as AgentEventPayload
          : (msg.payload || {}) as ChatEventPayload;

        // Handle lifecycle events from CLI agents (Codex, Claude Code CLI)
        if (evt === 'agent') {
          const ap = typedPayload as AgentEventPayload;

          if (ap.stream === 'lifecycle') {
            const phase = (ap.data as Record<string, unknown> | undefined)?.phase;
            if (phase === 'start') {
              setGranularStatus(sk, { status: 'THINKING', since: Date.now() });
            } else if (phase === 'end') {
              setGranularStatus(sk, { status: 'DONE', since: Date.now() });
              if (isTopLevelAgentSessionKey(sk)) {
                markSessionUnread(sk);
                pingSession(sk);
              }
              scheduleDelayedRefresh();
            } else if (phase === 'error') {
              setGranularStatus(sk, { status: 'ERROR', since: Date.now() });
              if (isTopLevelAgentSessionKey(sk)) {
                markSessionUnread(sk);
                pingSession(sk);
              }
              scheduleDelayedRefresh();
            }
          } else if (ap.stream === 'tool' && ap.data) {
            if (ap.data.phase === 'start' && ap.data.name) {
              const toolDesc = describeToolUse(ap.data.name, ap.data.args || {});
              setGranularStatus(sk, {
                status: 'THINKING',
                toolName: ap.data.name,
                toolDescription: toolDesc || undefined,
                since: Date.now(),
              });
            } else if (ap.data.phase === 'result') {
              setGranularStatus(sk, { status: 'THINKING', since: Date.now() });
            }
          } else if (ap.stream === 'assistant') {
            setGranularStatus(sk, { status: 'STREAMING', since: Date.now() });
          }
        }

        // Handle chat events
        if (evt === 'chat') {
          const cp = typedPayload as ChatEventPayload;
          const state = cp.state || '';

          if (state === 'started') {
            setGranularStatus(sk, { status: 'THINKING', since: Date.now() });
            if (isTopLevelAgentSessionKey(sk)) {
              markSessionUnread(sk);
            }
          } else if (state === 'delta') {
            setGranularStatus(sk, { status: 'STREAMING', since: Date.now() });
          } else if (state === 'final') {
            setGranularStatus(sk, { status: 'DONE', since: Date.now() });
            if (isTopLevelAgentSessionKey(sk)) {
              markSessionUnread(sk);
              pingSession(sk);
            }
            // Delayed refresh to catch token counts that may not be available immediately.
            scheduleDelayedRefresh();
          } else if (state === 'error') {
            setGranularStatus(sk, { status: 'ERROR', since: Date.now() });
            if (isTopLevelAgentSessionKey(sk)) {
              markSessionUnread(sk);
              pingSession(sk);
            }
          } else if (state === 'aborted') {
            setGranularStatus(sk, { status: 'IDLE', since: Date.now() });
          }
        }

        // Also handle legacy state strings for backward compatibility
        const state = evt === 'agent'
          ? ((typedPayload as AgentEventPayload).state || (typedPayload as AgentEventPayload).agentState || '')
          : ((typedPayload as ChatEventPayload).state || '');

        // Map legacy state strings to granular status (only if not already handled above)
        if (evt === 'agent' && !(typedPayload as AgentEventPayload).stream) {
          if (BUSY_STATES.has(state)) {
            setGranularStatus(sk, { status: 'THINKING', since: Date.now() });
          } else if (IDLE_STATES.has(state)) {
            if (state === 'error') {
              setGranularStatus(sk, { status: 'ERROR', since: Date.now() });
            } else if (state === 'aborted') {
              setGranularStatus(sk, { status: 'IDLE', since: Date.now() });
            } else {
              setGranularStatus(sk, { status: 'DONE', since: Date.now() });
            }
            if (state === 'final' || state === 'done' || state === 'completed') {
              scheduleDelayedRefresh();
            }
          }
        }

        const updates = extractSessionUpdates(state || undefined, typedPayload);
        if (Object.keys(updates).length > 0) {
          updateSessionFromEvent(sk, updates);
        }
      }

      feedAgentLog(evt, p);
    });

    return () => {
      unsub();
    };
  }, [subscribe, addEvent, setGranularStatus, markSessionUnread, pingSession, feedAgentLog, updateSessionFromEvent, extractSessionUpdates, refreshSessions, scheduleDelayedRefresh]);

  useEffect(() => {
    return () => {
      for (const key of Object.keys(doneTimeoutsRef.current)) {
        clearTimeout(doneTimeoutsRef.current[key]);
      }
      doneTimeoutsRef.current = {};
      if (delayedRefreshTimeoutRef.current) {
        clearTimeout(delayedRefreshTimeoutRef.current);
        delayedRefreshTimeoutRef.current = null;
      }
    };
  }, []);

  // Poll sessions only as a fallback. WebSocket events keep the visible tree
  // fresh enough, and avoiding an immediate full refresh on reconnect prevents
  // slow gateway sessions.list calls from stacking behind a saturated gateway.
  useEffect(() => {
    if (connectionState !== 'connected') return;
    if (!initialSessionSnapshotLoadedRef.current) {
      refreshSessions('initial');
    } else {
      setSessionsLoading(false);
    }
    fullRefreshTimeoutRef.current = setTimeout(() => {
      fullRefreshTimeoutRef.current = null;
      void refreshSessionsRef.current('full');
    }, FULL_SESSION_REFRESH_DELAY_MS);

    // Polling is now just a fallback for catching missed updates
    const iv = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      void refreshSessionsRef.current('full');
    }, SESSION_REFRESH_POLL_INTERVAL_MS);
    return () => {
      clearInterval(iv);
      if (fullRefreshTimeoutRef.current) {
        clearTimeout(fullRefreshTimeoutRef.current);
        fullRefreshTimeoutRef.current = null;
      }
    };
  }, [connectionState, refreshSessions]);

  // Load agent log on mount
  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch('/api/agentlog', { signal: controller.signal });
        const entries: AgentLogEntry[] = await res.json();
        setAgentLogEntries(entries.slice().reverse().slice(0, 100));
      } catch (err) {
        if (err instanceof Error && err.name !== 'AbortError') {
          console.debug('[SessionContext] Failed to load agent log:', err.message);
        }
      }
    })();
    return () => controller.abort();
  }, []);

  const deleteSession = useCallback(async (sessionKey: string) => {
    if (isProtectedRootSessionKey(sessionKey)) {
      return;
    }

    const authoritativeSessions = await listAuthoritativeSessions();
    const descendants = findDescendantSessionKeys(sessionKey, authoritativeSessions);
    const keysToDelete = [...descendants, sessionKey];
    const shouldReplaceCurrent = keysToDelete.includes(currentSessionRef.current);
    const remaining = sessionsRef.current.filter(s => !keysToDelete.includes(getSessionKey(s)));
    const nextCurrentSession = shouldReplaceCurrent ? pickDefaultSessionKey(remaining) : currentSessionRef.current;

    try {
      const res = await fetch('/api/sessions/delete-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keys: keysToDelete }),
      });
      const data = await res.json() as { ok?: boolean; failed?: string[]; error?: string };
      if (!res.ok || !data.ok) {
        throw new Error(data.error || 'Delete failed');
      }
    } catch (err) {
      console.debug('[SessionContext] Failed to delete session(s):', err);
      throw err;
    }

    setSessions(prev => prev.filter(s => !keysToDelete.includes(getSessionKey(s))));
    if (unreadSessionKeysRef.current.size > 0) {
      const next = new Set(unreadSessionKeysRef.current);
      for (const key of keysToDelete) next.delete(key);
      unreadSessionKeysRef.current = next;
      setUnreadSessionKeys(next);
    }
    if (shouldReplaceCurrent) {
      setCurrentSession(nextCurrentSession);
    }
  }, [findDescendantSessionKeys, listAuthoritativeSessions, setCurrentSession]);

  // Bulk reset stays on the canonical delete RPC so backend transcript cleanup remains consistent.
  const deleteAllSessions = useCallback(async () => {
    const keysToDelete = sessionsRef.current
      .map((session) => getSessionKey(session))
      .filter((sessionKey): sessionKey is string => Boolean(sessionKey))
      .filter((sessionKey) => !isProtectedRootSessionKey(sessionKey))
      .sort((a, b) => {
        const depthDiff = b.split(':').length - a.split(':').length;
        return depthDiff !== 0 ? depthDiff : a.localeCompare(b);
      });

    if (keysToDelete.length === 0) {
      setCurrentSession('');
      return;
    }

    try {
      const res = await fetch('/api/sessions/delete-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keys: keysToDelete }),
      });
      const data = await res.json() as { ok?: boolean; failed?: string[]; error?: string };
      if (!res.ok || !data.ok) {
        throw new Error(data.error || 'Bulk delete failed');
      }

      for (const key of keysToDelete) {
        const timeout = doneTimeoutsRef.current[key];
        if (timeout) {
          clearTimeout(timeout);
          delete doneTimeoutsRef.current[key];
        }
      }
    } catch (err) {
      console.error('[SessionContext] Bulk delete request failed:', err);
      await refreshSessions();
      return;
    }

    setSessions([]);
    setAgentStatus({});
    if (unreadSessionKeysRef.current.size > 0) {
      unreadSessionKeysRef.current = new Set<string>();
      setUnreadSessionKeys(new Set<string>());
    }
    setCurrentSession('');
  }, [refreshSessions, setCurrentSession]);

  const spawnSession = useCallback(async (opts: SpawnSessionOpts) => {
    const authoritativeSessions = await listAuthoritativeSessions();

    if (opts.kind === 'root') {
      const rootName = opts.agentName?.trim();
      if (!rootName) throw new Error('Agent name is required');

      const sessionKey = buildAgentRootSessionKey(
        rootName,
        authoritativeSessions.map(getSessionKey),
      );
      // Register agent in config (ignore if already registered)
      const agentId = getRootAgentId(sessionKey);
      const registrationName = getAgentRegistrationName(rootName, sessionKey);
      try {
        await rpc('agents.create', { name: registrationName, workspace: `~/.openclaw/workspace-${agentId}` });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes('already exists')) throw err;
      }
      const thinkingLevel = opts.thinking && opts.thinking !== 'off' ? opts.thinking : null;

      await rpc('sessions.patch', {
        key: sessionKey,
        label: rootName,
        model: opts.model,
        thinkingLevel,
      });

      const idempotencyKey = `spawn-root-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await rpc('chat.send', {
        sessionKey,
        message: opts.task,
        deliver: false,
        idempotencyKey,
      });

      await refreshSessions();
      setCurrentSession(sessionKey);
      return;
    }

    const fallbackRootSession = getTopLevelAgentSessions(sessionsRef.current)[0];
    const parentSessionKey = opts.parentSessionKey
      || getRootAgentSessionKey(currentSessionRef.current)
      || (fallbackRootSession ? getSessionKey(fallbackRootSession) : '');
    if (!parentSessionKey) {
      throw new Error('Create a top-level agent before launching a subagent');
    }

    const res = await fetch('/api/sessions/spawn-subagent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        parentSessionKey,
        task: opts.task,
        label: opts.label,
        model: opts.model,
        thinking: opts.thinking,
        cleanup: opts.cleanup ?? 'keep',
      }),
    });

    const data = await res.json() as { ok: boolean; sessionKey?: string; error?: string };
    if (!data.ok || !data.sessionKey) {
      throw new Error(data.error ?? 'Failed to spawn subagent');
    }

    await refreshSessions();
    setCurrentSession(data.sessionKey);
  }, [listAuthoritativeSessions, rpc, refreshSessions, setCurrentSession]);

  const renameSession = useCallback(async (sessionKey: string, label: string) => {
    await rpc('sessions.patch', { key: sessionKey, label });
    updateSessionFromEvent(sessionKey, { label });
  }, [rpc, updateSessionFromEvent]);

  const abortSession = useCallback(async (sessionKey: string) => {
    try {
      await rpc('chat.abort', { sessionKey });
    } catch (err) {
      console.error('[SessionContext] Failed to abort session:', err);
    }
  }, [rpc]);

  const value = useMemo<SessionContextValue>(() => ({
    sessions,
    sessionsLoading,
    agents,
    agentsLoading,
    currentSession,
    setCurrentSession,
    busyState,
    agentStatus,
    unreadSessions,
    markSessionRead,
    abortSession,
    refreshSessions,
    deleteSession,
    deleteAllSessions,
    spawnSession,
    renameSession,
    updateSession: updateSessionFromEvent,
    agentLogEntries,
    eventEntries,
    agentName,
  }), [
    sessions, sessionsLoading, agents, agentsLoading, currentSession, setCurrentSession, busyState, agentStatus,
    unreadSessions, markSessionRead,
    abortSession, refreshSessions, deleteSession, deleteAllSessions, spawnSession, renameSession,
    updateSessionFromEvent, agentLogEntries, eventEntries, agentName,
  ]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSessionContext() {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSessionContext must be used within SessionProvider');
  return ctx;
}
