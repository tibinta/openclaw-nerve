/** Tests for loadHistory — filtering, splitting, grouping, and tagging. */
import { describe, it, expect, vi } from 'vitest';
import {
  filterMessage,
  splitToolCallMessage,
  groupToolMessages,
  tagIntermediateMessages,
  processChatMessages,
  loadChatHistory,
} from './loadHistory';
import type { ChatMessage } from '@/types';
import type { ChatMsg } from '@/features/chat/types';

describe('filterMessage', () => {
  it('shows normal user messages', () => {
    expect(filterMessage({ role: 'user', content: 'Hello' })).toBe(true);
  });

  it('shows normal assistant messages', () => {
    expect(filterMessage({ role: 'assistant', content: 'Hi there' })).toBe(true);
  });

  it('passes through sub-agent completions (tagged)', () => {
    expect(filterMessage({
      role: 'user',
      content: 'A background task "cleanup" just completed.',
    })).toBe(true);
  });

  it('passes through cron completions (tagged)', () => {
    expect(filterMessage({
      role: 'user',
      content: 'A cron job "daily-check" just completed.',
    })).toBe(true);
  });

  it('passes through queued announce messages (tagged)', () => {
    expect(filterMessage({
      role: 'user',
      content: '[Queued announce messages while agent was busy] Some content',
    })).toBe(true);
  });

  it('passes through background task messages (tagged)', () => {
    expect(filterMessage({
      role: 'user',
      content: 'A background task started.',
    })).toBe(true);
  });

  it('passes through trigger blocks (tagged)', () => {
    expect(filterMessage({
      role: 'user',
      content: 'Findings:results here\nSummarize this naturally for the user.',
    })).toBe(true);
  });

  it('hides redundant Edit tool results', () => {
    expect(filterMessage({
      role: 'tool',
      content: 'Successfully replaced text in /path/file.ts.',
    })).toBe(false);
  });

  it('hides redundant Write tool results', () => {
    expect(filterMessage({
      role: 'tool',
      content: 'Successfully wrote 1234 bytes to /path/file.ts.',
    })).toBe(false);
  });

  it('shows tool results with other content', () => {
    expect(filterMessage({
      role: 'tool',
      content: 'File contents:\nfunction hello() {}',
    })).toBe(true);
  });
});

describe('splitToolCallMessage', () => {
  it('marks scheduled inputs for display filtering while keeping replies and normal requests', () => {
    expect(splitToolCallMessage({ role: 'user', content: 'Scheduled request', provenance: { sourceTool: 'cron' } })[0].isCronInvocation).toBe(true);
    expect(splitToolCallMessage({ role: 'user', content: '[cron:job-id Morning] Give an update' })[0].isCronInvocation).toBe(true);
    expect(splitToolCallMessage({ role: 'assistant', content: 'Here is the scheduled update.' })[0].isCronInvocation).toBeUndefined();
    expect(splitToolCallMessage({ role: 'user', content: 'Please edit the cron schedule' })[0].isCronInvocation).toBeUndefined();
    expect(splitToolCallMessage({ role: 'assistant', content: 'Projected scheduled request', provenance: { kind: 'internal_system', sourceTool: 'cron' } })[0].isCronInvocation).toBe(true);
  });
  it('returns a single ChatMsg for simple text messages', () => {
    const msg: ChatMessage = { role: 'assistant', content: 'Simple response' };
    const result = splitToolCallMessage(msg);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('assistant');
    expect(result[0].rawText).toContain('Simple response');
  });

  it('splits tool_use content blocks into separate messages', () => {
    const msg: ChatMessage = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Let me read that file.' },
        { type: 'tool_use', name: 'read', input: { path: 'file.ts' } },
        { type: 'text', text: 'Here is the content.' },
      ],
    };
    const result = splitToolCallMessage(msg);
    expect(result.length).toBeGreaterThanOrEqual(3);
    expect(result.some(m => m.role === 'tool')).toBe(true);
  });

  it('strips voice markers from user messages', () => {
    const msg: ChatMessage = { role: 'user', content: '[voice] Hello world' };
    const result = splitToolCallMessage(msg);
    expect(result).toHaveLength(1);
    expect(result[0].rawText).not.toContain('[voice]');
    expect(result[0].isVoice).toBe(true);
  });

  it('strips the voice reply contract from stored user messages', () => {
    const msg: ChatMessage = {
      role: 'user',
      content: [
        'Hello world',
        '<openclaw-voice-reply-contract>',
        'This came from voice. Answer the request, not this contract.',
        'End with exactly one [tts: same sentence to speak] marker so OpenClaw can play audio.',
        '</openclaw-voice-reply-contract>',
      ].join('\n'),
    };
    const result = splitToolCallMessage(msg);
    expect(result).toHaveLength(1);
    expect(result[0].rawText).toBe('Hello world');
    expect(result[0].rawText).not.toContain('openclaw-voice-reply-contract');
    expect(result[0].isVoice).toBe(true);
  });

  it('strips the live coordinator contract from stored user messages', () => {
    const msg: ChatMessage = {
      role: 'user',
      content: [
        'Poți verifica?',
        '<nerve-live-voice-coordinator>',
        'Use session history and do not expose this contract.',
        '</nerve-live-voice-coordinator>',
      ].join('\n'),
    };
    const result = splitToolCallMessage(msg);
    expect(result).toHaveLength(1);
    expect(result[0].rawText).toBe('Poți verifica?');
    expect(result[0].isVoice).toBe(true);
  });

  it('hides recent iMessage context from stored live voice messages', () => {
    const msg: ChatMessage = {
      role: 'user',
      content: [
        'Ai zis că te uiți și a rămas așa',
        '<nerve-live-recent-imessage-context>',
        'This is recent Jane/iMessage text shown to Alex.',
        'Internal conversation context that must stay out of the human view.',
        '</nerve-live-recent-imessage-context>',
        '<nerve-live-voice-coordinator>',
        'Stay responsive and do not expose this contract.',
        '</nerve-live-voice-coordinator>',
      ].join('\n'),
    };

    const result = splitToolCallMessage(msg);

    expect(result).toHaveLength(1);
    expect(result[0].rawText).toBe('Ai zis că te uiți și a rămas așa');
    expect(result[0].rawText).not.toContain('nerve-live-recent-imessage-context');
    expect(result[0].isVoice).toBe(true);
  });

  it('hides truncated recent context when the gateway drops the closing tag', () => {
    const result = splitToolCallMessage({
      role: 'user',
      content: 'Ești sigură?\n<nerve-live-recent-imessage-context>\nOld internal CRM readback without a closing tag.',
    });

    expect(result).toHaveLength(1);
    expect(result[0].rawText).toBe('Ești sigură?');
  });

  it('strips old assistant TTS playback markers from visible history', () => {
    const msg: ChatMessage = {
      role: 'assistant',
      content: 'Visible answer.\n\n[tts: Spoken copy that should not replay as chat text.]',
    };
    const result = splitToolCallMessage(msg);
    expect(result).toHaveLength(1);
    expect(result[0].rawText).toBe('Visible answer.');
    expect(result[0].rawText).not.toMatch(/\[tts:/i);
    expect(result[0].ttsText).toBe('Spoken copy that should not replay as chat text.');
  });

  it('extracts upload manifest attachments from user transcript messages', () => {
    const msg: ChatMessage = {
      role: 'user',
      content: 'Please use these files.\n\n<nerve-upload-manifest>{"version":1,"attachments":[{"id":"att-upload","origin":"upload","mode":"inline","name":"small.png","mimeType":"image/png","sizeBytes":120000,"inline":{"encoding":"base64","base64":"","base64Bytes":98000,"compressed":true},"preparation":{"sourceMode":"inline","finalMode":"inline","outcome":"optimized_inline","reason":"Inline image stayed within context-safe budget.","originalMimeType":"image/png","originalSizeBytes":120000},"policy":{"forwardToSubagents":false}},{"id":"att-path","origin":"server_path","mode":"file_reference","name":"capture.mov","mimeType":"video/quicktime","sizeBytes":8000000,"reference":{"kind":"local_path","path":"/workspace/capture.mov","uri":"/api/files/raw?path=capture.mov"},"preparation":{"sourceMode":"file_reference","finalMode":"file_reference","outcome":"file_reference_ready","reason":"Sent as a validated workspace path.","originalMimeType":"video/quicktime","originalSizeBytes":8000000},"policy":{"forwardToSubagents":true}}]}</nerve-upload-manifest>',
    };
    const result = splitToolCallMessage(msg);
    expect(result).toHaveLength(1);
    expect(result[0].rawText).toBe('Please use these files.');
    expect(result[0].uploadAttachments).toHaveLength(2);
    expect(result[0].uploadAttachments?.[0].origin).toBe('upload');
    expect(result[0].uploadAttachments?.[1].origin).toBe('server_path');
    expect(result[0].uploadAttachments?.[1].reference?.path).toBe('/workspace/capture.mov');
  });

  it('extracts upload manifest attachments from assistant transcript messages', () => {
    const msg: ChatMessage = {
      role: 'assistant',
      content: 'Here is the file.\n\n<nerve-upload-manifest>{"version":1,"attachments":[{"id":"att-audio","origin":"upload","mode":"inline","name":"note.mp3","mimeType":"audio/mpeg","sizeBytes":4096,"inline":{"encoding":"base64","base64":"SUQz","base64Bytes":4,"compressed":false},"preparation":{"sourceMode":"inline","finalMode":"inline","outcome":"inline_ready","reason":"Inline audio stayed within context-safe budget.","originalMimeType":"audio/mpeg","originalSizeBytes":4096},"policy":{"forwardToSubagents":true}},{"id":"att-file","origin":"server_path","mode":"file_reference","name":"report.pdf","mimeType":"application/pdf","sizeBytes":2048,"reference":{"kind":"local_path","path":"/workspace/report.pdf","uri":"/api/files/raw?path=report.pdf"},"preparation":{"sourceMode":"file_reference","finalMode":"file_reference","outcome":"file_reference_ready","reason":"Sent as a validated workspace path.","originalMimeType":"application/pdf","originalSizeBytes":2048},"policy":{"forwardToSubagents":true}}]}</nerve-upload-manifest>',
    };
    const result = splitToolCallMessage(msg);
    expect(result).toHaveLength(1);
    expect(result[0].rawText).toBe('Here is the file.');
    expect(result[0].uploadAttachments).toHaveLength(2);
    expect(result[0].uploadAttachments?.[0].mimeType).toBe('audio/mpeg');
    expect(result[0].uploadAttachments?.[1].reference?.uri).toBe('/api/files/raw?path=report.pdf');
  });

  it('hydrates assistant transcript audio, video, and file blocks into upload attachments while preserving image blocks', () => {
    const msg: ChatMessage = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Here you go.' },
        { type: 'image', mimeType: 'image/png', data: Buffer.from('image-bytes').toString('base64') },
        { type: 'audio', mimeType: 'audio/mpeg', data: Buffer.from('audio-bytes').toString('base64') },
        { type: 'file', mimeType: 'application/pdf', data: Buffer.from('file-bytes').toString('base64') },
        { type: 'video', source: { media_type: 'video/mp4', data: Buffer.from('video-bytes').toString('base64') } },
      ],
    };
    const result = splitToolCallMessage(msg);
    expect(result).toHaveLength(1);
    expect(result[0].images).toHaveLength(1);
    expect(result[0].uploadAttachments).toHaveLength(3);
    expect(result[0].uploadAttachments?.[0].mimeType).toBe('audio/mpeg');
    expect(result[0].uploadAttachments?.[1].mimeType).toBe('application/pdf');
    expect(result[0].uploadAttachments?.[2].mimeType).toBe('video/mp4');
  });

  it('creates reference attachments when transcript media lacks inline bytes', () => {
    const msg: ChatMessage = {
      role: 'assistant',
      content: [
        { type: 'audio', mimeType: 'audio/mpeg', name: 'note.mp3' },
        { type: 'file', mimeType: 'application/pdf', name: 'report.pdf' },
      ],
    };
    const result = splitToolCallMessage(msg);
    expect(result).toHaveLength(1);
    expect(result[0].uploadAttachments).toHaveLength(2);
    expect(result[0].uploadAttachments?.every(att => att.mode === 'file_reference')).toBe(true);
    expect(result[0].uploadAttachments?.[0].reference?.uri).toContain('/api/files/raw?path=note.mp3');
    expect(result[0].uploadAttachments?.[1].reference?.uri).toContain('/api/files/raw?path=report.pdf');
  });

  it('returns empty array for voice-only messages with no text', () => {
    const msg: ChatMessage = { role: 'user', content: '[voice] ' };
    const result = splitToolCallMessage(msg);
    expect(result).toHaveLength(0);
  });

  it('hides empty aborted assistant timeout records instead of rendering a chat reply', () => {
    const msg: ChatMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: '' }],
      stopReason: 'aborted',
      errorMessage: 'LLM idle timeout (120s): no response from model',
    };
    const result = splitToolCallMessage(msg);
    expect(result).toHaveLength(0);
  });

  it('hides overloaded empty assistant errors', () => {
    const msg: ChatMessage = {
      role: 'assistant',
      content: '',
      stopReason: 'error',
      errorMessage: 'proxy_overloaded: codex-lb is temporarily overloaded during http_bridge_response_create_gate',
    };
    const result = splitToolCallMessage(msg);
    expect(result).toHaveLength(0);
  });

  it('hides assistant failure placeholders', () => {
    const msg: ChatMessage = {
      role: 'assistant',
      content: '[assistant turn failed before producing content]',
      stopReason: 'error',
      errorMessage: 'proxy_overloaded: codex-lb is temporarily overloaded',
    };
    const result = splitToolCallMessage(msg);
    expect(result).toHaveLength(0);
  });

  it('hides unknown empty assistant errors', () => {
    const msg: ChatMessage = {
      role: 'assistant',
      content: '',
      stopReason: 'error',
      errorMessage: 'provider runtime failure',
    };
    const result = splitToolCallMessage(msg);
    expect(result).toHaveLength(0);
  });

  it('hides empty aborted assistant context overflow records', () => {
    const msg: ChatMessage = {
      role: 'assistant',
      content: '',
      stopReason: 'aborted',
      errorMessage: 'context window overflow recovery failed: already_compacted_recently',
    };
    const result = splitToolCallMessage(msg);
    expect(result).toHaveLength(0);
  });

  it('labels plain empty assistant records as no text', () => {
    const msg: ChatMessage = { role: 'assistant', content: '' };
    const result = splitToolCallMessage(msg);
    expect(result).toHaveLength(1);
    expect(result[0].rawText).toBe('No text');
  });

  it('handles thinking blocks', () => {
    const msg: ChatMessage = {
      role: 'assistant',
      content: [
        { type: 'thinking', text: 'Let me think about this...' },
        { type: 'text', text: 'Here is my answer.' },
      ],
    };
    const result = splitToolCallMessage(msg);
    expect(result.some(m => m.isThinking)).toBe(true);
  });

  it('handles user messages with system events', () => {
    const msg: ChatMessage = {
      role: 'user',
      content: 'System: [2026-02-17 20:30:23 GMT+1] Agent started\nHello!',
    };
    const result = splitToolCallMessage(msg);
    expect(result.some(m => m.role === 'event')).toBe(true);
    expect(result.some(m => m.role === 'user')).toBe(true);
  });
});

describe('groupToolMessages', () => {
  it('returns non-tool messages unchanged', () => {
    const msgs: ChatMsg[] = [
      { role: 'user', html: '', rawText: 'hi', timestamp: new Date() },
      { role: 'assistant', html: '', rawText: 'hello', timestamp: new Date() },
    ];
    const result = groupToolMessages(msgs);
    expect(result).toHaveLength(2);
  });

  it('groups consecutive tool messages', () => {
    const msgs: ChatMsg[] = [
      { role: 'tool', html: '', rawText: '**tool:** `read`\n```json\n{}\n```', timestamp: new Date() },
      { role: 'tool', html: '', rawText: '**tool:** `write`\n```json\n{}\n```', timestamp: new Date() },
    ];
    const result = groupToolMessages(msgs);
    expect(result).toHaveLength(1);
    expect(result[0].toolGroup).toBeDefined();
    expect(result[0].toolGroup).toHaveLength(2);
  });

  it('does not group a single tool message', () => {
    const msgs: ChatMsg[] = [
      { role: 'tool', html: '', rawText: '**tool:** `read`\n```json\n{}\n```', timestamp: new Date() },
    ];
    const result = groupToolMessages(msgs);
    expect(result).toHaveLength(1);
    expect(result[0].toolGroup).toBeUndefined();
  });

  it('flushes tool buffer before non-tool message', () => {
    const msgs: ChatMsg[] = [
      { role: 'tool', html: '', rawText: '**tool:** `read`\n```json\n{}\n```', timestamp: new Date() },
      { role: 'tool', html: '', rawText: '**tool:** `write`\n```json\n{}\n```', timestamp: new Date() },
      { role: 'assistant', html: '', rawText: 'Done!', timestamp: new Date() },
    ];
    const result = groupToolMessages(msgs);
    expect(result).toHaveLength(2);
  });
});

describe('tagIntermediateMessages', () => {
  it('marks assistant messages before tools as intermediate', () => {
    const msgs: ChatMsg[] = [
      { role: 'assistant', html: '', rawText: 'Let me check...', timestamp: new Date() },
      { role: 'tool', html: '', rawText: 'result', timestamp: new Date() },
      { role: 'assistant', html: '', rawText: 'Here you go.', timestamp: new Date() },
    ];
    const result = tagIntermediateMessages(msgs);
    expect(result[0].intermediate).toBe(true);
    expect(result[2].intermediate).toBeFalsy();
  });

  it('does not mark the last assistant message as intermediate', () => {
    const msgs: ChatMsg[] = [
      { role: 'assistant', html: '', rawText: 'Final answer.', timestamp: new Date() },
    ];
    const result = tagIntermediateMessages(msgs);
    expect(result[0].intermediate).toBeFalsy();
  });

  it('does not mark thinking messages as intermediate', () => {
    const msgs: ChatMsg[] = [
      { role: 'assistant', html: '', rawText: 'thinking...', timestamp: new Date(), isThinking: true },
      { role: 'tool', html: '', rawText: 'result', timestamp: new Date() },
    ];
    const result = tagIntermediateMessages(msgs);
    expect(result[0].intermediate).toBeFalsy();
  });

  it('does not mutate input array', () => {
    const msgs: ChatMsg[] = [
      { role: 'assistant', html: '', rawText: 'Check', timestamp: new Date() },
      { role: 'tool', html: '', rawText: 'result', timestamp: new Date() },
    ];
    const result = tagIntermediateMessages(msgs);
    expect(msgs[0].intermediate).toBeUndefined();
    expect(result[0].intermediate).toBe(true);
  });
});

describe('processChatMessages', () => {

  it('drops assistant NO_REPLY sentinel messages', () => {
    const msgs: ChatMessage[] = [
      { role: 'assistant', content: 'NO_REPLY' },
      { role: 'user', content: 'hello' },
    ];
    const result = processChatMessages(msgs);
    expect(result.some((m) => m.rawText.trim() === 'NO_REPLY')).toBe(false);
    expect(result.some((m) => m.rawText.includes('hello'))).toBe(true);
  });

  it('drops user NO_REPLY sentinel messages', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'NO_REPLY' },
      { role: 'assistant', content: 'hello' },
    ];
    const result = processChatMessages(msgs);
    expect(result.some((m) => m.rawText.trim() === 'NO_REPLY')).toBe(false);
    expect(result.some((m) => m.rawText.includes('hello'))).toBe(true);
  });

  it('keeps lowercase no_reply because the sentinel must match exactly', () => {
    const msgs: ChatMessage[] = [
      { role: 'assistant', content: 'no_reply' },
    ];
    const result = processChatMessages(msgs);
    expect(result).toHaveLength(1);
    expect(result[0].rawText.trim()).toBe('no_reply');
  });

  it('drops OpenClaw connection smoke prompts and exact replies from visible history', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: '[Sat 2026-06-06 17:24 GMT+1] Connection smoke. Reply exactly: OPENCLAW_CONNECTION_OK' },
      { role: 'assistant', content: 'OPENCLAW_CONNECTION_OK' },
      { role: 'user', content: '[Sat 2026-06-06 17:29 GMT+1] Post-restart connection smoke. Reply exactly: OPENCLAW_POST_RESTART_OK' },
      { role: 'assistant', content: 'OPENCLAW_POST_RESTART_OK' },
      { role: 'assistant', content: 'Real status update' },
    ];

    const result = processChatMessages(msgs);

    expect(result.map((m) => m.rawText)).toEqual(['Real status update']);
  });

  it('runs the full pipeline: filter → split → group → tag', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' },
    ];
    const result = processChatMessages(msgs);
    expect(result.length).toBeGreaterThanOrEqual(2);
    expect(result.every(m => m.msgId)).toBe(true);
  });

  it('builds transcript media references from the live session context', () => {
    const timestamp = new Date('2026-05-05T18:30:00.000Z');
    const msgs: ChatMessage[] = [
      {
        role: 'assistant',
        timestamp,
        content: [
          { type: 'audio', mimeType: 'audio/mpeg', name: 'note.mp3' },
          { type: 'file', mimeType: 'text/plain', name: 'notes.txt' },
        ],
      },
    ];

    const result = processChatMessages(msgs, { sessionKey: 'session-123' });
    expect(result).toHaveLength(1);
    expect(result[0].uploadAttachments).toHaveLength(2);
    expect(result[0].uploadAttachments?.[0].reference?.uri).toContain('sessionKey=session-123');
    expect(result[0].uploadAttachments?.[0].reference?.uri).toContain(`timestamp=${timestamp.getTime()}`);
    expect(result[0].uploadAttachments?.[0].reference?.uri).toContain('imageIndex=0');
    expect(result[0].uploadAttachments?.[1].reference?.uri).toContain('imageIndex=1');
  });

  it('tags background task notifications as system notifications', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'A background task "x" just completed.' },
      { role: 'assistant', content: 'Hello' },
    ];
    const result = processChatMessages(msgs);
    const sysMsg = result.find(m => m.isSystemNotification);
    expect(sysMsg).toBeDefined();
    expect(sysMsg!.isSystemNotification).toBe(true);
    expect(sysMsg!.rawText).toBe('x — completed');
    expect(sysMsg!.rawText).not.toContain('background task');
  });

  it('handles empty input', () => {
    expect(processChatMessages([])).toHaveLength(0);
  });
});

describe('loadChatHistory', () => {
  it('loads and processes messages via RPC', async () => {
    const rpc = vi.fn().mockResolvedValue({
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi!' },
      ],
    });

    const result = await loadChatHistory({ rpc, sessionKey: 'sk-1' });
    expect(rpc).toHaveBeenCalledWith('chat.history', { sessionKey: 'sk-1', limit: 100 });
    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  it('handles empty response', async () => {
    const rpc = vi.fn().mockResolvedValue({ messages: [] });
    const result = await loadChatHistory({ rpc, sessionKey: 'sk-1' });
    expect(result).toHaveLength(0);
  });

  it('handles null response', async () => {
    const rpc = vi.fn().mockResolvedValue(null);
    const result = await loadChatHistory({ rpc, sessionKey: 'sk-1' });
    expect(result).toHaveLength(0);
  });

  it('respects custom limit', async () => {
    const rpc = vi.fn().mockResolvedValue({ messages: [] });
    await loadChatHistory({ rpc, sessionKey: 'sk', limit: 50 });
    expect(rpc).toHaveBeenCalledWith('chat.history', { sessionKey: 'sk', limit: 50 });
  });

  it('propagates RPC errors', async () => {
    const rpc = vi.fn().mockRejectedValue(new Error('network error'));
    await expect(loadChatHistory({ rpc, sessionKey: 'sk' })).rejects.toThrow('network error');
  });
});
