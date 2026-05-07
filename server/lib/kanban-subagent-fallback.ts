/**
 * Server-side Kanban subagent launch helper.
 *
 * Kanban tasks should run as real child sessions under an existing top-level
 * agent root, not as synthetic message conventions that hope the parent will
 * spawn on our behalf.
 *
 * Historical note: the surrounding route code still uses the word “fallback”
 * because assigned-root execution originally existed as a macOS-specific
 * workaround. The transport here is now a first-class session primitive.
 *
 * @module
 */

import { randomUUID } from 'node:crypto';
import { resolveKanbanAssigneeRootSessionKey } from './kanban-assignee.js';
import { gatewayRpcCall } from './gateway-rpc.js';
import { findExistingSpawnedChildSessionKey } from './subagent-spawn.js';

export interface KanbanFallbackLaunchResult {
  /** Deterministic correlation key stored on the task run link. */
  sessionKey: string;
  /** Existing top-level agent root that owns the spawned child. */
  parentSessionKey: string;
  /** Real worker session created under the selected parent root. */
  childSessionKey: string;
  /** Back-compat snapshot hook for older poller logic. */
  knownSessionKeysBefore: string[];
  /** Optional runId returned by the initial session send. */
  runId?: string;
}

/**
 * Generate a deterministic Kanban run correlation key from a launch label.
 *
 * Historical note: the run link field is still named `sessionKey`, but for
 * Kanban execution this value is only a stable run correlation key. The real
 * worker session key is attached separately as `childSessionKey`.
 */
export function buildKanbanFallbackRunKey(label: string): string {
  const normalized = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return `kanban-root:${normalized}`;
}

/** Resolve the owning top-level worker root session for a task assignee. */
export function resolveKanbanFallbackParentSessionKey(assignee?: string): string | null {
  return resolveKanbanAssigneeRootSessionKey(assignee);
}


function ensureDistinctWorkerAndCheckerLanes(params: { workerLane?: string; checkerLane?: string }): void {
  if (!params.workerLane || !params.checkerLane) return;
  if (params.workerLane === params.checkerLane) {
    throw new Error(`workerLane and checkerLane must be different: ${params.workerLane}`);
  }
}

function buildSpawnPayload(params: {
  label: string;
  parentSessionKey: string;
  model?: string;
  workerLane?: string;
  checkerLane?: string;
  key: string;
}): Record<string, unknown> {
  ensureDistinctWorkerAndCheckerLanes(params);
  return {
    key: params.key,
    parentSessionKey: params.parentSessionKey,
    context: 'isolated',
    workerLane: params.workerLane ?? 'fast-worker',
    checkerLane: params.checkerLane ?? 'ledger',
    label: params.label,
    ...(params.model ? { model: params.model } : {}),
  };
}

function buildChildSessionKey(parentSessionKey: string): string {
  const match = parentSessionKey.match(/^agent:([^:]+):main$/);
  if (!match) {
    throw new Error(`Parent agent session must be a top-level root: ${parentSessionKey}`);
  }
  return `agent:${match[1]}:subagent:${randomUUID()}`;
}

function isLabelAlreadyInUseError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes('label already in use');
}

/**
 * Launch a Kanban task as a real child session under an existing top-level
 * agent root.
 */
export async function launchKanbanFallbackSubagentViaRpc(params: {
  label: string;
  task: string;
  parentSessionKey: string;
  model?: string;
  thinking?: string;
  workerLane?: string;
  checkerLane?: string;
}): Promise<KanbanFallbackLaunchResult> {
  const sessionKey = buildKanbanFallbackRunKey(params.label);
  const childSessionKey = buildChildSessionKey(params.parentSessionKey);
  let createResponse: { key?: string; sessionKey?: string };
  try {
    createResponse = await gatewayRpcCall('sessions.create', buildSpawnPayload({
      label: params.label,
      parentSessionKey: params.parentSessionKey,
      model: params.model,
      workerLane: params.workerLane,
      checkerLane: params.checkerLane,
      key: childSessionKey,
    })) as { key?: string; sessionKey?: string };
  } catch (error) {
    if (!isLabelAlreadyInUseError(error)) {
      throw error;
    }

    const existingChildSessionKey = await findExistingSpawnedChildSessionKey({
      parentSessionKey: params.parentSessionKey,
      label: params.label,
      requestedKey: childSessionKey,
    });
    if (!existingChildSessionKey) {
      throw error;
    }

    createResponse = { key: existingChildSessionKey };
  }

  const resolvedChildSessionKey = typeof createResponse.key === 'string' && createResponse.key.trim()
    ? createResponse.key
    : typeof createResponse.sessionKey === 'string' && createResponse.sessionKey.trim()
      ? createResponse.sessionKey
      : childSessionKey;

  let sendResponse: { runId?: string };
  try {
    sendResponse = await gatewayRpcCall('sessions.send', {
      key: resolvedChildSessionKey,
      message: params.task,
      ...(params.thinking ? { thinking: params.thinking } : {}),
      idempotencyKey: `kanban-subagent:${params.parentSessionKey}:${params.label}:${resolvedChildSessionKey}`,
    }) as { runId?: string };
  } catch (error) {
    try {
      await gatewayRpcCall('sessions.delete', {
        key: resolvedChildSessionKey,
        deleteTranscript: true,
      });
    } catch {
      // Best-effort cleanup only; preserve the original launch failure.
    }
    throw error;
  }

  return {
    sessionKey,
    parentSessionKey: params.parentSessionKey,
    childSessionKey: resolvedChildSessionKey,
    knownSessionKeysBefore: [params.parentSessionKey],
    runId: sendResponse.runId,
  };
}
