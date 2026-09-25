/**
 * App.tsx - Main application layout component
 * 
 * This component focuses on layout and composition.
 * Connection management is handled by useConnectionManager.
 * Dashboard data fetching is handled by useDashboardData.
 */
import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
  useReducer,
  lazy,
  Suspense,
  type ReactNode,
} from 'react';
import { AlertTriangle, CheckCircle2, Minus, Plus, RotateCw, Volume2 } from 'lucide-react';
import { useGateway } from '@/contexts/GatewayContext';
import { useSessionContext, type SpawnSessionOpts } from '@/contexts/SessionContext';
import { useChat } from '@/contexts/ChatContext';
import { useSettings, type STTInputMode } from '@/contexts/SettingsContext';
import { getSessionKey, type Session } from '@/types';
import { useConnectionManager } from '@/hooks/useConnectionManager';
import { useDashboardData } from '@/hooks/useDashboardData';
import { useGatewayRestart } from '@/hooks/useGatewayRestart';
import { ApprovalBanner, useApprovals } from '@/features/approvals';
import { TopBar } from '@/components/TopBar';
import { StatusBar } from '@/components/StatusBar';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { WorkspaceSwitchDialog } from '@/components/WorkspaceSwitchDialog';
import { ChatPanel, type ChatPanelHandle } from '@/features/chat/ChatPanel';
import type { TTSProvider } from '@/features/tts/useTTS';
import type { ViewMode } from '@/features/command-palette/commands';
import { ResizablePanels } from '@/components/ResizablePanels';
import { getContextLimit } from '@/lib/constants';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { createCommands } from '@/features/command-palette/commands';
import { PanelErrorBoundary } from '@/components/PanelErrorBoundary';
import { SpawnAgentDialog } from '@/features/sessions/SpawnAgentDialog';
import { DEFAULT_CHAT_PATH_LINKS_CONFIG, parseChatPathLinksConfig } from '@/features/chat/chatPathLinks';
import { FileTreePanel, TabbedContentArea, useOpenFiles, type FileTreeChangeEvent } from '@/features/file-browser';
import { isImageFile } from '@/features/file-browser/utils/fileTypes';
import { buildAgentRootSessionKey, getSessionDisplayLabel, isLegacyJaneSessionKey, JANE_DIRECT_CHAT_SESSION_KEY, JANE_LIVE_VOICE_SESSION_KEY } from '@/features/sessions/sessionKeys';
import { shouldGuardWorkspaceSwitch } from '@/features/workspace/workspaceSwitchGuard';
import { getWorkspaceAgentId, getWorkspaceRootSessionKey } from '@/features/workspace/workspaceScope';
import { ProposalInbox } from '@/features/kanban/ProposalInbox';
import { useProposals } from '@/features/kanban/hooks/useProposals';
import { useAgentSuggestedTasks } from '@/features/kanban/hooks/useAgentSuggestedTasks';

// Lazy-loaded features (not needed in initial bundle)
const SettingsDrawer = lazy(() => import('@/features/settings/SettingsDrawer').then(m => ({ default: m.SettingsDrawer })));
const CommandPalette = lazy(() => import('@/features/command-palette/CommandPalette').then(m => ({ default: m.CommandPalette })));

// Lazy-loaded side panels
const SessionList = lazy(() => import('@/features/sessions/SessionList').then(m => ({ default: m.SessionList })));
const WorkspacePanel = lazy(() => import('@/features/workspace/WorkspacePanel').then(m => ({ default: m.WorkspacePanel })));

// Lazy-loaded view modes
const KanbanPanel = lazy(() => import('@/features/kanban/KanbanPanel').then(m => ({ default: m.KanbanPanel })));
const FinancePanel = lazy(() => import('@/features/finance/FinancePanel').then(m => ({ default: m.FinancePanel })));
const AgentsView = lazy(() => import('@/features/agents/AgentsView').then(m => ({ default: m.AgentsView })));
const TargetBoardModal = lazy(() => import('@/features/kanban/TargetBoardModal').then(m => ({ default: m.TargetBoardModal })));

interface AppProps {
  onLogout?: () => void;
}

interface PendingWorkspaceSwitch {
  targetLabel: string;
  execute: () => Promise<void>;
  resolve: (didSwitch: boolean) => void;
  reject: (error: unknown) => void;
}

type RightPanelKey = 'proposals' | 'agents' | 'workspace';

function CollapsibleRightPanel({
  id,
  title,
  count,
  collapsed,
  railCollapsed,
  onToggle,
  children,
}: {
  id: RightPanelKey;
  title: string;
  count?: number;
  collapsed: boolean;
  railCollapsed: boolean;
  onToggle: (id: RightPanelKey) => void;
  children: ReactNode;
}) {
  return (
    <section
      className={`shell-panel flex min-h-0 flex-col overflow-hidden rounded-[28px] transition-[flex-basis,height] ${
        collapsed ? 'shrink-0' : 'flex-1'
      }`}
      aria-label={title}
      data-testid={`right-panel-${id}`}
      data-collapsed={collapsed}
    >
      <div className={`flex shrink-0 items-center gap-2 border-b border-border/50 bg-secondary/35 px-3 py-2.5 ${railCollapsed ? 'justify-center' : 'justify-between'}`}>
        {!railCollapsed && (
          <div className="cockpit-kicker min-w-0">
            <span className="text-primary">◆</span>
            <span className="truncate">{title}</span>
            {typeof count === 'number' && (
              <span className="ml-2 rounded-full border border-primary/35 bg-primary/10 px-2 py-0.5 font-mono text-[0.667rem] text-primary">
                {count}
              </span>
            )}
          </div>
        )}
        <button
          type="button"
          onClick={() => onToggle(id)}
          className="shell-icon-button size-9 shrink-0 px-0"
          aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${title}`}
          title={`${collapsed ? 'Expand' : 'Collapse'} ${title}`}
        >
          {collapsed ? <Plus size={14} /> : <Minus size={14} />}
        </button>
      </div>
      {!collapsed && (
        <div className="min-h-0 flex-1 overflow-hidden">
          {children}
        </div>
      )}
    </section>
  );
}

function buildWorkspaceSwitchErrorMessage(result: {
  failedPath?: string;
  conflict?: boolean;
}): string {
  const fileLabel = result.failedPath || 'a dirty file';
  if (result.conflict) {
    return `${fileLabel} changed on disk. Resolve it before switching agents.`;
  }
  return `Could not save ${fileLabel}. Resolve it before switching agents.`;
}

function getInitialViewMode(canShowKanban: boolean): ViewMode {
  try {
    const saved = localStorage.getItem('nerve:viewMode');
    if (saved === 'kanban' && canShowKanban) return 'kanban';
    if (saved === 'agents') return 'agents';
    if (saved === 'finance') return 'finance';
  } catch {
    // ignore storage errors
  }

  return 'chat';
}

function getSessionTokenTotal(session: Session | undefined): number {
  if (!session) return 0;
  if (typeof session.totalTokens === 'number' && session.totalTokens > 0) {
    return session.totalTokens;
  }

  const inputTokens = typeof session.inputTokens === 'number' ? session.inputTokens : 0;
  const outputTokens = typeof session.outputTokens === 'number' ? session.outputTokens : 0;
  return inputTokens + outputTokens;
}

export default function App({ onLogout }: AppProps) {
  // Gateway state
  const {
    connectionState, model, sparkline,
  } = useGateway();
  const approvalState = useApprovals();

  // Session state
  const {
    sessions, sessionsLoading, currentSession, setCurrentSession,
    busyState, agentStatus, unreadSessions, refreshSessions, deleteSession, deleteAllSessions, abortSession, spawnSession, renameSession,
    agentLogEntries, eventEntries,
    agentName,
    agents,
  } = useSessionContext();

  // Chat state
  const {
    messages, isGenerating, stream, processingStage,
    lastEventTimestamp, activityLog, currentToolDescription,
    handleSend, handleLiveTranscript, handleAbort, handleReset,
    loadMore, hasMore,
    showResetConfirm, confirmReset, cancelReset,
  } = useChat();

  // Settings state
  const {
    soundEnabled, toggleSound, voiceReadbackEnabled, toggleVoiceReadback, voicePlaybackUnlocked, unlockVoicePlayback,
    ttsProvider, ttsModel, setTtsProvider, setTtsModel,
    sttProvider, setSttProvider, sttInputMode, setSttInputMode, sttModel, setSttModel,
    wakeWordEnabled, handleToggleWakeWord, handleWakeWordState,
    liveTranscriptionPreview, toggleLiveTranscriptionPreview, continuousVoiceEnabled, toggleContinuousVoice, liveVoicePauseMs, setLiveVoicePauseMs, wakeVoicePauseMs, setWakeVoicePauseMs,
    stopSpeaking, isTtsSpeaking,
    panelRatio, setPanelRatio,
    eventsVisible, logVisible,
    toggleEvents, toggleLog, toggleTelemetry,
    setTheme, setFont,
    kanbanVisible,
  } = useSettings();

  // Connection management (extracted hook)
  const {
    editableUrl, setEditableUrl,
    editableToken, setEditableToken,
    handleReconnect,
  } = useConnectionManager();

  // Track file change events for tree refresh. Sequence keeps repeated same-path updates visible.
  const [lastChangedEvent, setLastChangedEvent] = useState<FileTreeChangeEvent | null>(null);
  const [revealRequest, setRevealRequest] = useState<{
    id: number;
    path: string;
    kind: 'file' | 'directory';
    agentId: string;
  } | null>(null);
  const [accountabilityOpen, setAccountabilityOpen] = useState(false);
  const fileTreeChangeSequenceRef = useRef(0);

  const initialCompactLayout = typeof window !== 'undefined' && window.matchMedia('(max-width: 900px)').matches;
  const initialDesktopFileBrowserCollapsed = (() => {
    try {
      const saved = localStorage.getItem('nerve-file-tree-collapsed');
      if (saved !== null) return saved === 'true';
    } catch {
      // ignore storage errors and fall back to desktop default
    }

    return true;
  })();

  // File browser collapse state for mobile optimization
  const [fileBrowserCollapsed, setFileBrowserCollapsedState] = useState(() => (
    initialCompactLayout ? true : initialDesktopFileBrowserCollapsed
  ));
  const [desktopFileBrowserCollapsed, setDesktopFileBrowserCollapsed] = useState(initialDesktopFileBrowserCollapsed);

  // Responsive layout state (chat-first on smaller viewports)
  const [isCompactLayout, setIsCompactLayout] = useState(initialCompactLayout);

  const persistDesktopFileBrowserCollapsed = useCallback((collapsed: boolean) => {
    setDesktopFileBrowserCollapsed(collapsed);

    try {
      localStorage.setItem('nerve-file-tree-collapsed', String(collapsed));
    } catch {
      // ignore storage errors
    }
  }, []);

  const setFileBrowserCollapsed = useCallback((nextCollapsed: boolean | ((prev: boolean) => boolean)) => {
    setFileBrowserCollapsedState(prevCollapsed => {
      const resolvedCollapsed = typeof nextCollapsed === 'function'
        ? nextCollapsed(prevCollapsed)
        : nextCollapsed;

      if (!isCompactLayout) {
        persistDesktopFileBrowserCollapsed(resolvedCollapsed);
      }

      return resolvedCollapsed;
    });
  }, [isCompactLayout, persistDesktopFileBrowserCollapsed]);

  /** Toggle file browser collapse state (mobile). */
  const handleToggleFileBrowser = useCallback(() => {
    setFileBrowserCollapsed(prev => !prev);
  }, [setFileBrowserCollapsed]);

  const workspaceAgentId = useMemo(() => getWorkspaceAgentId(currentSession), [currentSession]);

  // File browser state
  const {
    openFiles, activeTab, setActiveTab,
    openFile, closeFile, updateContent, saveFile, reloadFile,
    handleFileChanged, remapOpenPaths, closeOpenPathsByPrefix,
    hasDirtyFiles, saveAllDirtyFiles, discardAllDirtyFiles,
  } = useOpenFiles(workspaceAgentId);

  // Save with workspace-scoped conflict toast
  const [saveToast, setSaveToast] = useState<{
    agentId: string;
    path: string;
    type: 'conflict';
    workspaceVersion: number;
  } | null>(null);
  const [workspaceVersion, bumpWorkspaceVersion] = useReducer((version: number) => version + 1, 0);
  const saveToastTimerRef = useRef<number | null>(null);
  const workspaceAgentIdRef = useRef(workspaceAgentId);
  const [pendingWorkspaceSwitch, setPendingWorkspaceSwitch] = useState<PendingWorkspaceSwitch | null>(null);
  const [workspaceSwitchAction, setWorkspaceSwitchAction] = useState<'save' | 'discard' | null>(null);
  const [workspaceSwitchError, setWorkspaceSwitchError] = useState<string | null>(null);

  const clearSaveToastTimer = useCallback(() => {
    if (saveToastTimerRef.current !== null) {
      window.clearTimeout(saveToastTimerRef.current);
      saveToastTimerRef.current = null;
    }
  }, []);

  const dismissSaveToast = useCallback(() => {
    clearSaveToastTimer();
    setSaveToast(null);
  }, [clearSaveToastTimer]);

  const showSaveToastForAgent = useCallback((
    targetAgentId: string,
    nextToast: { path: string; type: 'conflict' },
  ) => {
    if (workspaceAgentIdRef.current !== targetAgentId) return;

    clearSaveToastTimer();
    const toastForAgent = {
      ...nextToast,
      agentId: targetAgentId,
      workspaceVersion,
    };
    setSaveToast(toastForAgent);
    saveToastTimerRef.current = window.setTimeout(() => {
      setSaveToast((currentToast) => (currentToast === toastForAgent ? null : currentToast));
      saveToastTimerRef.current = null;
    }, 5000);
  }, [clearSaveToastTimer, workspaceVersion]);

  useEffect(() => {
    workspaceAgentIdRef.current = workspaceAgentId;
    bumpWorkspaceVersion();
    clearSaveToastTimer();
  }, [clearSaveToastTimer, workspaceAgentId]);

  useEffect(() => () => clearSaveToastTimer(), [clearSaveToastTimer]);

  const handleSaveFile = useCallback(async (filePath: string) => {
    const requestAgentId = workspaceAgentId;
    const result = await saveFile(filePath);

    if (workspaceAgentIdRef.current !== requestAgentId) {
      return;
    }

    if (!result.ok) {
      if (result.conflict) {
        showSaveToastForAgent(requestAgentId, { path: filePath, type: 'conflict' });
      }
      return;
    }

    dismissSaveToast();
  }, [dismissSaveToast, saveFile, showSaveToastForAgent, workspaceAgentId]);

  // Single file.changed handler, feeds both open files and tree refresh.
  const onFileChanged = useCallback((path: string, targetAgentId: string) => {
    handleFileChanged(path, targetAgentId);
    setLastChangedEvent({
      path,
      agentId: targetAgentId,
      sequence: ++fileTreeChangeSequenceRef.current,
    });
  }, [handleFileChanged]);

  // Dashboard data (extracted hook) — single SSE connection handles all events
  const { memories, memoriesLoading, tokenData, remoteWorkspace, refreshMemories } = useDashboardData({
    agentId: workspaceAgentId,
    onFileChanged,
  });

  // UI state
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [booted, setBooted] = useState(false);
  const [logGlow, setLogGlow] = useState(false);
  const [isMobileTopBarHidden, setIsMobileTopBarHidden] = useState(false);
  const [desktopRightPanelWidth, setDesktopRightPanelWidth] = useState<number | null>(null);
  const [rightPanelCollapsed, setRightPanelCollapsed] = useState<Record<RightPanelKey, boolean>>({
    proposals: false,
    agents: false,
    workspace: false,
  });
  const prevLogCount = useRef(0);
  const chatPanelRef = useRef<ChatPanelHandle>(null);
  const {
    proposals,
    pendingCount: pendingProposalCount,
    approveProposal,
    rejectProposal,
    rejectBackgroundProposals,
  } = useProposals();
  const { tasks: suggestedTasks } = useAgentSuggestedTasks();
  const [kanbanFocusTaskId, setKanbanFocusTaskId] = useState<string | null>(null);
  const allRightPanelsCollapsed = rightPanelCollapsed.proposals && rightPanelCollapsed.agents && rightPanelCollapsed.workspace;
  const rightRailWidthPx = allRightPanelsCollapsed ? 72 : (fileBrowserCollapsed ? desktopRightPanelWidth : null);

  const toggleRightPanel = useCallback((panel: RightPanelKey) => {
    setRightPanelCollapsed(prev => ({ ...prev, [panel]: !prev[panel] }));
  }, []);

  // Gateway restart
  const {
    showGatewayRestartConfirm,
    gatewayRestarting,
    gatewayRestartNotice,
    handleGatewayRestart,
    cancelGatewayRestart,
    confirmGatewayRestart,
    dismissNotice,
  } = useGatewayRestart();

  // Command palette state
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [spawnDialogOpen, setSpawnDialogOpen] = useState(false);

  // View mode state (chat | kanban), persisted to localStorage
  const [viewMode, setViewModeRaw] = useState<ViewMode>(() => getInitialViewMode(kanbanVisible));
  const setViewMode = useCallback((mode: ViewMode) => {
    const nextMode = mode === 'kanban' && !kanbanVisible ? 'chat' : mode;
    setViewModeRaw(nextMode);

    if (nextMode !== 'chat' && isCompactLayout) {
      setFileBrowserCollapsed(true);
    }

    try { localStorage.setItem('nerve:viewMode', nextMode); } catch { /* ignore */ }
  }, [isCompactLayout, kanbanVisible, setFileBrowserCollapsed]);
  const [chatPathLinkPrefixes, setChatPathLinkPrefixes] = useState<string[]>(
    DEFAULT_CHAT_PATH_LINKS_CONFIG.prefixes,
  );

  useEffect(() => {
    const params = new URLSearchParams({ agentId: workspaceAgentId });
    const controller = new AbortController();

    void fetch(`/api/workspace/chatPathLinks?${params.toString()}`, { signal: controller.signal })
      .then(async (res) => {
        if (res.status === 404) {
          setChatPathLinkPrefixes(DEFAULT_CHAT_PATH_LINKS_CONFIG.prefixes);
          return;
        }
        const data = await res.json() as { ok: boolean; content?: string };
        if (!data.ok || !data.content) {
          setChatPathLinkPrefixes(DEFAULT_CHAT_PATH_LINKS_CONFIG.prefixes);
          return;
        }
        const parsed = parseChatPathLinksConfig(data.content);
        setChatPathLinkPrefixes(parsed.prefixes);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setChatPathLinkPrefixes(DEFAULT_CHAT_PATH_LINKS_CONFIG.prefixes);
        }
      });

    return () => controller.abort();
  }, [workspaceAgentId]);

  useEffect(() => {
    if (kanbanVisible || viewMode !== 'kanban') return;
    setViewMode('chat');
  }, [kanbanVisible, setViewMode, viewMode]);

  const openWorkspacePath = useCallback(async (targetPath: string, basePath?: string) => {
    const params = new URLSearchParams({ path: targetPath, agentId: workspaceAgentId });
    if (basePath) {
      params.set('relativeTo', basePath);
    }
    const res = await fetch(`/api/files/resolve?${params.toString()}`);
    const data = await res.json().catch(() => null) as {
      ok?: boolean;
      path?: string;
      type?: 'file' | 'directory';
      binary?: boolean;
    } | null;

    if (!res.ok || !data?.ok || !data.path || !data.type) return;

    setFileBrowserCollapsed(false);
    setRevealRequest({ id: Date.now(), path: data.path, kind: data.type, agentId: workspaceAgentId });

    if (data.type === 'file' && (!data.binary || isImageFile(data.path))) {
      await openFile(data.path);
    }
  }, [openFile, setFileBrowserCollapsed, workspaceAgentId]);

  const openTargetSection = useCallback(async (path: string) => {
    setAccountabilityOpen(false);
    await openFile(path);
    setActiveTab(path);
  }, [openFile, setActiveTab]);

  const toggleMobileTopBar = useCallback(() => {
    setIsMobileTopBarHidden((prev) => !prev);
  }, []);

  // Build command list with stable references
  const openSettings = useCallback(() => setSettingsOpen(true), []);
  const openSearch = useCallback(() => setSearchOpen(true), []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  const closeSearch = useCallback(() => setSearchOpen(false), []);
  const closePalette = useCallback(() => setPaletteOpen(false), []);

  const openSpawnDialog = useCallback(() => setSpawnDialogOpen(true), []);

  const commands = useMemo(() => createCommands({
    onNewSession: openSpawnDialog,
    onResetSession: handleReset,
    onToggleSound: toggleSound,
    onSettings: openSettings,
    onSearch: openSearch,
    onAbort: handleAbort,
    onSetTheme: setTheme,
    onSetFont: setFont,
    onTtsProviderChange: setTtsProvider,
    onToggleWakeWord: handleToggleWakeWord,
    onToggleEvents: toggleEvents,
    onToggleLog: toggleLog,
    onToggleTelemetry: toggleTelemetry,
    onOpenSettings: openSettings,
    onRefreshSessions: refreshSessions,
    onRefreshMemory: refreshMemories,
    onSetViewMode: setViewMode,
    canShowKanban: kanbanVisible,
  }), [openSpawnDialog, handleReset, toggleSound, handleAbort, openSettings, openSearch,
    setTheme, setFont, setTtsProvider, handleToggleWakeWord, toggleEvents, toggleLog, toggleTelemetry,
    refreshSessions, refreshMemories, setViewMode, kanbanVisible]);

  // Keyboard shortcut handlers with useCallback
  const handleOpenPalette = useCallback(() => setPaletteOpen(true), []);
  const handleCtrlC = useCallback(() => {
    if (isGenerating) {
      handleAbort();
    }
  }, [isGenerating, handleAbort]);
  const toggleSearch = useCallback(() => setSearchOpen(prev => !prev), []);
  const handleEscape = useCallback(() => {
    if (paletteOpen) {
      setPaletteOpen(false);
    } else if (searchOpen) {
      setSearchOpen(false);
    } else if (isGenerating) {
      handleAbort();
    }
  }, [paletteOpen, searchOpen, isGenerating, handleAbort]);

  // Global keyboard shortcuts
  useKeyboardShortcuts([
    { key: 'k', meta: true, handler: handleOpenPalette },
    { key: 'b', meta: true, handler: handleToggleFileBrowser },  // Cmd+B → toggle file browser
    { key: 'f', meta: true, handler: toggleSearch, skipInEditor: true },  // Cmd+F → chat search (yields to CodeMirror search in editor)
    { key: 'c', ctrl: true, handler: handleCtrlC, preventDefault: false },  // Ctrl+C → abort (when generating), allow copy to still work
    { key: 'Escape', handler: handleEscape, skipInEditor: true },
  ]);

  // Get current session's context usage for StatusBar
  const currentSessionData = useMemo(() => {
    return sessions.find(s => getSessionKey(s) === currentSession);
  }, [sessions, currentSession]);

  // Get display name for current session (agent name for main, label for subagents)
  const currentSessionDisplayName = useMemo(() => {
    if (currentSessionData) return getSessionDisplayLabel(currentSessionData, agentName);
    return agentName;
  }, [currentSessionData, agentName]);

  const contextTokens = getSessionTokenTotal(currentSessionData);
  const contextLimit = currentSessionData?.contextTokens || getContextLimit(model);

  const getWorkspaceSwitchLabel = useCallback((sessionKey: string) => {
    const targetSession = sessions.find((session) => getSessionKey(session) === sessionKey);
    if (targetSession) {
      return getSessionDisplayLabel(targetSession, agentName);
    }

    const targetAgentId = getWorkspaceAgentId(sessionKey);
    return targetAgentId === 'main' ? `${agentName} (main)` : `Agent ${targetAgentId}`;
  }, [agentName, sessions]);

  const requestWorkspaceTransition = useCallback((
    targetSessionKey: string,
    targetLabel: string,
    execute: () => Promise<void>,
  ) => {
    if (!shouldGuardWorkspaceSwitch(currentSession, targetSessionKey, hasDirtyFiles)) {
      return execute().then(() => true);
    }

    setWorkspaceSwitchAction(null);
    setWorkspaceSwitchError(null);

    return new Promise<boolean>((resolve, reject) => {
      setPendingWorkspaceSwitch({
        targetLabel,
        execute,
        resolve,
        reject,
      });
    });
  }, [currentSession, hasDirtyFiles]);

  const handleCancelWorkspaceSwitch = useCallback(() => {
    if (workspaceSwitchAction || !pendingWorkspaceSwitch) return;

    pendingWorkspaceSwitch.resolve(false);
    setPendingWorkspaceSwitch(null);
    setWorkspaceSwitchAction(null);
    setWorkspaceSwitchError(null);
  }, [pendingWorkspaceSwitch, workspaceSwitchAction]);

  const handleSaveAndSwitch = useCallback(async () => {
    if (!pendingWorkspaceSwitch || workspaceSwitchAction) return;

    const pendingSwitch = pendingWorkspaceSwitch;
    setWorkspaceSwitchAction('save');
    setWorkspaceSwitchError(null);

    const result = await saveAllDirtyFiles();
    if (!result.ok) {
      setWorkspaceSwitchAction(null);
      setWorkspaceSwitchError(buildWorkspaceSwitchErrorMessage(result));
      return;
    }

    try {
      await pendingSwitch.execute();
      pendingSwitch.resolve(true);
      setPendingWorkspaceSwitch(null);
      setWorkspaceSwitchError(null);
    } catch (error) {
      pendingSwitch.reject(error);
      setPendingWorkspaceSwitch(null);
      setWorkspaceSwitchError(null);
    } finally {
      setWorkspaceSwitchAction(null);
    }
  }, [pendingWorkspaceSwitch, saveAllDirtyFiles, workspaceSwitchAction]);

  const handleDiscardAndSwitch = useCallback(async () => {
    if (!pendingWorkspaceSwitch || workspaceSwitchAction) return;

    const pendingSwitch = pendingWorkspaceSwitch;
    setWorkspaceSwitchAction('discard');
    setWorkspaceSwitchError(null);
    discardAllDirtyFiles();

    try {
      await pendingSwitch.execute();
      pendingSwitch.resolve(true);
      setPendingWorkspaceSwitch(null);
      setWorkspaceSwitchError(null);
    } catch (error) {
      pendingSwitch.reject(error);
      setPendingWorkspaceSwitch(null);
      setWorkspaceSwitchError(null);
    } finally {
      setWorkspaceSwitchAction(null);
    }
  }, [discardAllDirtyFiles, pendingWorkspaceSwitch, workspaceSwitchAction]);

  const handleSessionChange = useCallback((key: string) => {
    void requestWorkspaceTransition(key, getWorkspaceSwitchLabel(key), async () => {
      setCurrentSession(key);
    });
  }, [getWorkspaceSwitchLabel, requestWorkspaceTransition, setCurrentSession]);

  const handleOpenJaneChat = useCallback(() => {
    setViewMode('chat');
    handleSessionChange(JANE_DIRECT_CHAT_SESSION_KEY);
  }, [handleSessionChange, setViewMode]);

  const handleOpenAgentSession = useCallback((sessionKey: string) => {
    setViewMode('chat');
    handleSessionChange(sessionKey);
  }, [handleSessionChange, setViewMode]);

  const handleOpenAgentTask = useCallback((taskId: string) => {
    setKanbanFocusTaskId(taskId);
    setViewMode('kanban');
  }, [setViewMode]);

  const handleSpawnSession = useCallback((opts: SpawnSessionOpts) => {
    const targetSessionKey = opts.kind === 'root'
      ? buildAgentRootSessionKey(opts.agentName?.trim() || 'agent', sessions.map(getSessionKey))
      : opts.parentSessionKey?.trim() || getWorkspaceRootSessionKey(currentSession) || currentSession;
    const targetLabel = opts.kind === 'root'
      ? opts.agentName?.trim() || 'New agent'
      : getWorkspaceSwitchLabel(targetSessionKey);

    return requestWorkspaceTransition(targetSessionKey, targetLabel, async () => {
      await spawnSession(opts);
    });
  }, [currentSession, getWorkspaceSwitchLabel, requestWorkspaceTransition, sessions, spawnSession]);

  // Boot sequence: fade in panels when connected
  useEffect(() => {
    if (connectionState === 'connected' && !booted) {
      const timer = setTimeout(() => setBooted(true), 50);
      return () => clearTimeout(timer);
    }
  }, [connectionState, booted]);

  // Log header glow when new entries arrive
  // This effect legitimately needs to set state in response to prop changes
  // (visual feedback for new log entries)
  useEffect(() => {
    const currentCount = agentLogEntries.length;
    if (currentCount > prevLogCount.current) {
      setLogGlow(true);
      const timer = setTimeout(() => setLogGlow(false), 500);
      prevLogCount.current = currentCount;
      return () => clearTimeout(timer);
    }
    prevLogCount.current = currentCount;
  }, [agentLogEntries.length]);

  const handleCompactLayoutChange = useCallback((nextIsCompactLayout: boolean) => {
    setIsCompactLayout(nextIsCompactLayout);
    if (!nextIsCompactLayout) {
      setIsMobileTopBarHidden(false);
    }
    setFileBrowserCollapsedState(prevCollapsed => {
      if (nextIsCompactLayout) {
        persistDesktopFileBrowserCollapsed(prevCollapsed);
        return true;
      }

      return desktopFileBrowserCollapsed;
    });
  }, [desktopFileBrowserCollapsed, persistDesktopFileBrowserCollapsed]);

  // Responsive mode: switch to chat-first layout on smaller screens
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const mq = window.matchMedia('(max-width: 900px)');
    const onChange = (event: MediaQueryListEvent) => {
      handleCompactLayoutChange(event.matches);
    };

    if (mq.addEventListener) {
      mq.addEventListener('change', onChange);
      return () => mq.removeEventListener('change', onChange);
    }

    // Safari fallback
    mq.addListener(onChange);
    return () => mq.removeListener(onChange);
  }, [handleCompactLayoutChange]);

  // Handlers for TTS provider/model changes
  const handleTtsProviderChange = useCallback((provider: TTSProvider) => {
    setTtsProvider(provider);
  }, [setTtsProvider]);

  const handleTtsModelChange = useCallback((model: string) => {
    setTtsModel(model);
  }, [setTtsModel]);

  const handleSttProviderChange = useCallback((provider: 'local' | 'openai') => {
    setSttProvider(provider);
  }, [setSttProvider]);

  const handleSttInputModeChange = useCallback((mode: STTInputMode) => {
    setSttInputMode(mode);
  }, [setSttInputMode]);

  const handleSttModelChange = useCallback((model: string) => {
    setSttModel(model);
  }, [setSttModel]);

  const visibleSaveToast = saveToast?.agentId === workspaceAgentId
    && saveToast.workspaceVersion === workspaceVersion
    ? saveToast
    : null;
  const isLiveVoiceSession = currentSession === JANE_LIVE_VOICE_SESSION_KEY;
  const isLegacyJaneHistory = isLegacyJaneSessionKey(currentSession);
  const backgroundWorkCount = isLiveVoiceSession
    ? Object.entries(busyState).filter(([sessionKey, busy]) => busy && sessionKey !== JANE_LIVE_VOICE_SESSION_KEY).length
    : 0;

  const chatContent = (
    <TabbedContentArea
      activeTab={activeTab}
      openFiles={openFiles}
      workspaceAgentId={workspaceAgentId}
      onSelectTab={setActiveTab}
      onCloseTab={closeFile}
      onContentChange={updateContent}
      onSaveFile={handleSaveFile}
      saveToast={visibleSaveToast}
      onDismissToast={dismissSaveToast}
      onReloadFile={reloadFile}
      onRetryFile={reloadFile}
      onOpenWorkspacePath={openWorkspacePath}
      chatPanel={
        <PanelErrorBoundary name="Chat">
          <ChatPanel
            ref={chatPanelRef}
            id="main-chat"
            messages={messages}
            onSend={handleSend}
            onLiveTranscript={handleLiveTranscript}
            onAbort={handleAbort}
            isGenerating={isGenerating}
            stream={stream}
            processingStage={processingStage}
            lastEventTimestamp={lastEventTimestamp}
            currentToolDescription={currentToolDescription}
            activityLog={activityLog}
            onWakeWordState={handleWakeWordState}
            onReset={handleReset}
            searchOpen={searchOpen}
            onSearchClose={closeSearch}
            agentName={currentSessionDisplayName}
            loadMore={loadMore}
            hasMore={hasMore}
            onToggleFileBrowser={isCompactLayout ? handleToggleFileBrowser : fileBrowserCollapsed ? handleToggleFileBrowser : undefined}
            isFileBrowserCollapsed={fileBrowserCollapsed}
            onToggleMobileTopBar={isCompactLayout ? toggleMobileTopBar : undefined}
            isMobileTopBarHidden={isMobileTopBarHidden}
            onOpenWorkspacePath={openWorkspacePath}
            pathLinkPrefixes={chatPathLinkPrefixes}
            isLiveVoiceSession={isLiveVoiceSession}
            readOnly={isLegacyJaneHistory}
            backgroundWorkCount={backgroundWorkCount}
            approvalBanner={
              <ApprovalBanner
                pendingApprovals={approvalState.pendingApprovals}
                resolvingKeys={approvalState.resolvingKeys}
                error={approvalState.error}
                onDecision={approvalState.resolveApproval}
              />
            }
          />
        </PanelErrorBoundary>
      }
    />
  );

  const renderRightPanels = (onSelect: (key: string) => Promise<void> | void) => (
    <Suspense fallback={<div className="flex-1 flex items-center justify-center text-muted-foreground text-xs bg-background">Loading…</div>}>
      <div
        className={`flex flex-1 flex-col gap-3 min-h-0 ${allRightPanelsCollapsed ? 'items-stretch' : ''}`}
        data-testid={allRightPanelsCollapsed ? 'right-panel-rail-collapsed' : 'right-panel-rail'}
      >
        <CollapsibleRightPanel
          id="proposals"
          title="Agent Suggestions"
          count={pendingProposalCount + suggestedTasks.length}
          collapsed={rightPanelCollapsed.proposals}
          railCollapsed={allRightPanelsCollapsed}
          onToggle={toggleRightPanel}
        >
          <ProposalInbox
            proposals={proposals}
            onApprove={approveProposal}
            onReject={rejectProposal}
            onRejectBackground={rejectBackgroundProposals}
            suggestedTasks={suggestedTasks}
            onOpenTask={(taskId) => {
              setKanbanFocusTaskId(taskId);
              setViewMode('kanban');
            }}
          />
        </CollapsibleRightPanel>

        <CollapsibleRightPanel
          id="agents"
          title="Agents"
          collapsed={rightPanelCollapsed.agents}
          railCollapsed={allRightPanelsCollapsed}
          onToggle={toggleRightPanel}
        >
          <PanelErrorBoundary name="Sessions">
            <SessionList
              sessions={sessions}
              currentSession={currentSession}
              busyState={busyState}
              agentStatus={agentStatus}
              unreadSessions={unreadSessions}
              onSelect={onSelect}
              onRefresh={refreshSessions}
              onDelete={deleteSession}
              onDeleteAllSessions={deleteAllSessions}
              onSpawn={handleSpawnSession}
              onRename={renameSession}
              onAbort={abortSession}
              isLoading={sessionsLoading}
              agentName={agentName}
              agents={agents}
              hideTitle
            />
          </PanelErrorBoundary>
        </CollapsibleRightPanel>

        <CollapsibleRightPanel
          id="workspace"
          title="Kanban"
          collapsed={rightPanelCollapsed.workspace}
          railCollapsed={allRightPanelsCollapsed}
          onToggle={toggleRightPanel}
        >
          <PanelErrorBoundary name="Workspace">
            <WorkspacePanel
              workspaceAgentId={workspaceAgentId}
              memories={memories}
              onRefreshMemories={refreshMemories}
              memoriesLoading={memoriesLoading}
              remoteWorkspace={remoteWorkspace}
              onOpenBoard={() => setViewMode('kanban')}
            />
          </PanelErrorBoundary>
        </CollapsibleRightPanel>
      </div>
    </Suspense>
  );

  const compactSessionsPanel = (
    <Suspense fallback={<div className="p-4 text-muted-foreground text-xs">Loading sessions…</div>}>
      <PanelErrorBoundary name="Sessions">
        <SessionList
          sessions={sessions}
          currentSession={currentSession}
          busyState={busyState}
          agentStatus={agentStatus}
          unreadSessions={unreadSessions}
          onSelect={handleSessionChange}
          onRefresh={refreshSessions}
          onDelete={deleteSession}
          onDeleteAllSessions={deleteAllSessions}
          onSpawn={handleSpawnSession}
          onRename={renameSession}
          onAbort={abortSession}
          isLoading={sessionsLoading}
          agentName={agentName}
          agents={agents}
          compact
        />
      </PanelErrorBoundary>
    </Suspense>
  );

  const compactWorkspacePanel = (
    <Suspense fallback={<div className="p-4 text-muted-foreground text-xs">Loading workspace…</div>}>
      <PanelErrorBoundary name="Workspace">
        <WorkspacePanel
          workspaceAgentId={workspaceAgentId}
          memories={memories}
          onRefreshMemories={refreshMemories}
          memoriesLoading={memoriesLoading}
          remoteWorkspace={remoteWorkspace}
          compact
          onOpenBoard={() => setViewMode('kanban')}
        />
      </PanelErrorBoundary>
    </Suspense>
  );

  const showCompactFileBrowser = isCompactLayout && viewMode === 'chat' && !fileBrowserCollapsed;

  return (
    <div className="scan-lines relative h-screen flex flex-col overflow-hidden" data-booted={booted}>
      {/* Skip to main content link for keyboard navigation */}
      <a 
        href="#main-chat" 
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-[100] focus:px-4 focus:py-2 focus:bg-primary focus:text-primary-foreground focus:font-bold focus:text-sm"
      >
        Skip to chat
      </a>
      {/*
       * Gateway state banners.
       * Kept compact and centered so they read as transient shell notices instead of old alarm strips.
       * Startup connection stays silent; recovery lives in Settings so refresh never blocks on a modal.
       */}
      {connectionState === 'reconnecting' && !gatewayRestarting && (
        <div className="fixed left-1/2 top-12 z-50 flex max-w-[calc(100vw-1.067rem)] -translate-x-1/2 items-start gap-2 rounded-2xl border border-destructive/25 bg-card/94 px-4 py-2 text-xs font-medium text-foreground shadow-[0_20px_48px_rgba(0,0,0,0.28)] backdrop-blur-xl">
          <span className="inline-flex size-7 items-center justify-center rounded-xl bg-destructive/10 text-destructive">
            <AlertTriangle size={14} aria-hidden="true" />
          </span>
          <span className="min-w-0 text-left leading-5">Gateway reconnecting…</span>
          <span className="size-2 rounded-full bg-destructive animate-pulse" aria-hidden="true" />
        </div>
      )}

      {gatewayRestarting && (
        <div className="fixed left-1/2 top-12 z-50 flex max-w-[calc(100vw-1.067rem)] -translate-x-1/2 items-start gap-2 rounded-2xl border border-orange/25 bg-card/94 px-4 py-2 text-xs font-medium text-foreground shadow-[0_20px_48px_rgba(0,0,0,0.28)] backdrop-blur-xl">
          <span className="inline-flex size-7 items-center justify-center rounded-xl bg-orange/10 text-orange">
            <RotateCw size={14} className="animate-spin" aria-hidden="true" />
          </span>
          <span className="min-w-0 text-left leading-5">Gateway restarting…</span>
        </div>
      )}

      {!gatewayRestarting && gatewayRestartNotice && (
        <button
          type="button"
          onClick={dismissNotice}
          className={`fixed left-1/2 top-12 z-50 flex max-w-[calc(100vw-1.067rem)] -translate-x-1/2 cursor-pointer items-start gap-2 rounded-2xl border px-4 py-2 text-xs font-medium shadow-[0_20px_48px_rgba(0,0,0,0.28)] backdrop-blur-xl transition-transform hover:-translate-x-1/2 hover:-translate-y-px ${
            gatewayRestartNotice.ok
              ? 'border-green/25 bg-card/94 text-foreground'
              : 'border-destructive/25 bg-card/94 text-foreground'
          }`}
        >
          <span className={`inline-flex size-7 items-center justify-center rounded-xl ${
            gatewayRestartNotice.ok ? 'bg-green/10 text-green' : 'bg-destructive/10 text-destructive'
          }`}>
            {gatewayRestartNotice.ok ? <CheckCircle2 size={14} aria-hidden="true" /> : <AlertTriangle size={14} aria-hidden="true" />}
          </span>
          <span className="min-w-0 text-left leading-5">{gatewayRestartNotice.message}</span>
        </button>
      )}

      {!voicePlaybackUnlocked && (
        <button
          type="button"
          onClick={() => void unlockVoicePlayback()}
          className="fixed bottom-8 left-1/2 z-50 flex min-h-14 max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-3 rounded-2xl border border-orange/30 bg-card/96 px-5 py-3 text-sm font-semibold text-foreground shadow-[0_24px_64px_rgba(0,0,0,0.34)] backdrop-blur-xl transition-transform hover:-translate-x-1/2 hover:-translate-y-px"
        >
          <span className="inline-flex size-8 items-center justify-center rounded-xl bg-orange/10 text-orange">
            <Volume2 size={16} aria-hidden="true" />
          </span>
          <span>Enable voice</span>
        </button>
      )}
      
      {(!isCompactLayout || !isMobileTopBarHidden) && (
        <TopBar
          onSettings={openSettings}
          agentLogEntries={agentLogEntries}
          tokenData={tokenData}
          logGlow={logGlow}
          eventEntries={eventEntries}
          eventsVisible={eventsVisible}
          logVisible={logVisible}
          mobilePanelButtonsVisible={isCompactLayout}
          sessionsPanel={compactSessionsPanel}
          workspacePanel={compactWorkspacePanel}
          viewMode={viewMode}
          onViewModeChange={setViewMode}
          onOpenJaneChat={handleOpenJaneChat}
          showKanbanView={kanbanVisible}
          onOpenAccountability={() => setAccountabilityOpen((open) => !open)}
          accountabilityOpen={accountabilityOpen}
        />
      )}
      
      <PanelErrorBoundary name="Settings">
        <Suspense fallback={null}>
          <SettingsDrawer
            open={settingsOpen}
            onClose={closeSettings}
            gatewayUrl={editableUrl}
            gatewayToken={editableToken}
            onUrlChange={setEditableUrl}
            onTokenChange={setEditableToken}
            onReconnect={handleReconnect}
            connectionState={connectionState}
            soundEnabled={soundEnabled}
            onToggleSound={toggleSound}
            ttsProvider={ttsProvider}
            ttsModel={ttsModel}
            onTtsProviderChange={handleTtsProviderChange}
            onTtsModelChange={handleTtsModelChange}
            sttProvider={sttProvider}
            sttInputMode={sttInputMode}
            sttModel={sttModel}
            onSttProviderChange={handleSttProviderChange}
            onSttInputModeChange={handleSttInputModeChange}
            onSttModelChange={handleSttModelChange}
            wakeWordEnabled={wakeWordEnabled}
            onToggleWakeWord={handleToggleWakeWord}
            liveTranscriptionPreview={liveTranscriptionPreview}
            onToggleLiveTranscriptionPreview={toggleLiveTranscriptionPreview}
            continuousVoiceEnabled={continuousVoiceEnabled}
            onToggleContinuousVoice={toggleContinuousVoice}
            liveVoicePauseMs={liveVoicePauseMs}
            onLiveVoicePauseMsChange={setLiveVoicePauseMs}
            wakeVoicePauseMs={wakeVoicePauseMs}
            onWakeVoicePauseMsChange={setWakeVoicePauseMs}
            agentName={agentName}
            onLogout={onLogout}
            onGatewayRestart={handleGatewayRestart}
            gatewayRestarting={gatewayRestarting}
          />
        </Suspense>
      </PanelErrorBoundary>
      
      <div className="flex-1 flex gap-3 overflow-hidden min-h-0 px-2 pt-1.5 pb-2 sm:px-4 sm:pt-2 sm:pb-2">
        {/* File tree — desktop inline, mobile drawer */}
        {!isCompactLayout && (
          <div className={viewMode !== 'chat' ? 'hidden' : fileBrowserCollapsed ? 'contents' : 'h-full min-h-0'}>
            <PanelErrorBoundary name="File Explorer">
              <FileTreePanel
                workspaceAgentId={workspaceAgentId}
                onOpenFile={openFile}
                lastChangedEvent={lastChangedEvent}
                revealRequest={revealRequest}
                onRemapOpenPaths={remapOpenPaths}
                onCloseOpenPaths={closeOpenPathsByPrefix}
                isCompactLayout={false}
                collapsed={fileBrowserCollapsed}
                onCollapseChange={setFileBrowserCollapsed}
              />
            </PanelErrorBoundary>
          </div>
        )}

        {showCompactFileBrowser && (
          <>
            <button
              type="button"
              className="fixed inset-0 z-30 hidden bg-black/48 backdrop-blur-sm max-[900px]:block"
              onClick={() => setFileBrowserCollapsed(true)}
              aria-label="Close file explorer"
            />
            <div className={`pointer-events-none fixed inset-0 z-40 hidden px-2 pb-[4.25rem] max-[900px]:flex ${isMobileTopBarHidden ? 'pt-2' : 'pt-[4.5rem]'}`}>
              <div className="pointer-events-auto h-full w-[min(86vw,320px)] max-w-full animate-in slide-in-from-left-4 duration-200">
                <PanelErrorBoundary name="File Explorer">
                  <FileTreePanel
                    workspaceAgentId={workspaceAgentId}
                    onOpenFile={openFile}
                    lastChangedEvent={lastChangedEvent}
                    revealRequest={revealRequest}
                    onRemapOpenPaths={remapOpenPaths}
                    onCloseOpenPaths={closeOpenPathsByPrefix}
                    isCompactLayout={true}
                    collapsed={false}
                    onCollapseChange={setFileBrowserCollapsed}
                  />
                </PanelErrorBoundary>
              </div>
            </div>
          </>
        )}

        {/*
         * Chat panel is always rendered but hidden when kanban is active.
         * This keeps ChatPanel → InputBar → useVoiceInput mounted so that
         * in-progress voice recording / STT transcription survives tab switches.
         * See: https://github.com/.../issues/64
         */}
        {viewMode === 'kanban' && (
          <div className="shell-panel boot-panel flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden rounded-[28px]">
            <Suspense fallback={<div className="flex-1 flex items-center justify-center text-muted-foreground text-xs bg-background">Loading…</div>}>
              <KanbanPanel
                initialTaskId={kanbanFocusTaskId}
                onInitialTaskConsumed={() => setKanbanFocusTaskId(null)}
              />
            </Suspense>
          </div>
        )}
        {viewMode === 'agents' && (
          <div className="shell-panel boot-panel flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden rounded-[28px]">
            <Suspense fallback={<div className="flex-1 flex items-center justify-center text-muted-foreground text-xs bg-background">Loading…</div>}>
              <AgentsView onOpenSession={handleOpenAgentSession} onOpenTask={handleOpenAgentTask} />
            </Suspense>
          </div>
        )}
        {viewMode === 'finance' && (
          <div className="shell-panel boot-panel flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden rounded-[28px]">
            <Suspense fallback={<div className="flex-1 flex items-center justify-center text-muted-foreground text-xs bg-background">Loading…</div>}>
              <FinancePanel />
            </Suspense>
          </div>
        )}
        <div style={{ display: viewMode !== 'chat' ? 'none' : 'contents' }}>
          <ResizablePanels
            compact={isCompactLayout}
            leftPercent={panelRatio}
            onResize={setPanelRatio}
            minLeftPercent={30}
            maxLeftPercent={85}
            rightWidthPx={rightRailWidthPx}
            onRightWidthChange={rightRailWidthPx !== null ? undefined : setDesktopRightPanelWidth}
            leftClassName="shell-panel boot-panel rounded-[28px] overflow-hidden"
            rightClassName="boot-panel flex flex-col"
            left={chatContent}
            right={renderRightPanels(handleSessionChange)}
          />
        </div>
      </div>

      {/* Status Bar */}
      <div className="boot-panel" style={{ transitionDelay: '200ms' }}>
        <StatusBar
          connectionState={connectionState}
          sessionCount={sessions.length}
          sparkline={sparkline}
          contextTokens={contextTokens}
          contextLimit={contextLimit}
          voiceReadbackEnabled={voiceReadbackEnabled}
          onToggleVoiceReadback={toggleVoiceReadback}
          isTtsSpeaking={isTtsSpeaking}
          onStopSpeaking={stopSpeaking}
        />
      </div>

      {/* Command Palette */}
      <PanelErrorBoundary name="Command Palette">
        <Suspense fallback={null}>
          <CommandPalette
            open={paletteOpen}
            onClose={closePalette}
            commands={commands}
          />
        </Suspense>
      </PanelErrorBoundary>

      {/* Reset Session Confirmation */}
      <ConfirmDialog
        open={showResetConfirm}
        title="Reset Session"
        message="This will start fresh and clear all context."
        confirmLabel="Reset"
        cancelLabel="Cancel"
        onConfirm={confirmReset}
        onCancel={cancelReset}
        variant="danger"
      />

      {/* Gateway Restart Confirmation */}
      <ConfirmDialog
        open={showGatewayRestartConfirm}
        title="Restart OpenClaw Gateway"
        message="This will briefly interrupt gateway connectivity. Continue?"
        confirmLabel="Restart"
        cancelLabel="Cancel"
        onConfirm={confirmGatewayRestart}
        onCancel={cancelGatewayRestart}
        variant="warning"
      />

      <WorkspaceSwitchDialog
        open={pendingWorkspaceSwitch !== null}
        targetLabel={pendingWorkspaceSwitch?.targetLabel || 'the other agent'}
        pendingAction={workspaceSwitchAction}
        error={workspaceSwitchError}
        onSaveAndSwitch={handleSaveAndSwitch}
        onDiscardAndSwitch={handleDiscardAndSwitch}
        onCancel={handleCancelWorkspaceSwitch}
      />

      {/* Spawn Agent Dialog (from command palette) */}
      <SpawnAgentDialog
        open={spawnDialogOpen}
        onOpenChange={setSpawnDialogOpen}
        onSpawn={handleSpawnSession}
      />

      <PanelErrorBoundary name="Targets">
        <Suspense fallback={null}>
          <TargetBoardModal
            open={accountabilityOpen}
            onClose={() => setAccountabilityOpen(false)}
            currentActiveTask={null}
            taskCount={0}
            onOpenSection={openTargetSection}
          />
        </Suspense>
      </PanelErrorBoundary>
    </div>
  );
}
