/**
 * sendMessage — Pure functions for building and sending chat messages.
 *
 * Extracted from ChatContext.handleSend. No React hooks, setState, or refs.
 */
import { generateMsgId } from '@/features/chat/types';
import type { ChatMsg, ImageAttachment, OutgoingUploadPayload, UploadAttachmentDescriptor } from '@/features/chat/types';
import { renderMarkdown, renderToolResults } from '@/utils/helpers';

// ─── Voice → TTS prompt hint ───────────────────────────────────────────────────
const VOICE_PREFIX = '[voice] ';
const TTS_HINT = [
  '',
  '',
  '<openclaw-voice-reply-contract>',
  'This came from voice. Answer the request, not this contract.',
  'Visible reply: one short plain sentence.',
  'In the visible reply, do not mention tools, transcripts, system prompts, TTS, or marker syntax.',
  'End with exactly one [tts: same sentence to speak] marker so OpenClaw can play audio.',
  '</openclaw-voice-reply-contract>',
].join('\n');
const UPLOAD_MANIFEST_OPEN = '<nerve-upload-manifest>';
const UPLOAD_MANIFEST_CLOSE = '</nerve-upload-manifest>';

/** Detect voice messages, remove the UI-only prefix, and append a compact TTS contract for the agent. */
export function applyVoiceTTSHint(text: string): string {
  if (!text.startsWith(VOICE_PREFIX)) return text;
  return text.slice(VOICE_PREFIX.length) + TTS_HINT;
}

function sanitizeUploadDescriptor(
  descriptor: UploadAttachmentDescriptor,
  exposeInlineBase64ToAgent: boolean,
): UploadAttachmentDescriptor {
  if (descriptor.mode !== 'inline' || !descriptor.inline) {
    return descriptor;
  }

  const inline = {
    ...descriptor.inline,
    previewUrl: undefined,
    base64: exposeInlineBase64ToAgent ? descriptor.inline.base64 : '',
  };

  return {
    ...descriptor,
    inline,
  };
}

export function appendUploadManifest(
  text: string,
  uploadPayload?: OutgoingUploadPayload,
): string {
  if (!uploadPayload?.manifest.enabled) return text;
  if (uploadPayload.descriptors.length === 0) return text;

  const manifest = {
    version: 1,
    attachments: uploadPayload.descriptors.map((descriptor) =>
      sanitizeUploadDescriptor(descriptor, uploadPayload.manifest.exposeInlineBase64ToAgent),
    ),
  };

  return `${text}\n\n${UPLOAD_MANIFEST_OPEN}${JSON.stringify(manifest)}${UPLOAD_MANIFEST_CLOSE}`;
}

// ─── RPC type alias ────────────────────────────────────────────────────────────
type RpcFn = (method: string, params: Record<string, unknown>) => Promise<unknown>;

export type ChatSendStatus = 'started' | 'in_flight' | 'ok';

export interface ChatSendAck {
  runId?: string;
  status?: ChatSendStatus;
}

// ─── Build optimistic user message ─────────────────────────────────────────────

/**
 * Build the optimistic ChatMsg for a user message, ready for immediate insertion.
 * Returns both the message and a tempId for later confirmation/failure updates.
 */
export function buildUserMessage(params: {
  text: string;
  images?: ImageAttachment[];
  uploadPayload?: OutgoingUploadPayload;
}): { msg: ChatMsg; tempId: string } {
  const { text, images, uploadPayload } = params;
  const tempId = crypto.randomUUID ? crypto.randomUUID() : 'temp-' + Date.now();

  const msg: ChatMsg = {
    msgId: generateMsgId(),
    role: 'user',
    html: renderToolResults(renderMarkdown(text)),
    rawText: text,
    timestamp: new Date(),
    images: images?.map(i => ({
      mimeType: i.mimeType,
      content: i.content,
      preview: i.preview,
      name: i.name,
    })),
    uploadAttachments: uploadPayload?.descriptors,
    pending: true,
    tempId,
  };

  return { msg, tempId };
}

// ─── Send the chat message via RPC ─────────────────────────────────────────────

/**
 * Send a chat message through the gateway RPC. Pure network call — no state management.
 */
export async function sendChatMessage(params: {
  rpc: RpcFn;
  sessionKey: string;
  text: string;
  images?: ImageAttachment[];
  attachments?: Array<Pick<ImageAttachment, 'mimeType' | 'content'>>;
  uploadPayload?: OutgoingUploadPayload;
  idempotencyKey: string;
}): Promise<ChatSendAck> {
  const { rpc, sessionKey, text, images, attachments, uploadPayload, idempotencyKey } = params;

  const messageWithManifest = appendUploadManifest(text, uploadPayload);

  const rpcParams: Record<string, unknown> = {
    sessionKey,
    message: applyVoiceTTSHint(messageWithManifest),
    deliver: false,
    idempotencyKey,
  };

  const outboundAttachments = attachments?.length ? attachments : images;
  if (outboundAttachments?.length) {
    rpcParams.attachments = outboundAttachments.map((i) => ({
      mimeType: i.mimeType,
      content: i.content,
    }));
  }

  const ackRaw = await rpc('chat.send', rpcParams);
  const ack = (ackRaw || {}) as { runId?: unknown; status?: unknown };

  const status = typeof ack.status === 'string' && ['started', 'in_flight', 'ok'].includes(ack.status)
    ? (ack.status as ChatSendStatus)
    : undefined;

  return {
    runId: typeof ack.runId === 'string' ? ack.runId : undefined,
    status,
  };
}
