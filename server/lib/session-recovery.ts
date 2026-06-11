import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config.js';

export const INVALID_ENCRYPTED_CONTENT_CODE = 'invalid_encrypted_content';

interface StoredSessionSummary {
  sessionId?: string;
  sessionFile?: string;
  updatedAt?: number;
  lastInteractionAt?: number;
  sessionStartedAt?: number;
  systemSent?: boolean;
  status?: string;
  error?: string;
  contextTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  totalTokensFresh?: boolean;
  usageFamilyKey?: string;
  usageFamilySessionIds?: string[];
  lastRecovery?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface InvalidEncryptedContentRecoveryResult {
  rotated: boolean;
  sessionKey: string;
  previousSessionId?: string;
  replacementSessionId?: string;
  reason?: string;
}

function sessionsFilePath(): string {
  return join(config.sessionsDir, 'sessions.json');
}

export function isInvalidEncryptedContentError(value: unknown): boolean {
  if (!value) return false;
  const text = typeof value === 'string'
    ? value
    : value instanceof Error
      ? value.message
      : JSON.stringify(value);
  return text.toLowerCase().includes(INVALID_ENCRYPTED_CONTENT_CODE);
}

export async function rotateSessionAfterInvalidEncryptedContent(
  sessionKey: string,
): Promise<InvalidEncryptedContentRecoveryResult> {
  const key = sessionKey.trim();
  if (!key) {
    return { rotated: false, sessionKey, reason: 'missing_session_key' };
  }

  const storePath = sessionsFilePath();
  const raw = await readFile(storePath, 'utf-8');
  const store = JSON.parse(raw) as Record<string, StoredSessionSummary | undefined>;
  const current = store[key];
  const previousSessionId = current?.sessionId;
  if (!current || !previousSessionId) {
    return { rotated: false, sessionKey: key, reason: 'session_not_found' };
  }

  if (current.lastRecovery?.reason === 'rotate_after_invalid_encrypted_content_llm_failures'
    && current.lastRecovery?.previousSessionId === previousSessionId) {
    return { rotated: false, sessionKey: key, previousSessionId, reason: 'already_rotated' };
  }

  await mkdir(config.sessionsDir, { recursive: true });
  const replacementSessionId = randomUUID();
  const replacementSessionFile = join(config.sessionsDir, `${replacementSessionId}.jsonl`);
  await writeFile(replacementSessionFile, '', { flag: 'wx' });

  const now = Date.now();
  const usageFamilySessionIds = Array.isArray(current.usageFamilySessionIds)
    ? current.usageFamilySessionIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
    : [];
  const nextUsageFamilySessionIds = usageFamilySessionIds.includes(previousSessionId)
    ? usageFamilySessionIds
    : [...usageFamilySessionIds, previousSessionId];

  store[key] = {
    ...current,
    sessionId: replacementSessionId,
    sessionFile: replacementSessionFile,
    updatedAt: now,
    lastInteractionAt: now,
    sessionStartedAt: now,
    systemSent: false,
    status: 'waiting',
    error: undefined,
    contextTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    totalTokensFresh: true,
    usageFamilyKey: current.usageFamilyKey || key,
    usageFamilySessionIds: nextUsageFamilySessionIds,
    lastRecovery: {
      at: new Date(now).toISOString(),
      reason: 'rotate_after_invalid_encrypted_content_llm_failures',
      action: 'rotated live session binding to clear stale encrypted conversation state after invalid_encrypted_content failures',
      previousSessionId,
      previousSessionFile: current.sessionFile || join(config.sessionsDir, `${previousSessionId}.jsonl`),
      replacementSessionId,
      replacementSessionFile,
    },
  };

  await writeFile(storePath, `${JSON.stringify(store, null, 2)}\n`, 'utf-8');
  return { rotated: true, sessionKey: key, previousSessionId, replacementSessionId };
}
