import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { WebSocket } from 'ws';

const CODEX_APP_BINARY = '/Applications/ChatGPT.app/Contents/Resources/codex';
const DEVICECHECK_MODULE = '/Applications/ChatGPT.app/Contents/Resources/native/devicecheck.node';
const MAX_MESSAGE_BYTES = 1024 * 1024;
const VOICES = new Set([
  'arbor', 'breeze', 'cove', 'ember', 'juniper', 'maple', 'sol', 'spruce', 'vale',
]);
const CLIENT_METHODS = new Set([
  'thread/realtime/start',
  'thread/realtime/appendText',
  'thread/realtime/stop',
  'thread/realtime/listVoices',
]);
const REALTIME_ITEM_METHODS = new Set([
  'thread/realtime/item/started',
  'thread/realtime/item/transcript/delta',
  'thread/realtime/item/completed',
]);
const NATIVE_APPROVAL_METHODS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
]);
const NATIVE_APPROVAL_DECISIONS = new Set(['accept', 'acceptForSession', 'decline', 'cancel']);
const VOICE_PROMPT = 'Ești Jane, asistenta live a lui Alex. Vorbește natural și concis în limba conversației, implicit română. Răspunde direct din context când poți. Când cererea are nevoie de date, instrumente sau o acțiune, deleagă o singură dată către backendul Codex al acestei conversații și continuă numai cu rezultate confirmate. Nu spune automat că verifici și nu pretinde că o acțiune a reușit înainte de confirmare.';
const JANE_REALTIME_STATE_PATH = 'jane-live-realtime.json';

interface JsonMessage {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

interface DeviceCheckResult {
  supported: boolean;
  tokenBase64?: string;
}

type GenerateToken = () => DeviceCheckResult | Promise<DeviceCheckResult>;
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resolveFirst(paths: Array<string | undefined>): string | null {
  return paths.find((candidate): candidate is string => !!candidate && existsSync(candidate)) ?? null;
}

function janeRealtimeStatePath(): string {
  return process.env.NERVE_JANE_REALTIME_STATE_PATH
    || join(process.env.NERVE_DATA_DIR || join(homedir(), '.nerve'), JANE_REALTIME_STATE_PATH);
}

async function readPersistedRealtimeThreadId(): Promise<string | null> {
  try {
    const state = JSON.parse(await readFile(janeRealtimeStatePath(), 'utf8')) as { threadId?: unknown };
    return typeof state.threadId === 'string' && state.threadId.trim() ? state.threadId.trim() : null;
  } catch {
    return null;
  }
}

async function persistRealtimeThreadId(threadId: string): Promise<void> {
  const target = janeRealtimeStatePath();
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(temp, `${JSON.stringify({ threadId })}\n`, { mode: 0o600 });
  await rename(temp, target);
}

export function codexRealtimeEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...source };
  delete env.OPENAI_API_KEY;
  delete env.OPENAI_BASE_URL;
  return env;
}

export function buildJaneRealtimeThreadRequest(
  id: number,
  persistedThreadId: string | null,
): JsonMessage {
  if (persistedThreadId) {
    return { id, method: 'thread/resume', params: { threadId: persistedThreadId } };
  }
  return {
    id,
    method: 'thread/start',
    params: {
      cwd: process.env.OPENCLAW_HOME || join(homedir(), '.openclaw'),
      ephemeral: false,
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      historyMode: 'paginated',
      config: { features: { realtime_conversation: true } },
    },
  };
}

export function normalizeCodexRealtimeRequest(message: JsonMessage, threadId: string): JsonMessage | null {
  if (!message.method || !CLIENT_METHODS.has(message.method)) return null;

  const params = isRecord(message.params) ? message.params : {};
  if (message.method === 'thread/realtime/start') {
    const transport = isRecord(params.transport) ? params.transport : null;
    const sdp = transport?.type === 'webrtc' && typeof transport.sdp === 'string'
      ? transport.sdp
      : null;
    if (!sdp || sdp.length > MAX_MESSAGE_BYTES) return null;

    return {
      id: message.id,
      method: message.method,
      params: {
        threadId,
        outputModality: 'audio',
        prompt: VOICE_PROMPT,
        version: 'v3',
        voice: typeof params.voice === 'string' && VOICES.has(params.voice) ? params.voice : 'juniper',
        clientManagedHandoffs: false,
        includeStartupContext: false,
        realtimeStartInstructions: VOICE_PROMPT,
        flushTranscriptTailOnSessionEnd: false,
        transport: { type: 'webrtc', sdp },
      },
    };
  }

  if (message.method === 'thread/realtime/appendText') {
    if (typeof params.text !== 'string' || !params.text.trim()) return null;
    const role = ['user', 'developer', 'assistant'].includes(String(params.role)) ? params.role : 'user';
    return { id: message.id, method: message.method, params: { threadId, role, text: params.text.slice(0, 12_000) } };
  }

  return { id: message.id, method: message.method, params: { threadId } };
}

function loadGenerateToken(): GenerateToken {
  const modulePath = resolveFirst([process.env.CODEX_DEVICECHECK_PATH, DEVICECHECK_MODULE]);
  if (!modulePath) throw new Error('ChatGPT device attestation is unavailable');
  const nativeModule = createRequire(import.meta.url)(modulePath) as { generateToken?: GenerateToken };
  if (typeof nativeModule.generateToken !== 'function') throw new Error('ChatGPT device attestation is unavailable');
  return nativeModule.generateToken;
}

function writeJson(child: ChildProcessWithoutNullStreams, message: JsonMessage): void {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function sendJson(ws: WebSocket, message: JsonMessage): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

export function nativeApprovalForClient(message: JsonMessage): JsonMessage | null {
  if (message.id === undefined || !message.method || !NATIVE_APPROVAL_METHODS.has(message.method)) return null;
  const params = isRecord(message.params) ? message.params : {};
  const safe: Record<string, unknown> = {};
  for (const key of ['threadId', 'turnId', 'itemId', 'kind', 'command', 'cwd', 'reason', 'startedAtMs']) {
    const value = params[key];
    if (typeof value === 'string') safe[key] = value.slice(0, key === 'command' ? 4_000 : 512);
    else if (key === 'startedAtMs' && typeof value === 'number' && Number.isFinite(value)) safe[key] = value;
  }
  if (Array.isArray(params.availableDecisions)) {
    safe.availableDecisions = params.availableDecisions.filter(
      (value): value is string => typeof value === 'string' && NATIVE_APPROVAL_DECISIONS.has(value),
    );
  }
  return { id: message.id, method: message.method, params: safe };
}

export function nativeApprovalDecision(message: JsonMessage): string | null {
  if (!isRecord(message.result) || typeof message.result.decision !== 'string') return null;
  return NATIVE_APPROVAL_DECISIONS.has(message.result.decision) ? message.result.decision : null;
}

/** Bind one authenticated Nerve socket to the persisted Codex GPT-Live host. */
export function createCodexRealtimeRelay(ws: WebSocket): void {
  const codexBin = resolveFirst([
    process.env.CODEX_BIN,
    CODEX_APP_BINARY,
    join(homedir(), '.local', 'bin', 'codex'),
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
  ]);
  if (!codexBin) {
    ws.close(1011, 'Codex desktop runtime not found');
    return;
  }

  const child = spawn(codexBin, ['app-server'], {
    cwd: process.env.OPENCLAW_HOME || join(homedir(), '.openclaw'),
    env: codexRealtimeEnvironment(process.env),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = createInterface({ input: child.stdout });
  const clientIds = new Map<number, string | number | undefined>();
  const nativeApprovalIds = new Set<string | number>();
  let nextId = 1000;
  let threadId: string | null = null;
  let closed = false;
  let lastStderr = '';

  const close = (reason?: string) => {
    if (closed) return;
    closed = true;
    lines.close();
    if (!child.killed) child.kill('SIGTERM');
    if (reason && ws.readyState === WebSocket.OPEN) ws.close(1011, reason);
  };

  writeJson(child, {
    id: 1,
    method: 'initialize',
    params: {
      clientInfo: { name: 'openclaw_nerve', title: 'OpenClaw Nerve', version: '1.0.0' },
      capabilities: { experimentalApi: true, requestAttestation: true },
    },
  });

  lines.on('line', (line) => {
    let message: JsonMessage;
    try {
      message = JSON.parse(line) as JsonMessage;
    } catch {
      return;
    }

    if (message.method === 'attestation/generate' && message.id !== undefined) {
      void Promise.resolve()
        .then(() => loadGenerateToken()())
        .then((result) => {
          if (!result.supported || !result.tokenBase64) throw new Error('unsupported');
          writeJson(child, { id: message.id, result: { token: result.tokenBase64 } });
        })
        .catch(() => writeJson(child, {
          id: message.id,
          error: { code: -32000, message: 'Device attestation unavailable' },
        }));
      return;
    }

    if (message.id === 1) {
      if (message.error) {
        close('Codex desktop initialization failed');
        return;
      }
      writeJson(child, { method: 'initialized' });
      void (async () => {
        const persisted = await readPersistedRealtimeThreadId();
        writeJson(child, buildJaneRealtimeThreadRequest(2, persisted));
      })().catch(() => close('Codex voice host failed to prepare thread'));
      return;
    }

    if (message.id === 2) {
      if (message.error) {
        writeJson(child, buildJaneRealtimeThreadRequest(3, null));
        return;
      }
      const result = isRecord(message.result) ? message.result : null;
      const thread = result && isRecord(result.thread) ? result.thread : null;
      threadId = thread && typeof thread.id === 'string' ? thread.id : null;
      if (!threadId) {
        close('Codex voice host failed to start');
        return;
      }
      void persistRealtimeThreadId(threadId).catch(() => undefined);
      sendJson(ws, { method: 'nerve/realtime/ready', params: {} });
      return;
    }

    if (message.id === 3) {
      const result = isRecord(message.result) ? message.result : null;
      const thread = result && isRecord(result.thread) ? result.thread : null;
      threadId = thread && typeof thread.id === 'string' ? thread.id : null;
      if (!threadId) {
        close('Codex voice host failed to start');
        return;
      }
      void persistRealtimeThreadId(threadId).catch(() => undefined);
      sendJson(ws, { method: 'nerve/realtime/ready', params: {} });
      return;
    }

    if (typeof message.id === 'number' && clientIds.has(message.id)) {
      const clientId = clientIds.get(message.id);
      clientIds.delete(message.id);
      sendJson(ws, { ...message, id: clientId });
      return;
    }

    const nativeApproval = nativeApprovalForClient(message);
    if (nativeApproval) {
      nativeApprovalIds.add(message.id!);
      sendJson(ws, nativeApproval);
      return;
    }

    const isRealtimeItemEvent = Boolean(message.method && REALTIME_ITEM_METHODS.has(message.method)
      && isRecord(message.params)
      && (message.params.threadId === undefined || message.params.threadId === threadId));
    if (message.method?.startsWith('thread/realtime/') || isRealtimeItemEvent) {
      sendJson(ws, message);
    }
  });

  ws.on('message', (data, isBinary) => {
    const byteLength = Array.isArray(data)
      ? data.reduce((total, part) => total + part.byteLength, 0)
      : data.byteLength;
    if (isBinary || byteLength > MAX_MESSAGE_BYTES || !threadId) {
      ws.close(1008, 'Invalid Codex realtime message');
      return;
    }
    let incoming: JsonMessage;
    try {
      incoming = JSON.parse(data.toString()) as JsonMessage;
    } catch {
      ws.close(1008, 'Invalid Codex realtime message');
      return;
    }
    if (incoming.id !== undefined && incoming.method === undefined && nativeApprovalIds.has(incoming.id)) {
      const decision = nativeApprovalDecision(incoming);
      if (!decision) {
        sendJson(ws, { id: incoming.id, error: { code: -32602, message: 'Invalid approval decision' } });
        return;
      }
      nativeApprovalIds.delete(incoming.id);
      writeJson(child, { id: incoming.id, result: { decision } });
      return;
    }
    const normalized = normalizeCodexRealtimeRequest(incoming, threadId);
    if (!normalized) {
      sendJson(ws, { id: incoming.id, error: { code: -32601, message: 'Realtime method not allowed' } });
      return;
    }
    const internalId = nextId++;
    clientIds.set(internalId, incoming.id);
    writeJson(child, { ...normalized, id: internalId });
  });

  ws.on('close', () => close());
  ws.on('error', () => close());
  child.on('error', () => close('Codex desktop runtime failed'));
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    const lines = chunk.trim().split('\n').filter(Boolean);
    if (lines.length) lastStderr = lines.at(-1)!.slice(0, 500);
  });
  child.on('exit', (code, signal) => {
    console.warn('[codex-realtime] host exited', { code, signal, detail: lastStderr || undefined });
    close('Codex desktop runtime stopped');
  });
}
