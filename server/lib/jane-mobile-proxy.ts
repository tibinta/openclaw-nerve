import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { isJaneMobileCronControlRequest } from './jane-mobile-cron-control.js';

const JANE_LIVE_SESSION_KEY = 'agent:jane-whitmore---ceo:voice:direct:nerve-live';
const MAX_MESSAGE_CHARS = 64_000;
const MAX_HISTORY_LIMIT = 20;
const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 10 * 1024 * 1024;

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
  return Buffer.byteLength(value, 'base64');
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
        ? params.scopes.length === 2 && params.scopes[0] === 'operator.read' && params.scopes[1] === 'operator.write'
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

export interface JaneMobileRelayPolicy {
  allowClientFrame(data: Buffer | string, isBinary: boolean): boolean;
  allowGatewayFrame(data: Buffer | string, isBinary: boolean): boolean;
  gatewayFrame(data: Buffer | string, isBinary: boolean): Buffer | string | null;
}

export function createJaneMobileRelayPolicy(): JaneMobileRelayPolicy {
  const requestIds = new Set<string>();

  const gatewayFrame = (data: Buffer | string, isBinary: boolean): Buffer | string | null => {
    if (isBinary) return null;
    try {
      const message = JSON.parse(data.toString()) as unknown;
      if (!isRecord(message)) return null;
      if (message.type === 'res' && typeof message.id === 'string') {
        const allowed = requestIds.has(message.id);
        requestIds.delete(message.id);
        return allowed ? data : null;
      }
      if (message.type !== 'event') return null;
      if (message.event === 'connect.challenge') return data;
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
          return true;
        }
        if (isJaneMobileCronControlRequest(message)) return true;
        if (isAllowedJaneMobileChatHistory(message)) {
          requestIds.add(message.id);
          return true;
        }
        if (!isAllowedJaneMobileChatSend(message)) return false;
        requestIds.add(message.id);
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
