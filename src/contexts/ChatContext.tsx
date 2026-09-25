/**
 * ChatContext — Thin orchestrator that composes chat hooks
 *
 * Business logic is distributed across composable hooks:
 * - useChatMessages: message CRUD, dedup, history, infinite scroll
 * - useChatStreaming: stream rendering, processing stage, activity log
 * - useChatRecovery: recovery/retry, gap detection, generation guards
 * - useChatTTS: TTS playback, voice fallback, sound feedback
 *
 * This file handles:
 * - React context creation and provider
 * - Session-level state (isGenerating, showResetConfirm)
 * - Run state management (runsRef, activeRunIdRef, sequence tracking)
 * - Gateway event subscription (delegating to hook methods)
 * - Wiring hook outputs into the context value
 */
import { createContext, useContext, useCallback, useRef, useEffect, useState, useMemo, type ReactNode } from 'react';
import { useGateway } from './GatewayContext';
import { useSessionContext } from './SessionContext';
import { useSettings } from './SettingsContext';
import { getSessionKey, type GatewayEvent } from '@/types';
import {
  JANE_DIRECT_CHAT_SESSION_KEY,
  JANE_LIVE_VOICE_SESSION_KEY,
  getRootAgentSessionKey,
  isRootChildSession,
  isSubagentSessionKey,
  pickDefaultSessionKey,
} from '@/features/sessions/sessionKeys';
import {
  loadChatHistory,
  processChatMessages,
  buildUserMessage,
  appendFinanceContext,
  appendLiveVoiceCoordinatorContext,
  buildLiveVoiceContextDelta,
  sendChatMessage,
  shouldAttachLiveStatusContext,
  classifyStreamEvent,
  extractStreamDelta,
  extractFinalMessage,
  extractFinalMessages,
  deriveProcessingStage,
  isActiveAgentState,
  mergeRecoveredTail,
  getOrCreateRunState,
  hasSeqGap,
  pruneRunRegistry,
  resolveRunId,
  createFallbackRunId,
  updateHighestSeq,
} from '@/features/chat/operations';
import { readFastReplyMode } from '@/features/chat/fastReply';
import {
  buildWakeBriefAssistantMessage,
  fetchWakeBriefAnswer,
  isWakeBriefLocalTempId,
  shouldUseWakeBriefReply,
  WAKE_BRIEF_LOCAL_TEMP_PREFIX,
} from '@/features/chat/operations/wakeBrief';
import {
  buildCodexAssistantMessage,
  routeCodexMessage,
  routeLiveVoiceMessage,
  sendCodexDirectMessage,
} from '@/features/chat/operations/codexDirect';
import { renderMarkdown } from '@/utils/helpers';
import { generateMsgId } from '@/features/chat/types';
import type { ImageAttachment, ChatMsg, OutgoingUploadPayload } from '@/features/chat/types';
import type { ChatSendStatus, LiveVoiceContextItem, RecoveryReason, RunState } from '@/features/chat/operations';

import { useChatMessages, mergeFinalMessages, patchThinkingDuration } from '@/hooks/useChatMessages';
import { useChatStreaming } from '@/hooks/useChatStreaming';
import { useChatRecovery } from '@/hooks/useChatRecovery';
import { useChatTTS } from '@/hooks/useChatTTS';
import {
  isCodexRealtimeBootstrapDelivered,
  markCodexRealtimeBootstrapDelivered,
  markCodexRealtimeContextDelivered,
  readCodexRealtimeDeliveredContextIds,
  resetCodexRealtimeSessionSync,
} from '@/features/voice/codexRealtimeBridge';

// ─── Exported types (consumed by features/chat components) ──────────────────────

/** Processing stages for enhanced thinking indicator */
export type ProcessingStage = 'thinking' | 'fast' | 'tool_use' | 'streaming' | null;

/** A single entry in the activity log */
export interface ActivityLogEntry {
  id: string;           // toolCallId or generated unique id
  toolName: string;     // raw tool name (e.g., 'read', 'exec')
  description: string;  // human-friendly from describeToolUse()
  startedAt: number;    // Date.now() when tool started
  completedAt?: number; // Date.now() when result received
  phase: 'running' | 'completed';
}

export interface ChatStreamState {
  html: string;
  runId?: string;
  isRecovering?: boolean;
  recoveryReason?: RecoveryReason | null;
}

interface ChatContextValue {
  messages: ChatMsg[];
  isGenerating: boolean;
  stream: ChatStreamState;
  processingStage: ProcessingStage;
  lastEventTimestamp: number;
  activityLog: ActivityLogEntry[];
  currentToolDescription: string | null;
  handleSend: (
    text: string,
    images?: ImageAttachment[],
    uploadPayload?: OutgoingUploadPayload,
    source?: 'text' | 'live-voice',
  ) => Promise<void>;
  handleLiveTranscript: (update: { role: 'user' | 'assistant'; text: string; final: boolean; id?: string; seq?: number }) => void;
  handleAbort: () => Promise<void>;
  handleReset: () => void;
  loadHistory: (session?: string) => Promise<void>;
  /** Load more (older) messages — returns true if there are still more to show */
  loadMore: () => boolean;
  /** Whether there are older messages available to load */
  hasMore: boolean;
  /** Reset confirmation dialog state — rendered by the consumer, not the provider */
  showResetConfirm: boolean;
  confirmReset: () => Promise<void>;
  cancelReset: () => void;
}

const ChatContext = createContext<ChatContextValue | null>(null);

function makeReplayKey(msg: ChatMsg): string {
  const imageKey = (msg.extractedImages || []).map((img) => img.url).sort().join('|');
  const toolKey = (msg.toolGroup || []).map((entry) => `${entry.preview}:${entry.rawText}`).join('|');
  return [
    `role:${msg.role}`,
    `raw:${msg.rawText.trim().replace(/\s+/g, ' ')}`,
    `html:${msg.html.trim().replace(/\s+/g, ' ')}`,
    `thinking:${Boolean(msg.isThinking)}`,
    `intermediate:${Boolean(msg.intermediate)}`,
    `images:${imageKey}`,
    `tools:${toolKey}`,
    `ts:${Math.floor(msg.timestamp.getTime() / 1000)}`,
  ].join('::');
}

function dedupeReplayMessages(messages: ChatMsg[]): ChatMsg[] {
  const seen = new Set<string>();
  const deduped: ChatMsg[] = [];

  for (const msg of messages) {
    const key = makeReplayKey(msg);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(msg);
  }

  return deduped;
}

const CHAT_HISTORY_POLL_INTERVAL_MS = 5_000;
const LOCAL_USER_HISTORY_GRACE_MS = 2 * 60_000;
const STALE_GENERATION_CLEAR_MS = 90_000;
const LONG_SESSION_PROMPT_THRESHOLD = 80;

function shouldReadBackgroundFinal(sessionKey?: string): boolean {
  return Boolean(
    sessionKey === JANE_LIVE_VOICE_SESSION_KEY
    || sessionKey === JANE_DIRECT_CHAT_SESSION_KEY,
  );
}

function normalizeMessageText(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function hasSameVisibleMessage(previous: ChatMsg, next: ChatMsg): boolean {
  return (
    previous.role === next.role
    && normalizeMessageText(previous.rawText) === normalizeMessageText(next.rawText)
    && normalizeMessageText(previous.html) === normalizeMessageText(next.html)
    && (previous.ttsText ?? '') === (next.ttsText ?? '')
    && Boolean(previous.isThinking) === Boolean(next.isThinking)
    && Boolean(previous.intermediate) === Boolean(next.intermediate)
    && (previous.extractedImages || []).map((img) => img.url).sort().join('|') === (next.extractedImages || []).map((img) => img.url).sort().join('|')
    && (previous.toolGroup?.length || 0) === (next.toolGroup?.length || 0)
  );
}

function hasChatHistoryChanged(previous: ChatMsg[], next: ChatMsg[]): boolean {
  if (previous.length !== next.length) return true;
  if (previous.length === 0) return false;

  const previousLast = previous[previous.length - 1];
  const nextLast = next[next.length - 1];
  if (previousLast && nextLast && hasSameVisibleMessage(previousLast, nextLast)) {
    return false;
  }

  return previous.some((prevMessage, index) => !hasSameVisibleMessage(prevMessage, next[index]));
}

function getSessionContextPercent(session: { totalTokens?: number; contextTokens?: number } | undefined): number | null {
  const explicitTotalTokens = typeof session?.totalTokens === 'number' ? session.totalTokens : 0;
  const fallbackTotalTokens =
    (typeof (session as { inputTokens?: number } | undefined)?.inputTokens === 'number' ? (session as { inputTokens?: number }).inputTokens ?? 0 : 0)
    + (typeof (session as { outputTokens?: number } | undefined)?.outputTokens === 'number' ? (session as { outputTokens?: number }).outputTokens ?? 0 : 0);
  const totalTokens = explicitTotalTokens > 0 ? explicitTotalTokens : fallbackTotalTokens;
  const contextTokens = typeof session?.contextTokens === 'number' ? session.contextTokens : 0;
  if (totalTokens <= 0 || contextTokens <= 0) return null;
  return Math.min(100, Math.round((totalTokens / contextTokens) * 100));
}

function isYesReply(text: string): boolean {
  return /^(y|yes)$/i.test(text.trim());
}

function isNoReply(text: string): boolean {
  return /^(n|no)$/i.test(text.trim());
}

export function ChatProvider({ children }: { children: ReactNode }) {
  const { connectionState, rpc, subscribe } = useGateway();
  const { currentSession, sessions, setCurrentSession } = useSessionContext();
  const { soundEnabled, voiceReadbackEnabled = true, speak, stopSpeaking } = useSettings();

  // ─── Shared state ─────────────────────────────────────────────────────────
  const [isGenerating, setIsGenerating] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);

  // ─── Refs for stable callback references ──────────────────────────────────
  const currentSessionRef = useRef(currentSession);
  const isGeneratingRef = useRef(isGenerating);
  const generationStartedAtRef = useRef<number | null>(null);
  const staleGenerationNoticeShownRef = useRef(false);
  const soundEnabledRef = useRef(soundEnabled);
  const voiceReadbackEnabledRef = useRef(voiceReadbackEnabled);
  const speakRef = useRef(speak);
  const stopSpeakingRef = useRef(stopSpeaking);

  useEffect(() => {
    currentSessionRef.current = currentSession;
    isGeneratingRef.current = isGenerating;
    soundEnabledRef.current = soundEnabled;
    voiceReadbackEnabledRef.current = voiceReadbackEnabled;
    speakRef.current = speak;
    stopSpeakingRef.current = stopSpeaking;
  }, [currentSession, isGenerating, soundEnabled, voiceReadbackEnabled, speak, stopSpeaking]);

  useEffect(() => {
    if (isGenerating && generationStartedAtRef.current === null) {
      generationStartedAtRef.current = Date.now();
      staleGenerationNoticeShownRef.current = false;
    }
    if (!isGenerating) {
      generationStartedAtRef.current = null;
      staleGenerationNoticeShownRef.current = false;
    }
  }, [isGenerating]);

  // ─── Run state management ─────────────────────────────────────────────────
  const runsRef = useRef<Map<string, RunState>>(new Map());
  const activeRunIdRef = useRef<string | null>(null);
  const lastGatewaySeqRef = useRef<number | null>(null);
  const lastChatSeqRef = useRef<number | null>(null);
  const toolResultRefreshRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const historyPollInFlightRef = useRef(false);
  const historyPollEmptySeenRef = useRef(false);
  const liveVoiceSessionConfiguredRef = useRef(false);
  const deferredLongSessionSendRef = useRef<{
    sessionKey: string;
    text: string;
    images?: ImageAttachment[];
    uploadPayload?: OutgoingUploadPayload;
  } | null>(null);

  // ─── Compose hooks ────────────────────────────────────────────────────────
  const msgHook = useChatMessages({ rpc, currentSessionRef });
  const liveTranscriptIdsRef = useRef<Partial<Record<'user' | 'assistant', string>>>({});
  const liveFinalUserRef = useRef<{ id: string; text: string } | null>(null);
  const streamHook = useChatStreaming();
  const ttsHook = useChatTTS({ soundEnabled: soundEnabledRef, voiceReadbackEnabled: voiceReadbackEnabledRef, speak: speakRef, stopSpeaking: stopSpeakingRef });

  const recoveryHook = useChatRecovery({
    rpc,
    currentSessionRef,
    isGeneratingRef,
    activeRunIdRef,
    runsRef,
    getAllMessages: msgHook.getAllMessages,
    applyMessageWindow: msgHook.applyMessageWindow,
    setStream: streamHook.setStream,
  });

  const handleLiveTranscript = useCallback((update: { role: 'user' | 'assistant'; text: string; final: boolean; id?: string; seq?: number }) => {
    const text = update.text.trim();
    if (!text) return;
    const existingId = liveTranscriptIdsRef.current[update.role];
    const id = update.id
      ? `live-history-${update.role}-${update.id}`
      : existingId ?? `live-${update.role}-${generateMsgId()}`;
    liveTranscriptIdsRef.current[update.role] = update.final ? undefined : id;
    if (update.role === 'user' && update.final) liveFinalUserRef.current = { id, text };
    const apply = (messages: ChatMsg[]) => {
      const index = messages.findIndex((message) => message.msgId === id || message.msgId === existingId);
      const message: ChatMsg = {
        msgId: id,
        role: update.role,
        rawText: text,
        html: renderMarkdown(text),
        timestamp: index >= 0 ? messages[index].timestamp : new Date(),
        streaming: !update.final,
        isVoice: true,
      };
      if (index < 0) return [...messages, message];
      const next = [...messages];
      next[index] = message;
      return next;
    };
    msgHook.setAllMessages(apply);
    msgHook.setMessages(apply);
  }, [msgHook]);

  const appendSystemMessage = useCallback((html: string) => {
    const msg: ChatMsg = {
      msgId: generateMsgId(),
      role: 'system',
      html,
      rawText: '',
      timestamp: new Date(),
    };
    msgHook.setAllMessages(prev => [...prev, msg]);
    msgHook.setMessages((prev: ChatMsg[]) => [...prev, msg]);
  }, [msgHook]);

  // ─── Reset transient state on session switch ──────────────────────────────
  useEffect(() => {
    setIsGenerating(false);
    msgHook.resetMessageState();
    streamHook.resetStreamState();
    recoveryHook.resetRecoveryState();
    runsRef.current.clear();
    activeRunIdRef.current = null;
    lastGatewaySeqRef.current = null;
    lastChatSeqRef.current = null;
    if (toolResultRefreshRef.current) {
      clearTimeout(toolResultRefreshRef.current);
      toolResultRefreshRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSession]);

  // ─── Load history on connect / recover on reconnect ───────────────────────
  const previousConnectionStateRef = useRef(connectionState);
  useEffect(() => {
    const prevConnection = previousConnectionStateRef.current;

    if (connectionState === 'connected') {
      if (prevConnection === 'reconnecting' && recoveryHook.wasGeneratingOnDisconnect()) {
        recoveryHook.triggerRecovery('reconnect');
      }
      recoveryHook.clearDisconnectState();
    }

    if (connectionState === 'reconnecting' && prevConnection === 'connected') {
      recoveryHook.captureDisconnectState();
    }

    previousConnectionStateRef.current = connectionState;
  }, [
    connectionState,
    currentSession,
    msgHook.loadHistory,
    recoveryHook.wasGeneratingOnDisconnect,
    recoveryHook.triggerRecovery,
    recoveryHook.clearDisconnectState,
    recoveryHook.captureDisconnectState,
  ]);

  useEffect(() => {
    if (connectionState !== 'connected' || !currentSession) return;
    msgHook.loadHistory(currentSession);
  }, [connectionState, currentSession, msgHook.loadHistory]);

  // ─── Periodic history poll for sub-agent sessions ─────────────────────────
  useEffect(() => {
    if (connectionState !== 'connected' || !currentSession) return;

    const pollCurrentHistory = async () => {
      if (historyPollInFlightRef.current) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;

      historyPollInFlightRef.current = true;
      try {
        const sk = currentSessionRef.current;
        if (!sk) return;

        const result = await loadChatHistory({ rpc, sessionKey: sk, limit: 50 });
        if (sk !== currentSessionRef.current) return;

        const prev = msgHook.getAllMessages();
        if (result.length === 0 && prev.length > 0) {
          if (!historyPollEmptySeenRef.current) {
            historyPollEmptySeenRef.current = true;
            return;
          }
        } else {
          historyPollEmptySeenRef.current = false;
        }

        const next = dedupeReplayMessages(result);
        if (!hasChatHistoryChanged(prev, next)) return;

        ttsHook.handleHistoryTTS(prev, next);
        // Merge instead of replacing so a just-sent local user row is not
        // dropped by a slightly stale history poll before gateway history catches up.
        const now = Date.now();
        const recentLocalMessages = prev.filter((message) => {
          const localWakeBrief = isWakeBriefLocalTempId(message.tempId);
          const localGraceMs = localWakeBrief ? CHAT_HISTORY_POLL_INTERVAL_MS * 120 : LOCAL_USER_HISTORY_GRACE_MS;
          const keepLocalMessage = localWakeBrief || (
            message.role === 'user'
            && (message.pending || message.tempId)
          );
          return keepLocalMessage
          && (message.pending || now - message.timestamp.getTime() < localGraceMs)
          && !next.some((incoming) =>
            incoming.role === 'user'
            && normalizeMessageText(incoming.rawText) === normalizeMessageText(message.rawText)
            && (incoming.extractedImages || []).map((img) => img.url).sort().join('|') === (message.extractedImages || []).map((img) => img.url).sort().join('|'),
          );
        });
        const merged = dedupeReplayMessages([
          ...mergeRecoveredTail(prev, next),
          ...recentLocalMessages,
        ]);
        msgHook.applyMessageWindow(merged, false);
      } catch {
        // Best effort: keep the last visible transcript if a background poll fails.
      } finally {
        historyPollInFlightRef.current = false;
      }
    };

    void pollCurrentHistory();
    const pollInterval = setInterval(() => {
      void pollCurrentHistory();
    }, CHAT_HISTORY_POLL_INTERVAL_MS);

    return () => {
      clearInterval(pollInterval);
      historyPollInFlightRef.current = false;
    };
  }, [
    connectionState,
    currentSession,
    msgHook.applyMessageWindow,
    msgHook.getAllMessages,
    rpc,
    ttsHook.handleHistoryTTS,
  ]);

  // ─── Watchdog: if stream stalls, recover once ─────────────────────────────
  useEffect(() => {
    if (!isGenerating || !streamHook.lastEventTimestamp) return;

    const timer = setTimeout(() => {
      const elapsed = Date.now() - streamHook.lastEventTimestamp;
      if (elapsed >= 12_000 && !recoveryHook.isRecoveryInFlight() && !recoveryHook.isRecoveryPending()) {
        recoveryHook.triggerRecovery('chat-gap');
      }
    }, 12_000);

    return () => clearTimeout(timer);
  }, [
    isGenerating,
    streamHook.lastEventTimestamp,
    recoveryHook.isRecoveryInFlight,
    recoveryHook.isRecoveryPending,
    recoveryHook.triggerRecovery,
  ]);

  // ─── Safety fuse: clear stuck Thinking after missed terminal events ───────
  useEffect(() => {
    if (!isGenerating) return;

    const lastActivityAt = streamHook.lastEventTimestamp || generationStartedAtRef.current;
    if (!lastActivityAt) return;
    const delayMs = Math.max(0, STALE_GENERATION_CLEAR_MS - (Date.now() - lastActivityAt));

    const timer = setTimeout(() => {
      const latestActivityAt = streamHook.lastEventTimestamp || generationStartedAtRef.current;
      if (!latestActivityAt) return;
      const elapsed = Date.now() - latestActivityAt;
      if (elapsed < STALE_GENERATION_CLEAR_MS) return;
      const staleSessionKey = currentSessionRef.current;
      setIsGenerating(false);
      activeRunIdRef.current = null;
      streamHook.setProcessingStage(null);
      streamHook.setActivityLog([]);
      streamHook.setLastEventTimestamp(0);
      streamHook.clearStreamBuffer();
      streamHook.resetThinking();
      pruneRunRegistry(runsRef.current, null);
      if (!staleGenerationNoticeShownRef.current) {
        staleGenerationNoticeShownRef.current = true;
        appendSystemMessage('Jane stopped without a reply. I cleared the stuck working state. Send again or reset the session.');
      }
      if (staleSessionKey) {
        void rpc('chat.abort', { sessionKey: staleSessionKey }).catch(() => {
          // Best effort: the visible state is already cleared, but the gateway
          // may reject aborts on older or already-cleared runs.
        });
      }
    }, delayMs);

    return () => clearTimeout(timer);
  }, [
    appendSystemMessage,
    isGenerating,
    rpc,
    streamHook.lastEventTimestamp,
    streamHook.setProcessingStage,
    streamHook.setActivityLog,
    streamHook.setLastEventTimestamp,
    streamHook.clearStreamBuffer,
    streamHook.resetThinking,
  ]);

  // ─── Subscribe to streaming events ────────────────────────────────────────
  useEffect(() => {
    return subscribe((msg: GatewayEvent) => {
      let recoveryTriggeredThisEvent = false;
      const triggerRecoveryOnce = (reason: RecoveryReason) => {
        if (recoveryTriggeredThisEvent) return;
        recoveryTriggeredThisEvent = true;
        recoveryHook.triggerRecovery(reason);
      };

      const classified = classifyStreamEvent(msg);
      if (!classified) return;

      const currentSk = currentSessionRef.current;
      if (classified.sessionKey !== currentSk) {
        if (
          classified.source === 'chat'
          && classified.type === 'chat_final'
          && shouldReadBackgroundFinal(classified.sessionKey)
        ) {
          // Cron and Jane direct deliveries can arrive outside the active chat.
          // Speak them before the normal session filter drops unrelated UI noise.
          ttsHook.handleBackgroundTTS(extractFinalMessage(classified.chatPayload!));
        }
        const currentRootSession = getRootAgentSessionKey(currentSk);
        if (
          currentRootSession &&
          classified.sessionKey &&
          isSubagentSessionKey(classified.sessionKey) &&
          isRootChildSession(classified.sessionKey, currentRootSession) &&
          (classified.type === 'chat_final' || classified.type === 'lifecycle_end')
        ) {
          recoveryHook.triggerRecovery('subagent-complete');
        }
        return;
      }

      // Track gateway frame sequence
      if (typeof msg.seq === 'number') {
        if (hasSeqGap(lastGatewaySeqRef.current, msg.seq) && (isGeneratingRef.current || Boolean(activeRunIdRef.current))) {
          triggerRecoveryOnce('frame-gap');
        }
        lastGatewaySeqRef.current = updateHighestSeq(lastGatewaySeqRef.current, msg.seq);
      }

      const { type } = classified;

      // ── Agent events ────────────────────────────────────────────────────
      if (classified.source === 'agent') {
        const ap = classified.agentPayload!;

        if (type === 'lifecycle_start') {
          setIsGenerating(true);
          streamHook.setProcessingStage(readFastReplyMode(currentSessionRef.current) ? 'fast' : 'thinking');
          streamHook.setLastEventTimestamp(Date.now());
          return;
        }

        if (type === 'lifecycle_end') {
          setIsGenerating(false);
          streamHook.setProcessingStage(null);
          streamHook.setActivityLog([]);
          streamHook.setLastEventTimestamp(0);
          ttsHook.playCompletionPing();

          recoveryHook.incrementGeneration();

          const activeRun = activeRunIdRef.current;
          const runFinalized = activeRun ? runsRef.current.get(activeRun)?.finalized : false;
          if (!runFinalized) {
            recoveryHook.triggerRecovery('reconnect');
          }
          activeRunIdRef.current = null;
          return;
        }

        if (type === 'assistant_stream') {
          streamHook.setProcessingStage('streaming');
          streamHook.setLastEventTimestamp(Date.now());
          return;
        }

        const agentState = ap.state || ap.agentState;
        if (!isGeneratingRef.current && agentState && isActiveAgentState(agentState)) {
          setIsGenerating(true);
        }

        streamHook.setLastEventTimestamp(Date.now());

        if (type === 'agent_tool_start') {
          streamHook.setProcessingStage('tool_use');
          streamHook.addActivityEntry(ap);
          return;
        }

        if (type === 'agent_tool_result') {
          const completedId = ap.data?.toolCallId;
          if (completedId) streamHook.completeActivityEntry(completedId);

          if (toolResultRefreshRef.current) clearTimeout(toolResultRefreshRef.current);
          const capturedSession = currentSessionRef.current;
          const capturedGeneration = recoveryHook.getGeneration();
          toolResultRefreshRef.current = setTimeout(async () => {
            toolResultRefreshRef.current = null;
            try {
              const recovered = await loadChatHistory({ rpc, sessionKey: capturedSession, limit: 100 });
              if (capturedSession !== currentSessionRef.current) return;
              if (capturedGeneration !== recoveryHook.getGeneration()) return;
              if (recovered.length > 0) {
                const merged = dedupeReplayMessages(mergeRecoveredTail(msgHook.getAllMessages(), recovered));
                msgHook.applyMessageWindow(merged, false);
              }
            } catch { /* best-effort */ }
          }, 300);
          return;
        }

        if (type === 'agent_state' && agentState) {
          const stage = deriveProcessingStage(agentState);
          if (stage) {
            // In fast reply mode the gateway can still emit generic
            // "processing" states; keep the UI honest and avoid "Thinking".
            streamHook.setProcessingStage(stage === 'thinking' && readFastReplyMode(currentSessionRef.current) ? 'fast' : stage);
          }
        }
        return;
      }

      // ── Chat events ─────────────────────────────────────────────────────
      const cp = classified.chatPayload!;
      const activeRunBefore = activeRunIdRef.current;
      const runId = resolveRunId(classified.runId, activeRunBefore)
        ?? createFallbackRunId(currentSessionRef.current);

      const run = getOrCreateRunState(runsRef.current, runId, currentSessionRef.current);
      run.lastFrameSeq = updateHighestSeq(run.lastFrameSeq, classified.frameSeq);

      if (hasSeqGap(lastChatSeqRef.current, classified.chatSeq)) {
        triggerRecoveryOnce('chat-gap');
      }
      lastChatSeqRef.current = updateHighestSeq(lastChatSeqRef.current, classified.chatSeq);

      if (hasSeqGap(run.lastChatSeq, classified.chatSeq)) {
        triggerRecoveryOnce('chat-gap');
      }
      const prevRunSeq = run.lastChatSeq;
      run.lastChatSeq = updateHighestSeq(run.lastChatSeq, classified.chatSeq);

      streamHook.setLastEventTimestamp(Date.now());

      if (type === 'chat_started') {
        activeRunIdRef.current = runId;
        run.startedAt = Date.now();
        run.finalized = false;
        run.status = 'started';
        run.stopReason = undefined;
        run.bufferRaw = '';
        run.bufferText = '';

        setIsGenerating(true);
        ttsHook.resetPlayedSounds();
        const fastReplyMode = readFastReplyMode(currentSessionRef.current);
        streamHook.setProcessingStage(fastReplyMode ? 'fast' : 'thinking');
        streamHook.setActivityLog([]);
        if (fastReplyMode) {
          streamHook.resetThinking();
        } else {
          streamHook.startThinking(runId);
        }
        return;
      }

      if (type === 'chat_delta') {
        if (run.finalized) return;
        if (typeof classified.chatSeq === 'number' && prevRunSeq !== null && classified.chatSeq <= prevRunSeq) return;

        if (!isGeneratingRef.current) setIsGenerating(true);
        if (!activeRunIdRef.current) activeRunIdRef.current = runId;

        streamHook.captureThinkingDuration();

        const delta = extractStreamDelta(cp);
        if (delta) {
          run.bufferRaw = delta.text;
          run.bufferText = delta.cleaned;
          streamHook.scheduleStreamingUpdate(runId, run.bufferText);
          streamHook.setProcessingStage('streaming');
        }
        return;
      }

        if (type === 'chat_final') {
          if (run.finalized && run.status === 'ok') return;
          const isActiveRun = activeRunBefore !== null
            ? activeRunBefore === runId
            : isGeneratingRef.current;
          const shouldReadDetachedFinal = !isActiveRun && shouldReadBackgroundFinal(classified.sessionKey);

          run.finalized = true;
          run.status = 'ok';
        run.stopReason = cp.stopReason;
        run.bufferRaw = '';
        run.bufferText = '';

        if (activeRunIdRef.current === runId) activeRunIdRef.current = null;
        recoveryHook.incrementGeneration();

        if (isActiveRun) {
          setIsGenerating(false);
          streamHook.setProcessingStage(null);
          streamHook.setActivityLog([]);
          streamHook.setLastEventTimestamp(0);
          streamHook.clearStreamBuffer();
        }

        const finalData = extractFinalMessage(cp);
        const finalMessages = processChatMessages(extractFinalMessages(cp), {
          sessionKey: currentSessionRef.current || undefined,
        });

        if (finalMessages.length > 0) {
          const merged = dedupeReplayMessages(mergeFinalMessages(msgHook.getAllMessages(), finalMessages));
          const thinkingDuration = streamHook.getThinkingDuration(runId);
          const withDuration = thinkingDuration
            ? patchThinkingDuration(merged, thinkingDuration)
            : merged;
          msgHook.applyMessageWindow(withDuration, false);
        } else {
          recoveryHook.triggerRecovery('unrenderable-final');
        }

        if (shouldReadDetachedFinal) {
          // Jane direct replies can arrive as standalone finals without a
          // preceding started frame. They are still new user-visible replies.
          ttsHook.handleBackgroundTTS(finalData);
        } else {
          ttsHook.handleFinalTTS(finalData, isActiveRun);
        }
        streamHook.resetThinking();
        pruneRunRegistry(runsRef.current, activeRunIdRef.current);
        return;
      }

      if (type === 'chat_aborted') {
        const isActiveRun = activeRunBefore !== null
          ? activeRunBefore === runId
          : isGeneratingRef.current;

        run.finalized = true;
        run.status = undefined;
        run.stopReason = cp.stopReason || 'aborted';
        run.bufferRaw = '';
        run.bufferText = '';

        if (activeRunIdRef.current === runId) activeRunIdRef.current = null;
        recoveryHook.incrementGeneration();

        const partialMessagesRaw = extractFinalMessages(cp);
        if (partialMessagesRaw.length > 0) {
          const partialMessages = processChatMessages(partialMessagesRaw, {
            sessionKey: currentSessionRef.current || undefined,
          });
          if (partialMessages.length > 0) {
            const merged = mergeFinalMessages(msgHook.getAllMessages(), partialMessages);
            msgHook.applyMessageWindow(merged, false);
          }
        }

        if (isActiveRun) {
          setIsGenerating(false);
          streamHook.setProcessingStage(null);
          streamHook.setActivityLog([]);
          streamHook.setLastEventTimestamp(0);
          streamHook.clearStreamBuffer();
          ttsHook.playCompletionPing();
        }

        streamHook.resetThinking();
        pruneRunRegistry(runsRef.current, activeRunIdRef.current);
        return;
      }

      if (type === 'chat_error') {
        const isActiveRun = activeRunBefore !== null
          ? activeRunBefore === runId
          : isGeneratingRef.current;

        run.finalized = true;
        run.status = undefined;
        run.stopReason = cp.stopReason || cp.errorMessage || cp.error || 'error';
        run.bufferRaw = '';
        run.bufferText = '';

        if (activeRunIdRef.current === runId) activeRunIdRef.current = null;
        recoveryHook.incrementGeneration();

        if (isActiveRun) {
          setIsGenerating(false);
          streamHook.setProcessingStage(null);
          streamHook.setActivityLog([]);
          streamHook.setLastEventTimestamp(0);
          streamHook.clearStreamBuffer();
        }

        if (isActiveRun) {
          recoveryHook.triggerRecovery('unrenderable-final');
        }

        streamHook.resetThinking();
        pruneRunRegistry(runsRef.current, activeRunIdRef.current);
      }
    });
  }, [
    msgHook.getAllMessages,
    msgHook.applyMessageWindow,
    streamHook.setProcessingStage,
    streamHook.setLastEventTimestamp,
    streamHook.setActivityLog,
    streamHook.addActivityEntry,
    streamHook.completeActivityEntry,
    streamHook.startThinking,
    streamHook.captureThinkingDuration,
    streamHook.scheduleStreamingUpdate,
    streamHook.clearStreamBuffer,
    streamHook.getThinkingDuration,
    streamHook.resetThinking,
    recoveryHook.triggerRecovery,
    recoveryHook.incrementGeneration,
    recoveryHook.getGeneration,
    ttsHook.playCompletionPing,
    ttsHook.resetPlayedSounds,
    ttsHook.handleFinalTTS,
    ttsHook.handleBackgroundTTS,
    ttsHook.handleHistoryTTS,
    subscribe,
    rpc,
  ]);

  // ─── Send message ─────────────────────────────────────────────────────────
  const handleSend = useCallback(async (
    text: string,
    images?: ImageAttachment[],
    uploadPayload?: OutgoingUploadPayload,
    source: 'text' | 'live-voice' = 'text',
  ) => {
    let outboundText = text;
    let outboundImages = images;
    let outboundUploadPayload = uploadPayload;
    let forcedSessionKey: string | null = null;
    let bypassLongSessionPrompt = false;
    const isLiveVoice = source === 'live-voice';
    // Live voice always belongs to Jane's permanent Nerve session. A stale
    // manual Codex destination must never steal its transcript or readback.
    const codexRoute = isLiveVoice ? routeLiveVoiceMessage(outboundText) : routeCodexMessage(outboundText);
    outboundText = codexRoute.text;

    if (codexRoute.destination === 'codex') {
      const displayText = outboundText || 'Codex';
      const { msg: userMsg, tempId } = buildUserMessage({
        text: displayText,
        images: outboundImages,
        uploadPayload: outboundUploadPayload,
      });
      msgHook.setAllMessages(prev => [...prev, userMsg]);
      msgHook.setMessages((prev: ChatMsg[]) => [...prev, userMsg]);
      setIsGenerating(true);
      streamHook.setProcessingStage('fast');

      try {
        const reply = outboundText || 'Codex is listening.';
        const codexText = await appendFinanceContext(outboundText);
        const response = outboundText || outboundImages?.length || outboundUploadPayload
          ? await sendCodexDirectMessage(codexText, outboundImages, outboundUploadPayload)
          : { reply };
        const answer = response.reply || reply;
        const assistantMsg = buildCodexAssistantMessage(answer);
        const confirmMsg = (message: ChatMsg) => message.tempId === tempId ? { ...message, pending: false } : message;
        msgHook.setAllMessages(prev => [...prev.map(confirmMsg), assistantMsg]);
        msgHook.setMessages((prev: ChatMsg[]) => [...prev.map(confirmMsg), assistantMsg]);
        if (isLiveVoice) {
          ttsHook.trackVoiceMessage(displayText);
          ttsHook.handleFinalTTS({
            message: { role: 'assistant', content: answer } as never,
            text: answer,
            ttsText: answer,
            charts: [],
          }, true);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const failMsg = (item: ChatMsg) => item.tempId === tempId ? { ...item, pending: false, failed: true } : item;
        const errorMsg: ChatMsg = {
          msgId: generateMsgId(),
          role: 'system',
          html: renderMarkdown(`Codex send error: ${message}`),
          rawText: '',
          timestamp: new Date(),
        };
        msgHook.setAllMessages(prev => [...prev.map(failMsg), errorMsg]);
        msgHook.setMessages((prev: ChatMsg[]) => [...prev.map(failMsg), errorMsg]);
      } finally {
        setIsGenerating(false);
        streamHook.setProcessingStage(null);
      }
      return;
    }

    if (codexRoute.switched && !outboundText && !outboundImages?.length && !outboundUploadPayload) {
      appendSystemMessage('Jane is listening.');
      setIsGenerating(false);
      return;
    }

    const pendingLongSessionSend = deferredLongSessionSendRef.current;
    if (pendingLongSessionSend && !images?.length && !uploadPayload) {
      if (isYesReply(text)) {
        deferredLongSessionSendRef.current = null;
        forcedSessionKey = pendingLongSessionSend.sessionKey;
        outboundText = pendingLongSessionSend.text;
        outboundImages = pendingLongSessionSend.images;
        outboundUploadPayload = pendingLongSessionSend.uploadPayload;
        bypassLongSessionPrompt = true;

        try {
          await rpc('sessions.reset', { key: pendingLongSessionSend.sessionKey });
          if (pendingLongSessionSend.sessionKey === JANE_LIVE_VOICE_SESSION_KEY) {
            resetCodexRealtimeSessionSync();
          }
          appendSystemMessage('Session reset. Sending your saved message now.');
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e);
          appendSystemMessage(`Reset failed: ${errMsg}`);
          setIsGenerating(false);
          return;
        }
      } else if (isNoReply(text)) {
        deferredLongSessionSendRef.current = null;
        forcedSessionKey = pendingLongSessionSend.sessionKey;
        outboundText = pendingLongSessionSend.text;
        outboundImages = pendingLongSessionSend.images;
        outboundUploadPayload = pendingLongSessionSend.uploadPayload;
        bypassLongSessionPrompt = true;
        appendSystemMessage('Continuing in this session. Sending your saved message now.');
      } else {
        appendSystemMessage('Reply y to start fresh, or n to continue in this session.');
        setIsGenerating(false);
        return;
      }
    }

    const effectiveSessionKey = (isLiveVoice ? JANE_LIVE_VOICE_SESSION_KEY : forcedSessionKey)
      || currentSessionRef.current.trim()
      || pickDefaultSessionKey(sessions, currentSessionRef.current);

    if (!effectiveSessionKey) {
      setIsGenerating(false);
      const errMsgBubble: ChatMsg = {
        msgId: generateMsgId(),
        role: 'system',
        html: 'Send error: No active session available yet.',
        rawText: '',
        timestamp: new Date(),
      };
      msgHook.setAllMessages(prev => [...prev, errMsgBubble]);
      msgHook.setMessages((prev: ChatMsg[]) => [...prev, errMsgBubble]);
      return;
    }

    const wasGeneratingInEffectiveSession = isGeneratingRef.current
      && currentSessionRef.current === effectiveSessionKey;

    if (effectiveSessionKey !== currentSessionRef.current) {
      currentSessionRef.current = effectiveSessionKey;
      setCurrentSession(effectiveSessionKey);
    }

    if (shouldUseWakeBriefReply({ text: outboundText, images: outboundImages, uploadPayload: outboundUploadPayload })) {
      const { msg: userMsg } = buildUserMessage({ text: outboundText, images: outboundImages, uploadPayload: outboundUploadPayload });
      const localUserMsg: ChatMsg = {
        ...userMsg,
        pending: false,
        tempId: `${WAKE_BRIEF_LOCAL_TEMP_PREFIX}user-${Date.now()}`,
      };

      msgHook.setAllMessages(prev => [...prev, localUserMsg]);
      msgHook.setMessages((prev: ChatMsg[]) => [...prev, localUserMsg]);
      setIsGenerating(true);
      streamHook.setStream((prev: ChatStreamState) => ({ ...prev, html: '', runId: undefined }));
      streamHook.setProcessingStage('fast');

      try {
        const answer = await fetchWakeBriefAnswer();
        const assistantMsg = buildWakeBriefAssistantMessage(answer);
        msgHook.setAllMessages(prev => [...prev, assistantMsg]);
        msgHook.setMessages((prev: ChatMsg[]) => [...prev, assistantMsg]);

        if (outboundText.startsWith('[voice] ')) {
          ttsHook.trackVoiceMessage(outboundText);
        }
        ttsHook.handleFinalTTS({
          message: { role: 'assistant', content: answer.ttsText } as never,
          text: answer.ttsText,
          ttsText: answer.ttsText,
          charts: [],
        }, true);
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        const errMsgBubble: ChatMsg = {
          msgId: generateMsgId(),
          tempId: `${WAKE_BRIEF_LOCAL_TEMP_PREFIX}error-${Date.now()}`,
          role: 'system',
          html: `Wake brief is not ready: ${errMsg}`,
          rawText: '',
          timestamp: new Date(),
        };
        msgHook.setAllMessages(prev => [...prev, errMsgBubble]);
        msgHook.setMessages((prev: ChatMsg[]) => [...prev, errMsgBubble]);
      } finally {
        setIsGenerating(false);
        streamHook.setProcessingStage(null);
      }
      return;
    }

    ttsHook.trackVoiceMessage(outboundText);

    if (!bypassLongSessionPrompt) {
      const activeSession = sessions.find((session) => getSessionKey(session) === effectiveSessionKey);
      const percent = getSessionContextPercent(activeSession);
      if (percent !== null && percent >= LONG_SESSION_PROMPT_THRESHOLD) {
        deferredLongSessionSendRef.current = {
          sessionKey: effectiveSessionKey,
          text: outboundText,
          images: outboundImages,
          uploadPayload: outboundUploadPayload,
        };
        appendSystemMessage(`Session is getting long (${percent}%). Reply y to start fresh, or n to continue here.`);
        setIsGenerating(false);
        streamHook.setProcessingStage(null);
        return;
      }
    }

    const { msg: userMsg, tempId } = buildUserMessage({ text: outboundText, images: outboundImages, uploadPayload: outboundUploadPayload });
    let liveVoiceRecentContext = '';
    let liveVoiceDeliveredContextIds: string[] = [];
    const liveVoiceBootstrap = isLiveVoice && !isCodexRealtimeBootstrapDelivered();
    if (isLiveVoice) {
      const contextItems: LiveVoiceContextItem[] = [];
      try {
        const directHistory = await loadChatHistory({
          rpc,
          sessionKey: JANE_DIRECT_CHAT_SESSION_KEY,
          limit: 12,
        });
        contextItems.push(...directHistory
          .filter((message) => message.role === 'assistant' && message.rawText.trim())
          .slice(-3)
          .map((message) => ({
            text: message.rawText.trim(),
            createdAt: message.timestamp.getTime(),
          })));
      } catch {
        // Voice remains usable if the direct-session context refresh is unavailable.
      }

      if (shouldAttachLiveStatusContext(outboundText)) {
        try {
          const currentStatus = await fetchWakeBriefAnswer(fetch, true);
          contextItems.push({
            text: `Current verified OpenClaw status:\n${currentStatus.rawText}`,
            createdAt: Date.now(),
          });
        } catch {
          // Voice remains usable if the requested status snapshot cannot refresh.
        }
      }

      const contextDelta = buildLiveVoiceContextDelta(
        contextItems,
        readCodexRealtimeDeliveredContextIds(),
      );
      liveVoiceRecentContext = contextDelta.context;
      liveVoiceDeliveredContextIds = contextDelta.deliveredIds;
    }

    const activeRun = activeRunIdRef.current ? runsRef.current.get(activeRunIdRef.current) : null;
    const isSteeringActiveRun = Boolean(
      activeRun?.sessionKey === effectiveSessionKey
      || wasGeneratingInEffectiveSession,
    );

    if (!isSteeringActiveRun) {
      recoveryHook.incrementGeneration();
    }

    // Reuse the transcript bubble already streamed into chat; only execution is new.
    const streamedUserTurn = isLiveVoice && liveFinalUserRef.current?.text === outboundText.trim();
    if (!streamedUserTurn) {
      msgHook.setAllMessages(prev => [...prev, userMsg]);
      msgHook.setMessages((prev: ChatMsg[]) => [...prev, userMsg]);
    } else {
      liveFinalUserRef.current = null;
    }
    const fastReplyMode = readFastReplyMode(effectiveSessionKey);
    if (!isSteeringActiveRun) {
      setIsGenerating(true);
      streamHook.setStream((prev: ChatStreamState) => ({ ...prev, html: '', runId: undefined }));
      streamHook.setProcessingStage(fastReplyMode ? 'fast' : 'thinking');
    }

    const idempotencyKey = crypto.randomUUID ? crypto.randomUUID() : 'ik-' + Date.now();
    try {
      if (isLiveVoice && !liveVoiceSessionConfiguredRef.current) {
        try {
          await rpc('sessions.patch', {
            key: JANE_LIVE_VOICE_SESSION_KEY,
            label: 'Nerve Live',
            fastMode: fastReplyMode,
          });
          liveVoiceSessionConfiguredRef.current = true;
        } catch (configureError) {
          console.warn('[ChatContext] Could not pin the live voice coordinator session:', configureError);
        }
      }
      const canSteerActiveRun = isSteeringActiveRun && !outboundImages?.length && !outboundUploadPayload;
      const outboundTextWithFinance = await appendFinanceContext(outboundText);
      let ack: { runId?: string; status?: ChatSendStatus };
      if (canSteerActiveRun) {
        const steerMessage = isLiveVoice
          ? appendLiveVoiceCoordinatorContext(outboundTextWithFinance, liveVoiceRecentContext, liveVoiceBootstrap)
          : outboundTextWithFinance;
        const steerAck = await rpc('sessions.steer', { key: effectiveSessionKey, message: steerMessage }) as { runId?: unknown; status?: unknown };
        const status = typeof steerAck.status === 'string' && ['started', 'in_flight', 'ok'].includes(steerAck.status)
          ? steerAck.status as ChatSendStatus
          : 'started';
        ack = {
          runId: typeof steerAck.runId === 'string' ? steerAck.runId : undefined,
          status,
        };
      } else {
        ack = await sendChatMessage({
          rpc,
          sessionKey: effectiveSessionKey,
          text: outboundTextWithFinance,
          images: outboundImages,
          uploadPayload: outboundUploadPayload,
          idempotencyKey,
          fastMode: fastReplyMode,
          liveVoiceCoordinator: isLiveVoice,
          liveVoiceRecentContext,
          liveVoiceBootstrap,
        });
      }

      if (isLiveVoice) {
        markCodexRealtimeContextDelivered(liveVoiceDeliveredContextIds);
        if (liveVoiceBootstrap) markCodexRealtimeBootstrapDelivered();
      }

      if (ack.runId && canSteerActiveRun) {
        const run = getOrCreateRunState(runsRef.current, ack.runId, effectiveSessionKey);
        run.status = ack.status;
        run.finalized = false;
        activeRunIdRef.current = ack.runId;
      } else if (ack.runId && !isSteeringActiveRun) {
        const run = getOrCreateRunState(runsRef.current, ack.runId, effectiveSessionKey);
        run.status = ack.status;
        run.finalized = false;
        activeRunIdRef.current = ack.runId;
        if (fastReplyMode) {
          streamHook.resetThinking();
        } else {
          streamHook.startThinking(ack.runId);
        }
      }

      // Confirm the message (functional updater to avoid race after await)
      const confirmMsg = (m: ChatMsg) => m.tempId === tempId ? { ...m, pending: false } : m;
      msgHook.setAllMessages(prev => prev.map(confirmMsg));
      msgHook.setMessages((prev: ChatMsg[]) => prev.map(confirmMsg));
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);

      const failMsg = (m: ChatMsg) => m.tempId === tempId ? { ...m, pending: false, failed: true } : m;
      msgHook.setAllMessages(prev => prev.map(failMsg));
      msgHook.setMessages((prev: ChatMsg[]) => prev.map(failMsg));

      const errMsgBubble: ChatMsg = {
        msgId: generateMsgId(),
        role: 'system',
        html: 'Send error: ' + errMsg,
        rawText: '',
        timestamp: new Date(),
      };
      msgHook.setAllMessages(prev => [...prev, errMsgBubble]);
      msgHook.setMessages((prev: ChatMsg[]) => [...prev, errMsgBubble]);
      if (!isSteeringActiveRun) {
        setIsGenerating(false);
      }
    }
  }, [appendSystemMessage, currentSessionRef, msgHook, recoveryHook, rpc, sessions, setCurrentSession, streamHook, ttsHook]);

  // ─── Abort / Reset ────────────────────────────────────────────────────────
  const handleAbort = useCallback(async () => {
    try {
      await rpc('chat.abort', { sessionKey: currentSessionRef.current });
    } catch (err) {
      console.debug('[ChatContext] Abort request failed:', err);
    }
  }, [rpc]);

  const handleReset = useCallback(() => {
    setShowResetConfirm(true);
  }, []);

  const confirmReset = useCallback(async () => {
    setShowResetConfirm(false);
    try {
      await rpc('sessions.reset', { key: currentSessionRef.current });
      if (currentSessionRef.current === JANE_LIVE_VOICE_SESSION_KEY) {
        resetCodexRealtimeSessionSync();
      }
      const msg: ChatMsg = {
        msgId: generateMsgId(),
        role: 'system',
        html: '⚙️ Session reset. Starting fresh.',
        rawText: '',
        timestamp: new Date(),
      };
      msgHook.setAllMessages([msg]);
      msgHook.applyMessageWindow([msg], true);
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      const msg: ChatMsg = {
        msgId: generateMsgId(),
        role: 'system',
        html: `⚙️ Reset failed: ${errMsg}`,
        rawText: '',
        timestamp: new Date(),
      };
      msgHook.setAllMessages(prev => [...prev, msg]);
      msgHook.setMessages((prev: ChatMsg[]) => [...prev, msg]);
    }
  }, [msgHook, rpc]);

  const cancelReset = useCallback(() => {
    setShowResetConfirm(false);
  }, []);

  // ─── Context value ────────────────────────────────────────────────────────
  const value = useMemo<ChatContextValue>(() => ({
    messages: msgHook.messages,
    isGenerating,
    stream: streamHook.stream,
    processingStage: streamHook.processingStage,
    lastEventTimestamp: streamHook.lastEventTimestamp,
    activityLog: streamHook.activityLog,
    currentToolDescription: streamHook.currentToolDescription,
    handleSend,
    handleLiveTranscript,
    handleAbort,
    handleReset,
    loadHistory: msgHook.loadHistory,
    loadMore: msgHook.loadMore,
    hasMore: msgHook.hasMore,
    showResetConfirm,
    confirmReset,
    cancelReset,
  }), [
    msgHook.messages,
    isGenerating,
    streamHook.stream,
    streamHook.processingStage,
    streamHook.lastEventTimestamp,
    streamHook.activityLog,
    streamHook.currentToolDescription,
    handleSend,
    handleLiveTranscript,
    handleAbort,
    handleReset,
    msgHook.loadHistory,
    msgHook.loadMore,
    msgHook.hasMore,
    showResetConfirm,
    confirmReset,
    cancelReset,
  ]);

  return (
    <ChatContext.Provider value={value}>
      {children}
    </ChatContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components -- hook export is intentional
export function useChat() {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error('useChat must be used within ChatProvider');
  return ctx;
}
