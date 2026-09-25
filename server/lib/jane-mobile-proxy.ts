import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { isJaneMobileCronControlRequest } from './jane-mobile-cron-control.js';

export const JANE_LIVE_SESSION_KEY = 'agent:main:voice:direct:nerve-live';
const JANE_CRON_SESSION_PREFIX = 'agent:main:cron:gated:';
const JANE_AGENT_ID = 'main';
const MAX_MESSAGE_CHARS = 64_000;
const MAX_HISTORY_LIMIT = 20;
const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_TALK_AUDIO_BYTES = 5 * 1024 * 1024;
const APPROVAL_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const APPROVAL_DECISIONS = ['allow-once', 'allow-always', 'deny'] as const;
type ApprovalDecision = typeof APPROVAL_DECISIONS[number];

export interface JanePublicProgress {
  state: 'started' | 'running' | 'completed' | 'failed';
  label: string;
  run_id?: string;
  tool?: string;
  phase?: string;
  query?: string;
  domain?: string;
  progress?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, limit: number): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, limit) : undefined;
}

function approvalId(value: unknown): string | undefined {
  return typeof value === 'string' && APPROVAL_ID_RE.test(value) ? value : undefined;
}

function approvalDecision(value: unknown): ApprovalDecision | undefined {
  return typeof value === 'string' && (APPROVAL_DECISIONS as readonly string[]).includes(value)
    ? value as ApprovalDecision : undefined;
}

function approvalSessionIsJane(payload: Record<string, unknown>): boolean {
  const request = isRecord(payload.request) ? payload.request : undefined;
  const sessionKeys = [payload.sessionKey, request?.sessionKey]
    .filter((candidate): candidate is string => typeof candidate === 'string');
  const agentIds = [payload.agentId, request?.agentId]
    .filter((candidate): candidate is string => typeof candidate === 'string');
  return sessionKeys.length > 0 && sessionKeys.every((candidate) => (
    candidate === JANE_LIVE_SESSION_KEY
    || candidate.startsWith(JANE_CRON_SESSION_PREFIX)
  )) && agentIds.every((candidate) => candidate === JANE_AGENT_ID);
}

function sanitizeApprovalEnvelope(payload: unknown, kind: 'exec' | 'plugin'): Record<string, unknown> | null {
  if (!isRecord(payload) || !approvalSessionIsJane(payload)) return null;
  const id = approvalId(payload.id);
  const createdAtMs = typeof payload.createdAtMs === 'number' && Number.isFinite(payload.createdAtMs) ? payload.createdAtMs : undefined;
  const expiresAtMs = typeof payload.expiresAtMs === 'number' && Number.isFinite(payload.expiresAtMs) ? payload.expiresAtMs : undefined;
  const request = isRecord(payload.request) ? payload.request : null;
  if (!id || !createdAtMs || !expiresAtMs || !request) return null;
  const safeRequest: Record<string, unknown> = {};
  const textKeys = kind === 'exec'
    ? ['command', 'commandPreview', 'warningText', 'agentId', 'host', 'cwd', 'security', 'ask']
    : ['title', 'description', 'pluginId', 'toolName', 'agentId', 'severity'];
  for (const key of textKeys) {
    const value = boundedText(request[key], key === 'description' ? 2_000 : 512);
    if (value) safeRequest[key] = value;
  }
  const suppliedDecisions = request.allowedDecisions;
  const decisions = Array.isArray(suppliedDecisions)
    ? suppliedDecisions.filter((value): value is ApprovalDecision => approvalDecision(value) !== undefined)
    : [];
  safeRequest.allowedDecisions = Array.isArray(suppliedDecisions) ? decisions : ['allow-once', 'deny'];
  return { id, createdAtMs, expiresAtMs, request: safeRequest };
}

function sanitizeApprovalResolved(payload: unknown): Record<string, unknown> | null {
  if (!isRecord(payload) || !approvalSessionIsJane(payload)) return null;
  const id = approvalId(payload.id);
  if (!id) return null;
  const decision = approvalDecision(payload.decision);
  return { id, ...(decision ? { decision } : {}) };
}

function sanitizeApprovalListPayload(payload: unknown, kind: 'exec' | 'plugin'): unknown {
  if (Array.isArray(payload)) return payload.flatMap((item) => {
    const safe = sanitizeApprovalEnvelope(item, kind);
    return safe ? [safe] : [];
  });
  if (!isRecord(payload)) return [];
  for (const key of ['approvals', 'pending', 'requests']) {
    if (Array.isArray(payload[key])) return { [key]: sanitizeApprovalListPayload(payload[key], kind) };
  }
  return [];
}

function nestedText(detail: Record<string, unknown>, key: string): string | undefined {
  for (const candidate of [detail, detail.input, detail.args, detail.arguments]) {
    if (isRecord(candidate)) {
      const value = boundedText(candidate[key], key === 'query' ? 240 : 512);
      if (value) return value;
    }
  }
  return undefined;
}

function publicToolMetadata(detail: Record<string, unknown>): {
  tool?: string;
  phase?: string;
  query?: string;
  domain?: string;
  progress?: string;
} {
  const tool = boundedText(detail.name ?? detail.tool ?? detail.toolName, 64)?.toLowerCase();
  const phase = boundedText(detail.phase, 32);
  const query = nestedText(detail, 'query');
  const rawUrl = nestedText(detail, 'url');
  let domain: string | undefined;
  if (rawUrl) {
    try { domain = new URL(rawUrl).hostname.slice(0, 120); } catch { /* keep malformed URLs out of the public envelope */ }
  }
  const progress = boundedText(detail.progress ?? detail.summary, 160);
  return { ...(tool ? { tool } : {}), ...(phase ? { phase } : {}), ...(query ? { query } : {}), ...(domain ? { domain } : {}), ...(progress ? { progress } : {}) };
}

/** Convert one gateway agent event into the bounded public activity envelope. */
export function extractJanePublicProgress(message: Record<string, unknown>): JanePublicProgress | null {
  if (message.type !== 'event' || message.event !== 'agent' || !isRecord(message.payload)) return null;
  if (message.payload.sessionKey !== JANE_LIVE_SESSION_KEY) return null;
  const stream = message.payload.stream;
  const detail = isRecord(message.payload.data) ? message.payload.data : {};
  let state: JanePublicProgress['state'] | null = null;
  let label = '';
  // Lifecycle labels are intentionally omitted: the Live orb shows concrete
  // tool activity, not generic "Jane started/completed" noise.
  if (stream === 'tool' && (detail.phase === 'start' || detail.phase === 'result')) {
    const metadata = publicToolMetadata(detail);
    const safeLabels: Record<string, string> = {
      bash: 'Checking local state', exec: 'Checking local state', read: 'Reading files',
      write: 'Writing files', edit: 'Editing files', web: 'Checking a source',
      web_search: 'Searching the web', web_fetch: 'Fetching a source', memory: 'Checking memory',
      memory_search: 'Searching memory', memory_get: 'Reading memory', cron: 'Checking schedules',
      sessions_list: 'Listing sessions', sessions_spawn: 'Starting a worker',
    };
    state = 'running';
    label = metadata.tool === 'web_search' && metadata.query
      ? `searching: ${metadata.query}`
      : metadata.tool === 'web_fetch' && metadata.domain
        ? `fetching: ${metadata.domain}`
        : safeLabels[metadata.tool || ''] || 'Working';
    const runId = typeof message.payload.runId === 'string'
      && /^[A-Za-z0-9._:-]{1,128}$/.test(message.payload.runId)
      ? message.payload.runId : undefined;
    return { state, label, ...metadata, ...(runId ? { run_id: runId } : {}) };
  }
  if (!state) return null;
  const runId = typeof message.payload.runId === 'string'
    && /^[A-Za-z0-9._:-]{1,128}$/.test(message.payload.runId)
    ? message.payload.runId : undefined;
  return { state, label, ...(runId ? { run_id: runId } : {}) };
}

function isLoopback(address: string | undefined): boolean {
  return address === '127.0.0.1'
    || address === '::1'
    || address === '::ffff:127.0.0.1';
}

function bearerToken(header: string | undefined): string {
  return header?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || '';
}

function safeTokenEqual(provided: string, expected: string): boolean {
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function authorizeJaneMobileBridge(req: IncomingMessage, expectedToken: string): boolean {
  if (!expectedToken || !isLoopback(req.socket.remoteAddress)) return false;
  return safeTokenEqual(bearerToken(req.headers.authorization), expectedToken);
}

function decodedBase64Bytes(value: string): number {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1) return -1;
  if (value.includes('=') && value.length % 4 !== 0) return -1;
  return Buffer.byteLength(value, 'base64');
}

function isAllowedJaneMobileTalkRequest(message: Record<string, unknown>, sessionId: string | undefined, createPending: boolean): boolean {
  if (message.type !== 'req' || typeof message.id !== 'string' || !message.id || message.id.length > 128 || !isRecord(message.params)) return false;
  const { method, params } = message;
  if (method === 'talk.session.create') {
    return !sessionId && !createPending
      && Object.keys(params).length === 7
      && params.sessionKey === JANE_LIVE_SESSION_KEY
      && params.mode === 'realtime'
      && params.transport === 'gateway-relay'
      && params.brain === 'agent-consult'
      && params.provider === 'openai'
      && params.model === 'gpt-live-1-codex'
      && params.language === 'ro';
  }
  if (!sessionId || params.sessionId !== sessionId || sessionId.length > 256) return false;
  if (method === 'talk.session.appendAudio') {
    const audioBytes = typeof params.audioBase64 === 'string' ? decodedBase64Bytes(params.audioBase64) : -1;
    return Object.keys(params).every((key) => ['sessionId', 'audioBase64', 'timestamp'].includes(key))
      && typeof params.audioBase64 === 'string'
      && params.audioBase64.length <= Math.ceil(MAX_TALK_AUDIO_BYTES / 3) * 4
      && audioBytes > 0 && audioBytes <= MAX_TALK_AUDIO_BYTES
      && (params.timestamp === undefined || (typeof params.timestamp === 'number' && Number.isFinite(params.timestamp)));
  }
  if (method === 'talk.session.cancelOutput') {
    return Object.keys(params).every((key) => ['sessionId', 'turnId', 'reason'].includes(key))
      && (params.turnId === undefined || (typeof params.turnId === 'string' && params.turnId.length <= 256))
      && (params.reason === undefined || (typeof params.reason === 'string' && params.reason.length <= 256));
  }
  if (method === 'talk.session.acknowledgeMark') {
    return Object.keys(params).length === 2
      && typeof params.markName === 'string'
      && params.markName.length > 0 && params.markName.length <= 128;
  }
  return method === 'talk.session.close' && Object.keys(params).length === 1;
}

function isAllowedJaneMobileConnect(message: Record<string, unknown>): boolean {
  if (message.type !== 'req' || message.method !== 'connect' || typeof message.id !== 'string') return false;
  if (!isRecord(message.params) || !isRecord(message.params.client) || !isRecord(message.params.auth)) return false;
  const { params } = message;
  const client = params.client as Record<string, unknown>;
  const auth = params.auth as Record<string, unknown>;
  const paramKeys = new Set(['minProtocol', 'maxProtocol', 'client', 'role', 'scopes', 'auth', 'caps']);
  const clientKeys = new Set(['id', 'version', 'platform', 'mode', 'instanceId']);
  const reservedBackend = client.id === 'gateway-client' && client.platform === 'server' && client.mode === 'backend';
  const janeBridge = (client.id === 'openclaw-control-ui' || client.id === 'jane-mobile-bridge') && client.platform === 'server' && client.mode === 'webchat';
  return !Object.keys(params).some((key) => !paramKeys.has(key))
    && !Object.keys(client).some((key) => !clientKeys.has(key))
    && Object.keys(auth).every((key) => key === 'token')
    && params.minProtocol === 4
    && params.maxProtocol === 4
    && (reservedBackend || janeBridge)
    && params.role === 'operator'
    && Array.isArray(params.scopes)
    && (reservedBackend
      ? params.scopes.length === 2 && params.scopes[0] === 'operator.read' && params.scopes[1] === 'operator.write'
      : client.id === 'jane-mobile-bridge'
        ? params.scopes.length === 3 && params.scopes[0] === 'operator.read' && params.scopes[1] === 'operator.write' && params.scopes[2] === 'operator.approvals'
        : params.scopes.length === 5
        && params.scopes[0] === 'operator.admin'
        && params.scopes[1] === 'operator.approvals'
        && params.scopes[2] === 'operator.pairing'
        && params.scopes[3] === 'operator.read'
        && params.scopes[4] === 'operator.write')
    && (reservedBackend ? (auth.token === undefined || typeof auth.token === 'string') : (auth.token === undefined || auth.token === ''))
    && Array.isArray(params.caps)
    && params.caps.length === 1
    && params.caps[0] === 'tool-events';
}

export function isAllowedJaneMobileChatSend(message: Record<string, unknown>): boolean {
  if (message.type !== 'req' || message.method !== 'chat.send' || typeof message.id !== 'string') return false;
  if (!isRecord(message.params)) return false;
  const params = message.params;
  const allowedKeys = new Set(['sessionKey', 'message', 'deliver', 'idempotencyKey', 'thinking', 'fastMode', 'attachments']);
  if (Object.keys(params).some((key) => !allowedKeys.has(key))) return false;
  if (params.sessionKey !== JANE_LIVE_SESSION_KEY || params.deliver !== false) return false;
  if (typeof params.message !== 'string' || params.message.length === 0 || params.message.length > MAX_MESSAGE_CHARS) return false;
  if (typeof params.idempotencyKey !== 'string' || !params.idempotencyKey) return false;
  if (params.thinking !== undefined && params.thinking !== 'low') return false;
  if (params.fastMode !== undefined && params.fastMode !== true) return false;

  if (params.attachments === undefined) return true;
  if (!Array.isArray(params.attachments) || params.attachments.length > MAX_ATTACHMENTS) return false;
  let totalBytes = 0;
  for (const attachment of params.attachments) {
    if (!isRecord(attachment) || typeof attachment.mimeType !== 'string' || !attachment.mimeType.startsWith('image/')) return false;
    if (typeof attachment.content !== 'string') return false;
    const size = decodedBase64Bytes(attachment.content);
    if (size < 0 || size > MAX_ATTACHMENT_BYTES) return false;
    totalBytes += size;
    if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) return false;
  }
  return true;
}

export function isAllowedJaneMobileChatHistory(message: Record<string, unknown>): boolean {
  if (message.type !== 'req' || message.method !== 'chat.history' || typeof message.id !== 'string') return false;
  if (!isRecord(message.params)) return false;
  const params = message.params;
  if (Object.keys(params).some((key) => key !== 'sessionKey' && key !== 'limit')) return false;
  if (params.sessionKey !== JANE_LIVE_SESSION_KEY) return false;
  return Number.isInteger(params.limit) && (params.limit as number) > 0 && (params.limit as number) <= MAX_HISTORY_LIMIT;
}

/** Allow only live-session model controls; never expose a general RPC tunnel. */
export function isAllowedJaneMobileSessionPatch(message: Record<string, unknown>): boolean {
  if (message.type !== 'req' || message.method !== 'sessions.patch' || typeof message.id !== 'string') return false;
  if (!isRecord(message.params)) return false;
  const params = message.params;
  const allowedKeys = new Set(['key', 'model', 'thinkingLevel', 'fastMode']);
  if (Object.keys(params).some((key) => !allowedKeys.has(key))) return false;
  if (params.key !== JANE_LIVE_SESSION_KEY) return false;
  if (params.model !== undefined && (typeof params.model !== 'string' || !/^[A-Za-z0-9._/@:+-]{1,200}$/.test(params.model))) return false;
  if (params.thinkingLevel !== undefined && !['off', 'low', 'medium', 'high'].includes(String(params.thinkingLevel))) return false;
  return params.fastMode === undefined || typeof params.fastMode === 'boolean';
}

/** Keep older installed Jane builds compatible with the current model names. */
export function normalizeJaneMobileClientFrame(data: Buffer | string, isBinary: boolean): Buffer | string {
  if (isBinary) return data;
  try {
    const message = JSON.parse(data.toString()) as unknown;
    if (!isRecord(message) || !isAllowedJaneMobileSessionPatch(message)) return data;
    const params = message.params as Record<string, unknown>;
    const modelAliases: Record<string, string> = {
      'openai/gpt-5.6-luna': 'openai/gpt-6-luna',
      'openai/gpt-5.6-sol': 'openai/gpt-6-sol',
      'openai/gpt-5.6-terra': 'openai/gpt-6-luna',
    };
    const model = typeof params.model === 'string' ? modelAliases[params.model] : undefined;
    return model ? JSON.stringify({ ...message, params: { ...params, model } }) : data;
  } catch {
    return data;
  }
}

export function isAllowedJaneMobileApprovalRequest(message: Record<string, unknown>): boolean {
  if (message.type !== 'req' || typeof message.id !== 'string') return false;
  const method = typeof message.method === 'string' ? message.method : '';
  if (!['exec.approval.list', 'plugin.approval.list', 'exec.approval.resolve', 'plugin.approval.resolve'].includes(method)) return false;
  if (!isRecord(message.params)) return false;
  const params = message.params;
  if (method.endsWith('.list')) return Object.keys(params).length === 0;
  if (Object.keys(params).length !== 2 || !Object.prototype.hasOwnProperty.call(params, 'id') || !Object.prototype.hasOwnProperty.call(params, 'decision')) return false;
  return approvalId(params.id) !== undefined && approvalDecision(params.decision) !== undefined;
}

export interface JaneMobileRelayPolicy {
  allowClientFrame(data: Buffer | string, isBinary: boolean): boolean;
  allowGatewayFrame(data: Buffer | string, isBinary: boolean): boolean;
  gatewayFrame(data: Buffer | string, isBinary: boolean): Buffer | string | null;
}

export function createJaneMobileRelayPolicy(): JaneMobileRelayPolicy {
  const requestIds = new Set<string>();
  const requestMethods = new Map<string, string>();
  const scopedApprovalDecisions = new Map<string, Set<ApprovalDecision>>();
  let talkSessionId: string | undefined;
  let talkRelaySessionId: string | undefined;
  let talkCreatePending = false;

  const rememberApprovalIds = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (isRecord(item) && typeof item.id === 'string' && isRecord(item.request)) {
          const decisions = Array.isArray(item.request.allowedDecisions)
            ? item.request.allowedDecisions.flatMap((decision) => {
              const safe = approvalDecision(decision);
              return safe ? [safe] : [];
            })
            : [];
          scopedApprovalDecisions.set(item.id, new Set(decisions));
        }
      }
    } else if (isRecord(value)) {
      for (const key of ['approvals', 'pending', 'requests']) rememberApprovalIds(value[key]);
    }
    return value;
  };

  const gatewayFrame = (data: Buffer | string, isBinary: boolean): Buffer | string | null => {
    if (isBinary) return null;
    try {
      const message = JSON.parse(data.toString()) as unknown;
      if (!isRecord(message)) return null;
      if (message.type === 'res' && typeof message.id === 'string') {
        const allowed = requestIds.has(message.id);
        const method = requestMethods.get(message.id);
        requestIds.delete(message.id);
        requestMethods.delete(message.id);
        if (!allowed) return null;
        if (method === 'talk.session.create') talkCreatePending = false;
        if (method === 'talk.session.create' && message.ok === true && isRecord(message.payload)) {
          const sessionId = message.payload.sessionId;
          const relaySessionId = message.payload.relaySessionId ?? message.payload.voiceSessionId ?? sessionId;
          if (typeof sessionId !== 'string' || !sessionId || typeof relaySessionId !== 'string' || !relaySessionId) return null;
          talkSessionId = sessionId;
          talkRelaySessionId = relaySessionId;
        }
        if (method === 'talk.session.close' && message.ok === true) {
          talkSessionId = undefined;
          talkRelaySessionId = undefined;
        }
        if ((method === 'exec.approval.list' || method === 'plugin.approval.list') && message.ok) {
          const safePayload = sanitizeApprovalListPayload(message.payload, method.startsWith('exec.') ? 'exec' : 'plugin');
          rememberApprovalIds(safePayload);
          return JSON.stringify({
            ...message,
            payload: safePayload,
          });
        }
        return data;
      }
      if (message.type !== 'event') return null;
      if (message.event === 'connect.challenge') return data;
      if (message.event === 'talk.event') {
        if (!isRecord(message.payload)) return null;
        if (!talkSessionId && talkCreatePending
          && message.payload.type === 'ready'
          && typeof message.payload.relaySessionId === 'string'
          && message.payload.relaySessionId.length > 0
          && message.payload.relaySessionId.length <= 256) {
          return JSON.stringify({
            type: 'event', event: 'talk.event',
            payload: { relaySessionId: message.payload.relaySessionId, type: 'ready' },
          });
        }
        if (!talkSessionId || !talkRelaySessionId) return null;
        const nested = isRecord(message.payload.talkEvent) ? message.payload.talkEvent : undefined;
        const hasRelayId = typeof message.payload.relaySessionId === 'string';
        const hasSessionId = typeof message.payload.sessionId === 'string' || typeof nested?.sessionId === 'string';
        const relayMatches = !hasRelayId || message.payload.relaySessionId === talkRelaySessionId;
        const sessionMatches = message.payload.sessionId === undefined || message.payload.sessionId === talkSessionId;
        const nestedMatches = nested?.sessionId === undefined || nested.sessionId === talkSessionId;
        return (hasRelayId || hasSessionId) && relayMatches && sessionMatches && nestedMatches ? data : null;
      }
      if (message.event === 'exec.approval.requested' || message.event === 'exec.approval.request') {
        const payload = sanitizeApprovalEnvelope(message.payload, 'exec');
        rememberApprovalIds([payload]);
        return payload ? JSON.stringify({ type: 'event', event: message.event, payload }) : null;
      }
      if (message.event === 'plugin.approval.requested') {
        const payload = sanitizeApprovalEnvelope(message.payload, 'plugin');
        rememberApprovalIds([payload]);
        return payload ? JSON.stringify({ type: 'event', event: message.event, payload }) : null;
      }
      if (message.event === 'exec.approval.resolved' || message.event === 'plugin.approval.resolved') {
        const payload = sanitizeApprovalResolved(message.payload);
        if (payload && typeof payload.id === 'string') scopedApprovalDecisions.delete(payload.id);
        return payload ? JSON.stringify({ type: 'event', event: message.event, payload }) : null;
      }
      if (!isRecord(message.payload) || message.payload.sessionKey !== JANE_LIVE_SESSION_KEY) return null;
      if (message.event === 'chat') {
        // Live finals are the canonical result the native client must render;
        // suppressing them here left the phone with only the realtime filler.
        return data;
      }
      const progress = extractJanePublicProgress(message);
      if (!progress) return null;
      return JSON.stringify({
        type: 'event',
        event: 'nerve.agent.progress',
        payload: progress,
      });
    } catch {
      return null;
    }
  };

  return {
    allowClientFrame(data, isBinary) {
      if (isBinary) return false;
      try {
        const message = JSON.parse(data.toString()) as unknown;
        if (!isRecord(message) || message.type !== 'req' || typeof message.id !== 'string') return false;
        if (requestIds.size >= 256) return false;
        if (message.method === 'connect' && isAllowedJaneMobileConnect(message)) {
          requestIds.add(message.id);
          requestMethods.set(message.id, message.method);
          return true;
        }
        if (isAllowedJaneMobileApprovalRequest(message)) {
          const method = String(message.method);
          if (method.endsWith('.resolve')) {
            const params = message.params as Record<string, unknown>;
            const decisions = scopedApprovalDecisions.get(params.id as string);
            if (!decisions?.has(params.decision as ApprovalDecision)) return false;
          }
          requestIds.add(message.id);
          requestMethods.set(message.id, message.method as string);
          return true;
        }
        if (isJaneMobileCronControlRequest(message)) return true;
        if (isAllowedJaneMobileTalkRequest(message, talkSessionId, talkCreatePending)) {
          if (message.method === 'talk.session.create') talkCreatePending = true;
          requestIds.add(message.id);
          requestMethods.set(message.id, message.method as string);
          return true;
        }
        if (isAllowedJaneMobileSessionPatch(message)) {
          requestIds.add(message.id);
          requestMethods.set(message.id, message.method as string);
          return true;
        }
        if (isAllowedJaneMobileChatHistory(message)) {
          requestIds.add(message.id);
          requestMethods.set(message.id, message.method as string);
          return true;
        }
        if (!isAllowedJaneMobileChatSend(message)) return false;
        requestIds.add(message.id);
        requestMethods.set(message.id, message.method as string);
        return true;
      } catch {
        return false;
      }
    },

    allowGatewayFrame(data, isBinary) {
      return gatewayFrame(data, isBinary) !== null;
    },
    gatewayFrame,
  };
}

export function gatewayWebSocketUrl(gatewayUrl: string): URL {
  const target = new URL(gatewayUrl.replace(/^http/, 'ws'));
  if (!target.pathname.endsWith('/ws')) target.pathname = `${target.pathname.replace(/\/$/, '')}/ws`;
  return target;
}
