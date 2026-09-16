import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { WebSocket, type RawData } from 'ws';
import { subscribeGatewayEvents } from './gateway-rpc.js';
import { extractJanePublicProgress } from './jane-mobile-proxy.js';

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
const VOICE_PROMPT = 'Ești Jane. Vorbește natural și concis, implicit în română. Pentru date sau acțiuni, deleagă o singură dată și continuă conversația. Arată progresul. Spune că o modificare este gata numai după confirmarea instrumentului; altfel spune exact eroarea. Cere aprobare numai pentru o cerere concretă.';
const JANE_REALTIME_STATE_PATH = 'jane-live-realtime.json';
const MAX_TRANSCRIPT_ENTRIES = 200;
const NATIVE_APPROVAL_TTL_MS = 10 * 60_000;
const SPEECH_ACK_TIMEOUT_MS = 20_000;

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

interface RealtimeTranscriptEntry {
  id: string;
  seq: number;
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;
}

interface RealtimeState {
  threadId?: string;
  transcript?: RealtimeTranscriptEntry[];
}

export interface JaneCanonicalFinal {
  key: string;
  text: string;
  runId?: string;
}

function textFromContent(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map(textFromContent).filter(Boolean).join('\n').trim();
  if (!isRecord(value)) return '';
  if (typeof value.text === 'string') return value.text.trim();
  return textFromContent(value.content);
}

export function extractJaneCanonicalFinal(payload: Record<string, unknown>): JaneCanonicalFinal | null {
  if (payload.sessionKey !== 'agent:jane-whitmore---ceo:voice:direct:nerve-live' || payload.state !== 'final') return null;
  const text = (Array.isArray(payload.messages)
    ? [...payload.messages].reverse().find((message) => isRecord(message) && message.role === 'assistant')
    : payload.message) as unknown;
  const finalText = textFromContent(text) || textFromContent(payload.content);
  if (!finalText || /^NO_REPLY$/i.test(finalText.trim())) return null;
  const message = isRecord(text) ? text : null;
  const metadata = message && isRecord(message.__openclaw) ? message.__openclaw : null;
  const id = [payload.message_id, payload.messageId, metadata?.id, message?.id, payload.id, payload.runId]
    .find((value): value is string => typeof value === 'string' && Boolean(value.trim()));
  return {
    key: id ? `jane:${id}` : `jane:text:${createHash('sha256').update(finalText).digest('hex')}`,
    text: finalText.slice(0, 12_000),
    ...(typeof payload.runId === 'string' ? { runId: payload.runId } : {}),
  };
}

export function buildJaneRealtimeSpeechRequest(id: number, threadId: string, text: string): JsonMessage {
  return { id, method: 'thread/realtime/appendSpeech', params: { threadId, text: text.slice(0, 12_000) } };
}

let stateWrite = Promise.resolve();

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
    const state = await readPersistedRealtimeState();
    return typeof state.threadId === 'string' && state.threadId.trim() ? state.threadId.trim() : null;
  } catch {
    return null;
  }
}

async function readPersistedRealtimeState(): Promise<RealtimeState> {
  try {
    return JSON.parse(await readFile(janeRealtimeStatePath(), 'utf8')) as RealtimeState;
  } catch {
    return {};
  }
}

function updateRealtimeState(update: (state: RealtimeState) => RealtimeState): Promise<void> {
  stateWrite = stateWrite.then(async () => {
    let current: RealtimeState = {};
    try {
      current = JSON.parse(await readFile(janeRealtimeStatePath(), 'utf8')) as RealtimeState;
    } catch {
      // First run starts from an empty private state file.
    }
    const next = update(current);
    const target = janeRealtimeStatePath();
    const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(temp, `${JSON.stringify(next)}\n`, { mode: 0o600 });
    await rename(temp, target);
  }).catch(() => undefined);
  return stateWrite;
}

function persistRealtimeThreadId(threadId: string): Promise<void> {
  return updateRealtimeState((state) => ({ ...state, threadId }));
}

export function realtimeTranscriptEntry(message: JsonMessage, seq: number): RealtimeTranscriptEntry | null {
  if (message.method !== 'thread/realtime/transcript/done' || !isRecord(message.params)) return null;
  const role = message.params.role === 'assistant' ? 'assistant' : message.params.role === 'user' ? 'user' : null;
  const text = typeof message.params.text === 'string' ? message.params.text.trim() : '';
  if (!role || !text) return null;
  const sourceId = typeof message.params.itemId === 'string' ? message.params.itemId
    : typeof message.params.eventId === 'string' ? message.params.eventId : `event-${seq}`;
  return { id: sourceId, seq, role, text: text.slice(0, 12_000), createdAt: new Date().toISOString() };
}

function persistRealtimeTranscript(entry: RealtimeTranscriptEntry): Promise<void> {
  return updateRealtimeState((state) => ({
    ...state,
    transcript: [...(state.transcript ?? []), entry].slice(-MAX_TRANSCRIPT_ENTRIES),
  }));
}

export function realtimeHistoryForClient(entries: RealtimeTranscriptEntry[]): JsonMessage {
  return {
    method: 'nerve/realtime/history',
    params: { entries: entries.slice(-50).map((entry) => ({ ...entry, eventId: entry.id })) },
  };
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

export function nativeApprovalForClient(message: JsonMessage, clientId = message.id): JsonMessage | null {
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
  return { id: clientId, method: message.method, params: safe };
}

export function nativeApprovalDecision(message: JsonMessage): string | null {
  if (!isRecord(message.result) || typeof message.result.decision !== 'string') return null;
  return NATIVE_APPROVAL_DECISIONS.has(message.result.decision) ? message.result.decision : null;
}

export function nativeApprovalExpiresAt(message: JsonMessage, now = Date.now()): number {
  void message;
  return now + NATIVE_APPROVAL_TTL_MS;
}

/** Serializes server-originated speech until a connected GPT-Live session acknowledges each item. */
export class JaneRealtimeSpeechQueue {
  private readonly queued: JaneCanonicalFinal[] = [];
  private readonly seen = new Set<string>();
  private readonly uncertain = new Set<string>();
  private readonly send: (text: string) => Promise<void>;
  private active = false;
  private sending = false;

  constructor(send: (text: string) => Promise<void>) {
    this.send = send;
  }

  enqueue(final: JaneCanonicalFinal): void {
    if (this.seen.has(final.key)) return;
    this.seen.add(final.key);
    this.queued.push(final);
    void this.flush();
  }

  setActive(active: boolean): void {
    this.active = active;
    if (active) void this.flush();
  }

  private async flush(): Promise<void> {
    const next = this.queued.find((final) => !this.uncertain.has(final.key));
    if (!this.active || this.sending || !next) return;
    this.sending = true;
    try {
      await this.send(next.text);
      this.queued.splice(this.queued.indexOf(next), 1);
    } catch (error) {
      // A timeout has unknown delivery state, so never replay it blindly.
      if (error instanceof SpeechAckTimeoutError) this.uncertain.add(next.key);
      this.active = false;
      console.warn('[codex-realtime] speech delivery pending:', error instanceof Error ? error.message : 'unknown error');
    } finally {
      this.sending = false;
      void this.flush();
    }
  }
}

export class SpeechAckTimeoutError extends Error {}

export function resumeErrorMeansMissingThread(error: unknown): boolean {
  const detail = JSON.stringify(error).toLowerCase();
  return detail.includes('thread not found')
    || detail.includes('unknown thread')
    || detail.includes('thread does not exist')
    || detail.includes('invalid thread id');
}

interface PendingNativeApproval {
  childId: string | number;
  message: JsonMessage;
  expiresAtMs: number;
}

class CodexRealtimeHost {
  private ws: WebSocket | null = null;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly lines;
  private readonly clientIds = new Map<number, string | number | undefined>();
  private readonly nativeApprovals = new Map<string | number, PendingNativeApproval>();
  private nextId = 1000;
  private nextApprovalId = 1;
  private nextTranscriptSeq = 1;
  private threadId: string | null = null;
  private closed = false;
  private lastStderr = '';
  private readonly onExit: () => void;
  private readonly unsubscribeGateway: () => void;
  private readonly forwardedFinals = new Set<string>();
  private readonly pendingFinals = new Map<string, JaneCanonicalFinal>();
  private readonly deliveryKeys = new Set<string>();
  private readonly speechRequests = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();
  private readonly speechQueue = new JaneRealtimeSpeechQueue((text) => this.appendSpeech(text));

  constructor(codexBin: string, onExit: () => void) {
    this.onExit = onExit;
    this.child = spawn(codexBin, ['app-server'], {
      cwd: process.env.OPENCLAW_HOME || join(homedir(), '.openclaw'),
      env: codexRealtimeEnvironment(process.env),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.lines = createInterface({ input: this.child.stdout });
    this.unsubscribeGateway = subscribeGatewayEvents((event) => this.onGatewayEvent(event));
    this.bindChild();
    writeJson(this.child, {
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'openclaw_nerve', title: 'OpenClaw Nerve', version: '1.0.0' },
        capabilities: { experimentalApi: true, requestAttestation: true },
      },
    });
  }

  attach(ws: WebSocket): void {
    const replaced = this.ws;
    this.ws = ws;
    this.clientIds.clear();
    if (replaced && replaced.readyState === WebSocket.OPEN) replaced.close(1001, 'Reconnected');
    if (this.threadId) sendJson(ws, { method: 'nerve/realtime/ready', params: {} });
    for (const final of this.pendingFinals.values()) sendJson(ws, { method: 'thread/realtime/assistant/final', params: { ...final } });
    this.pendingFinals.clear();
    for (const [id, approval] of this.nativeApprovals) {
      if (approval.expiresAtMs <= Date.now()) {
        this.expireNativeApproval(id, approval);
      } else {
        sendJson(ws, approval.message);
      }
    }
    void readPersistedRealtimeState().then((state) => {
      if (this.ws !== ws || !state.transcript?.length) return;
      sendJson(ws, realtimeHistoryForClient(state.transcript));
    });

    ws.on('message', (data, isBinary) => this.onSocketMessage(ws, data, isBinary));
    ws.on('close', () => this.detach(ws));
    ws.on('error', () => this.detach(ws));
  }

  private detach(ws: WebSocket): void {
    if (this.ws !== ws) return;
    this.ws = null;
    this.clientIds.clear();
    this.speechQueue.setActive(false);
  }

  private fail(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribeGateway();
    for (const request of this.speechRequests.values()) request.reject(new Error(reason));
    this.speechRequests.clear();
    this.lines.close();
    if (!this.child.killed) this.child.kill('SIGTERM');
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.close(1011, reason);
    this.ws = null;
    this.onExit();
  }

  private onGatewayEvent(event: Record<string, unknown>): void {
    if (this.closed) return;
    const progress = extractJanePublicProgress(event);
    if (progress && this.ws) sendJson(this.ws, { method: 'nerve/agent/progress', params: { ...progress } });
    if (event.event !== 'chat' || !isRecord(event.payload)) return;
    const final = extractJaneCanonicalFinal(event.payload);
    if (!final) return;
    if (this.forwardedFinals.has(final.key) || this.deliveryKeys.has(final.key)) return;
    this.deliveryKeys.add(final.key);
    this.speechQueue.enqueue(final);
    this.forwardedFinals.add(final.key);
    if (this.forwardedFinals.size > 128) this.forwardedFinals.delete(this.forwardedFinals.values().next().value!);
    this.deliveryKeys.delete(final.key);
    if (this.ws) sendJson(this.ws, { method: 'thread/realtime/assistant/final', params: { ...final } });
    else {
      this.pendingFinals.set(final.key, final);
      if (this.pendingFinals.size > 128) this.pendingFinals.delete(this.pendingFinals.keys().next().value!);
    }
  }

  private appendSpeech(text: string): Promise<void> {
    if (!this.threadId || this.child.stdin.destroyed) return Promise.reject(new Error('Codex voice host is unavailable'));
    const id = this.nextId++;
    let timer: NodeJS.Timeout | undefined;
    const result = new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => {
        this.speechRequests.delete(id);
        reject(new SpeechAckTimeoutError('Codex realtime speech acknowledgement timed out; waiting without replay'));
      }, SPEECH_ACK_TIMEOUT_MS);
      this.speechRequests.set(id, {
        resolve: () => { clearTimeout(timer); resolve(); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
    });
    writeJson(this.child, buildJaneRealtimeSpeechRequest(id, this.threadId!, text));
    return result;
  }

  private ready(threadId: string): void {
    this.threadId = threadId;
    void persistRealtimeThreadId(threadId).catch(() => undefined);
    if (this.ws) sendJson(this.ws, { method: 'nerve/realtime/ready', params: {} });
  }

  private expireNativeApproval(id: string | number, approval: PendingNativeApproval): void {
    if (this.nativeApprovals.get(id) !== approval) return;
    this.nativeApprovals.delete(id);
    writeJson(this.child, { id: approval.childId, result: { decision: 'decline' } });
  }

  private bindChild(): void {
    this.lines.on('line', (line) => {
      let message: JsonMessage;
      try {
        message = JSON.parse(line) as JsonMessage;
      } catch {
        return;
      }

      const transcript = realtimeTranscriptEntry(message, this.nextTranscriptSeq++);
      if (transcript) {
        void persistRealtimeTranscript(transcript);
        message = {
          ...message,
          params: { ...message.params, eventId: transcript.id, journalSeq: transcript.seq },
        };
      }

      if (message.method === 'attestation/generate' && message.id !== undefined) {
        void Promise.resolve()
          .then(() => loadGenerateToken()())
          .then((result) => {
            if (!result.supported || !result.tokenBase64) throw new Error('unsupported');
            writeJson(this.child, { id: message.id, result: { token: result.tokenBase64 } });
          })
          .catch(() => writeJson(this.child, {
            id: message.id,
            error: { code: -32000, message: 'Device attestation unavailable' },
          }));
        return;
      }

      if (message.id === 1) {
        if (message.error) {
          this.fail('Codex desktop initialization failed');
          return;
        }
        writeJson(this.child, { method: 'initialized' });
        void readPersistedRealtimeThreadId()
          .then((persisted) => writeJson(this.child, buildJaneRealtimeThreadRequest(2, persisted)))
          .catch(() => this.fail('Codex voice host failed to prepare thread'));
        return;
      }

      if (message.id === 2 && message.error) {
        if (resumeErrorMeansMissingThread(message.error)) {
          writeJson(this.child, buildJaneRealtimeThreadRequest(3, null));
        } else {
          this.fail('Codex voice conversation could not be resumed');
        }
        return;
      }

      if (message.id === 2 || message.id === 3) {
        const result = isRecord(message.result) ? message.result : null;
        const thread = result && isRecord(result.thread) ? result.thread : null;
        const threadId = thread && typeof thread.id === 'string' ? thread.id : null;
        if (!threadId) {
          this.fail('Codex voice host failed to start');
          return;
        }
        this.ready(threadId);
        return;
      }

      if (typeof message.id === 'number' && this.speechRequests.has(message.id)) {
        const request = this.speechRequests.get(message.id)!;
        this.speechRequests.delete(message.id);
        if (message.error) request.reject(new Error('Codex rejected realtime speech'));
        else {
          console.info('[codex-realtime] speech accepted', { id: message.id });
          request.resolve();
        }
        return;
      }

      if (message.method === 'thread/realtime/started' && isRecord(message.params)
        && message.params.threadId === this.threadId) {
        this.speechQueue.setActive(true);
      }
      if ((message.method === 'thread/realtime/closed' || message.method === 'thread/realtime/error')
        && (!isRecord(message.params) || message.params.threadId === undefined || message.params.threadId === this.threadId)) {
        this.speechQueue.setActive(false);
      }

      if (typeof message.id === 'number' && this.clientIds.has(message.id)) {
        const clientId = this.clientIds.get(message.id);
        this.clientIds.delete(message.id);
        if (this.ws) sendJson(this.ws, { ...message, id: clientId });
        return;
      }

      const clientApprovalId = `codex-approval:${this.nextApprovalId++}`;
      const nativeApproval = nativeApprovalForClient(message, clientApprovalId);
      if (nativeApproval) {
        const approval = {
          childId: message.id!,
          message: nativeApproval,
          expiresAtMs: nativeApprovalExpiresAt(message),
        };
        this.nativeApprovals.set(clientApprovalId, approval);
        const expiryTimer = setTimeout(
          () => this.expireNativeApproval(clientApprovalId, approval),
          Math.max(0, approval.expiresAtMs - Date.now()),
        );
        expiryTimer.unref();
        if (this.ws) sendJson(this.ws, nativeApproval);
        return;
      }

      const isRealtimeItemEvent = Boolean(message.method && REALTIME_ITEM_METHODS.has(message.method)
        && isRecord(message.params)
        && (message.params.threadId === undefined || message.params.threadId === this.threadId));
      if (message.method?.startsWith('thread/realtime/') || isRealtimeItemEvent) {
        if (this.ws) sendJson(this.ws, message);
      }
    });

    this.child.on('error', () => this.fail('Codex desktop runtime failed'));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => {
      const lines = chunk.trim().split('\n').filter(Boolean);
      if (lines.length) this.lastStderr = lines.at(-1)!.slice(0, 500);
    });
    this.child.on('exit', (code, signal) => {
      console.warn('[codex-realtime] host exited', { code, signal, detail: this.lastStderr || undefined });
      this.fail('Codex desktop runtime stopped');
    });
  }

  private onSocketMessage(ws: WebSocket, data: RawData, isBinary: boolean): void {
    if (this.ws !== ws) return;
    const byteLength = Array.isArray(data)
      ? data.reduce((total, part) => total + part.byteLength, 0)
      : data.byteLength;
    if (isBinary || byteLength > MAX_MESSAGE_BYTES || !this.threadId) {
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
    if (incoming.id !== undefined && incoming.method === undefined && this.nativeApprovals.has(incoming.id)) {
      const decision = nativeApprovalDecision(incoming);
      if (!decision) {
        sendJson(ws, { id: incoming.id, error: { code: -32602, message: 'Invalid approval decision' } });
        return;
      }
      const approval = this.nativeApprovals.get(incoming.id)!;
      if (approval.expiresAtMs <= Date.now()) {
        this.expireNativeApproval(incoming.id, approval);
        sendJson(ws, { id: incoming.id, error: { code: -32001, message: 'Approval request expired' } });
        return;
      }
      this.nativeApprovals.delete(incoming.id);
      writeJson(this.child, { id: approval.childId, result: { decision } });
      return;
    }
    const normalized = normalizeCodexRealtimeRequest(incoming, this.threadId);
    if (!normalized) {
      sendJson(ws, { id: incoming.id, error: { code: -32601, message: 'Realtime method not allowed' } });
      return;
    }
    if (normalized.method === 'thread/realtime/start' || normalized.method === 'thread/realtime/stop') {
      this.speechQueue.setActive(false);
    }
    const internalId = this.nextId++;
    this.clientIds.set(internalId, incoming.id);
    writeJson(this.child, { ...normalized, id: internalId });
  }
}

let sharedRealtimeHost: CodexRealtimeHost | null = null;

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

  if (!sharedRealtimeHost) {
    sharedRealtimeHost = new CodexRealtimeHost(codexBin, () => {
      sharedRealtimeHost = null;
    });
  }
  sharedRealtimeHost.attach(ws);
}
