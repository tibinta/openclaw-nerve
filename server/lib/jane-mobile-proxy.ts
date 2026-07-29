import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';

const JANE_LIVE_SESSION_KEY = 'agent:jane-whitmore---ceo:voice:direct:nerve-live';
const MAX_MESSAGE_CHARS = 64_000;
const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 10 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

export interface JaneMobileRelayPolicy {
  allowClientFrame(data: Buffer | string, isBinary: boolean): boolean;
  allowGatewayFrame(data: Buffer | string, isBinary: boolean): boolean;
}

export function createJaneMobileRelayPolicy(): JaneMobileRelayPolicy {
  const requestIds = new Set<string>();

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
        if (!isAllowedJaneMobileChatSend(message)) return false;
        requestIds.add(message.id);
        return true;
      } catch {
        return false;
      }
    },

    allowGatewayFrame(data, isBinary) {
      if (isBinary) return false;
      try {
        const message = JSON.parse(data.toString()) as unknown;
        if (!isRecord(message)) return false;
        if (message.type === 'res' && typeof message.id === 'string') {
          const allowed = requestIds.has(message.id);
          requestIds.delete(message.id);
          return allowed;
        }
        if (message.type !== 'event') return false;
        if (message.event === 'connect.challenge') return true;
        if (message.event !== 'chat' || !isRecord(message.payload)) return false;
        return message.payload.sessionKey === JANE_LIVE_SESSION_KEY
          && !(typeof message.payload.runId === 'string' && message.payload.runId.startsWith('jane-realtime:'));
      } catch {
        return false;
      }
    },
  };
}

export function gatewayWebSocketUrl(gatewayUrl: string): URL {
  const target = new URL(gatewayUrl.replace(/^http/, 'ws'));
  if (!target.pathname.endsWith('/ws')) target.pathname = `${target.pathname.replace(/\/$/, '')}/ws`;
  return target;
}
