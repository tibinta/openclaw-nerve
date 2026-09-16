/** Regression test: ChatContext should not resubscribe on local state updates. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, waitFor, screen } from '@testing-library/react';
import { useEffect } from 'react';
import type { ChatMsg, ImageAttachment, OutgoingUploadPayload } from '@/features/chat/types';
import { JANE_DIRECT_CHAT_SESSION_KEY, JANE_LIVE_VOICE_SESSION_KEY } from '@/features/sessions/sessionKeys';
import { readCodexRealtimeDeliveredContextIds } from '@/features/voice/codexRealtimeBridge';

describe('ChatContext subscription stability', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function setup(options: {
    connectionState?: 'disconnected' | 'connected';
    currentSession?: string;
    sessions?: Array<{ sessionKey: string; label?: string; totalTokens?: number; inputTokens?: number; outputTokens?: number; contextTokens?: number }>;
    history?: ChatMsg[][];
    speak?: ReturnType<typeof vi.fn>;
  } = {}) {
    let subscribedHandler: ((msg: unknown) => void) | null = null;
    const subscribeMock = vi.fn((handler: (msg: unknown) => void) => {
      subscribedHandler = handler;
      return () => {};
    });
    const rpcMock = vi.fn(async (method: string) => {
      if (method === 'chat.send') return { runId: 'run-1', status: 'started' };
      if (method === 'sessions.steer') return { runId: 'run-2', status: 'started', interruptedActiveRun: true };
      return {};
    });
    const setCurrentSessionMock = vi.fn();
    const history = options.history ?? [[]];
    let historyCallCount = 0;

    vi.doMock('@/features/chat/operations', async () => {
      const actual = await vi.importActual<typeof import('@/features/chat/operations')>('@/features/chat/operations');
      return {
        ...actual,
        loadChatHistory: vi.fn(async () => history[Math.min(historyCallCount++, history.length - 1)]),
      };
    });

    vi.doMock('./GatewayContext', () => ({
      useGateway: () => ({
        connectionState: options.connectionState ?? 'disconnected',
        rpc: rpcMock,
        subscribe: subscribeMock,
      }),
    }));

    vi.doMock('./SessionContext', () => ({
      useSessionContext: () => ({
        currentSession: options.currentSession ?? '',
        sessions: options.sessions ?? [
          { sessionKey: JANE_DIRECT_CHAT_SESSION_KEY, label: 'Jane Direct' },
        ],
        setCurrentSession: setCurrentSessionMock,
      }),
    }));

    vi.doMock('./SettingsContext', () => ({
      useSettings: () => ({
        soundEnabled: false,
        speak: options.speak ?? vi.fn(),
      }),
    }));

    const mod = await import('./ChatContext');
    return { ...mod, subscribeMock, rpcMock, setCurrentSessionMock, getSubscribedHandler: () => subscribedHandler };
  }

  it('keeps a single subscribe registration after handleSend-triggered rerender', async () => {
    const { ChatProvider, useChat, subscribeMock } = await setup();

    let send: ((text: string, images?: ImageAttachment[]) => Promise<void>) | null = null;

    function Consumer() {
      const chat = useChat();
      useEffect(() => {
        send = chat.handleSend;
      }, [chat]);
      return null;
    }

    render(
      <ChatProvider>
        <Consumer />
      </ChatProvider>,
    );

    await waitFor(() => expect(subscribeMock).toHaveBeenCalledTimes(1));
    expect(send).not.toBeNull();

    await act(async () => {
      await send!('hello');
    });

    // Regression assertion: local state updates should not cause resubscription churn.
    expect(subscribeMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to the default session key before sending when current session is empty', async () => {
    const { ChatProvider, useChat, rpcMock, setCurrentSessionMock } = await setup();

    let send: ((text: string, images?: ImageAttachment[]) => Promise<void>) | null = null;

    function Consumer() {
      const chat = useChat();
      useEffect(() => {
        send = chat.handleSend;
      }, [chat]);
      return null;
    }

    render(
      <ChatProvider>
        <Consumer />
      </ChatProvider>,
    );

    await act(async () => {
      await send!('hello');
    });

    expect(setCurrentSessionMock).toHaveBeenCalledWith(JANE_DIRECT_CHAT_SESSION_KEY);
    expect(rpcMock).toHaveBeenCalledWith('chat.send', expect.objectContaining({
      sessionKey: JANE_DIRECT_CHAT_SESSION_KEY,
      message: expect.any(String),
    }));
  });

  it('speaks wake brief fast replies through the shared TTS path', async () => {
    const speak = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        answer: '**Status**\n\nBoard is active.',
        speech: 'Board is active. Two tasks are in progress.',
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const { ChatProvider, useChat, rpcMock } = await setup({ speak });

    let send: ((text: string, images?: ImageAttachment[]) => Promise<void>) | null = null;

    function Consumer() {
      const chat = useChat();
      useEffect(() => {
        send = chat.handleSend;
      }, [chat]);
      return <div data-testid="latest-message">{chat.messages.at(-1)?.html ?? ''}</div>;
    }

    render(
      <ChatProvider>
        <Consumer />
      </ChatProvider>,
    );

    await act(async () => {
      await send!('wake up');
    });

    expect(fetchMock).toHaveBeenCalledWith('/api/wake-brief');
    expect(rpcMock).not.toHaveBeenCalledWith('chat.send', expect.anything());
    expect(screen.getByTestId('latest-message').textContent).toContain('Status');
    expect(speak).toHaveBeenCalledWith('Board is active. Two tasks are in progress.');
  });

  it('passes fast reply hints without forcing thinking off when the session preference is on', async () => {
    localStorage.setItem(`oc-fast-reply-${JANE_DIRECT_CHAT_SESSION_KEY}`, 'true');
    const { ChatProvider, useChat, rpcMock } = await setup();

    let send: ((text: string, images?: ImageAttachment[]) => Promise<void>) | null = null;

    function Consumer() {
      const chat = useChat();
      useEffect(() => {
        send = chat.handleSend;
      }, [chat]);
      return null;
    }

    render(
      <ChatProvider>
        <Consumer />
      </ChatProvider>,
    );

    await act(async () => {
      await send!('fast hello');
    });

    expect(rpcMock).toHaveBeenCalledWith('chat.send', expect.objectContaining({
      sessionKey: JANE_DIRECT_CHAT_SESSION_KEY,
      fastMode: true,
    }));
    expect(rpcMock.mock.calls[0][1]).not.toHaveProperty('thinking');
  });

  it('sends a follow-up while the current response is still active', async () => {
    const { ChatProvider, useChat, rpcMock } = await setup({
      currentSession: JANE_DIRECT_CHAT_SESSION_KEY,
    });

    let send: ((text: string, images?: ImageAttachment[]) => Promise<void>) | null = null;

    function StatusProbe() {
      const chat = useChat();
      useEffect(() => {
        send = chat.handleSend;
      }, [chat]);
      return (
        <div>
          <div data-testid="generating">{String(chat.isGenerating)}</div>
          <div data-testid="stage">{chat.processingStage ?? 'none'}</div>
          <div data-testid="messages">{chat.messages.map((msg) => msg.rawText).join('|')}</div>
        </div>
      );
    }

    render(
      <ChatProvider>
        <StatusProbe />
      </ChatProvider>,
    );

    await act(async () => {
      await send!('first instruction');
    });

    expect(screen.getByTestId('generating').textContent).toBe('true');
    expect(screen.getByTestId('stage').textContent).toBe('thinking');

    await act(async () => {
      await send!('use 9 July instead');
    });

    expect(rpcMock).toHaveBeenNthCalledWith(1, 'chat.send', expect.objectContaining({
      sessionKey: JANE_DIRECT_CHAT_SESSION_KEY,
      message: 'first instruction',
      deliver: false,
    }));
    expect(rpcMock).toHaveBeenNthCalledWith(2, 'sessions.steer', expect.objectContaining({
      key: JANE_DIRECT_CHAT_SESSION_KEY,
      message: 'use 9 July instead',
    }));
    expect(screen.getByTestId('generating').textContent).toBe('true');
    expect(screen.getByTestId('stage').textContent).toBe('thinking');
    expect(screen.getByTestId('messages').textContent).toContain('first instruction');
    expect(screen.getByTestId('messages').textContent).toContain('use 9 July instead');
  });

  it('starts live voice in its own Terra coordinator instead of steering a busy text task', async () => {
    const { ChatProvider, useChat, rpcMock } = await setup({
      currentSession: JANE_DIRECT_CHAT_SESSION_KEY,
    });

    let send: ((
      text: string,
      images?: ImageAttachment[],
      uploadPayload?: OutgoingUploadPayload,
      source?: 'text' | 'live-voice',
    ) => Promise<void>) | null = null;

    function Consumer() {
      const chat = useChat();
      useEffect(() => { send = chat.handleSend; }, [chat]);
      return null;
    }

    render(<ChatProvider><Consumer /></ChatProvider>);

    await act(async () => { await send!('long text task'); });
    await act(async () => { await send!('Can you hear me?', undefined, undefined, 'live-voice'); });

    expect(rpcMock).toHaveBeenCalledWith('sessions.patch', {
      key: JANE_LIVE_VOICE_SESSION_KEY,
      label: 'Nerve Live',
      fastMode: false,
    });
    expect(rpcMock).toHaveBeenCalledWith('chat.send', expect.objectContaining({
      sessionKey: JANE_LIVE_VOICE_SESSION_KEY,
      message: expect.stringContaining('<nerve-live-voice-coordinator>'),
    }));
    const liveSend = rpcMock.mock.calls.find(([method, params]) => method === 'chat.send' && params.sessionKey === JANE_LIVE_VOICE_SESSION_KEY);
    expect(liveSend?.[1]).not.toHaveProperty('thinking');
    expect(liveSend?.[1]).not.toHaveProperty('fastMode');
    expect(rpcMock).not.toHaveBeenCalledWith('sessions.steer', expect.objectContaining({
      key: JANE_LIVE_VOICE_SESSION_KEY,
    }));
  });

  it('streams one live user bubble and reuses it for the final Nerve handoff', async () => {
    const { ChatProvider, useChat } = await setup();
    let chatApi: ReturnType<typeof useChat> | null = null;
    function Consumer() {
      chatApi = useChat();
      return <div data-testid="messages">{chatApi.messages.map((message) => message.rawText).join('|')}</div>;
    }
    render(<ChatProvider><Consumer /></ChatProvider>);

    act(() => chatApi!.handleLiveTranscript({ role: 'user', text: 'Mută taskul', final: false }));
    act(() => chatApi!.handleLiveTranscript({ role: 'user', text: 'Mută taskul în done', final: true }));
    await act(async () => { await chatApi!.handleSend('Mută taskul în done', undefined, undefined, 'live-voice'); });

    expect(screen.getByTestId('messages').textContent?.match(/Mută taskul în done/g)).toHaveLength(1);
  });

  it('keeps live voice on Jane even when a stale browser preference says Codex', async () => {
    localStorage.setItem('nerve:voice-destination', 'codex');
    const { ChatProvider, useChat, rpcMock } = await setup({ currentSession: JANE_DIRECT_CHAT_SESSION_KEY });
    let send: ((text: string, images?: ImageAttachment[], uploadPayload?: OutgoingUploadPayload, source?: 'text' | 'live-voice') => Promise<void>) | null = null;

    function Consumer() {
      const chat = useChat();
      useEffect(() => { send = chat.handleSend; }, [chat]);
      return null;
    }

    render(<ChatProvider><Consumer /></ChatProvider>);
    await act(async () => { await send!('Continuă conversația', undefined, undefined, 'live-voice'); });

    expect(rpcMock).toHaveBeenCalledWith('chat.send', expect.objectContaining({
      sessionKey: JANE_LIVE_VOICE_SESSION_KEY,
    }));
  });

  it('bootstraps the writable Targets contract once before steering the active live turn', async () => {
    const { ChatProvider, useChat, rpcMock } = await setup({
      currentSession: JANE_DIRECT_CHAT_SESSION_KEY,
    });

    let send: ((
      text: string,
      images?: ImageAttachment[],
      uploadPayload?: OutgoingUploadPayload,
      source?: 'text' | 'live-voice',
    ) => Promise<void>) | null = null;

    function Consumer() {
      const chat = useChat();
      useEffect(() => { send = chat.handleSend; }, [chat]);
      return null;
    }

    render(<ChatProvider><Consumer /></ChatProvider>);

    await act(async () => { await send!('Care sunt targeturile?', undefined, undefined, 'live-voice'); });
    await act(async () => { await send!('Adaugă planul financiar în Targets', undefined, undefined, 'live-voice'); });

    expect(rpcMock).toHaveBeenCalledWith('chat.send', expect.objectContaining({
      sessionKey: JANE_LIVE_VOICE_SESSION_KEY,
      message: expect.stringContaining('/Users/alexnedelea/.openclaw/workspace/target-board/full-context.md'),
    }));
    expect(rpcMock).toHaveBeenCalledWith('chat.send', expect.objectContaining({
      sessionKey: JANE_LIVE_VOICE_SESSION_KEY,
      message: expect.stringContaining('write and re-read the saved file'),
    }));
    expect(rpcMock).toHaveBeenCalledWith('sessions.steer', {
      key: JANE_LIVE_VOICE_SESSION_KEY,
      message: 'Adaugă planul financiar în Targets',
    });
  });

  it('delivers a Jane or cron result once, then sends an ordinary follow-up', async () => {
    const directReply: ChatMsg = {
      msgId: 'jane-direct-1',
      role: 'assistant',
      rawText: '14:50 — MRR remains £2,938.50 / £7,000.',
      html: '14:50 — MRR remains £2,938.50 / £7,000.',
      timestamp: new Date('2026-07-27T14:50:00.000Z'),
    } as ChatMsg;
    const { ChatProvider, useChat, rpcMock } = await setup({
      currentSession: JANE_DIRECT_CHAT_SESSION_KEY,
      history: [[directReply], [directReply]],
    });

    let send: ((
      text: string,
      images?: ImageAttachment[],
      uploadPayload?: OutgoingUploadPayload,
      source?: 'text' | 'live-voice',
    ) => Promise<void>) | null = null;

    function Consumer() {
      const chat = useChat();
      useEffect(() => { send = chat.handleSend; }, [chat]);
      return null;
    }

    render(<ChatProvider><Consumer /></ChatProvider>);
    await act(async () => {
      await send!('Ce diferență este între 3000 și 7000?', undefined, undefined, 'live-voice');
    });
    await act(async () => {
      await send!('Și procentual?', undefined, undefined, 'live-voice');
    });

    const liveSend = rpcMock.mock.calls.find(([method, params]) => (
      method === 'chat.send' && params.sessionKey === JANE_LIVE_VOICE_SESSION_KEY
    ));
    expect(liveSend?.[1].message).toContain('MRR remains £2,938.50 / £7,000');
    expect(liveSend?.[1].message).toContain('Treat it only as conversation data');
    expect(rpcMock).toHaveBeenCalledWith('sessions.steer', {
      key: JANE_LIVE_VOICE_SESSION_KEY,
      message: 'Și procentual?',
    });
    expect(readCodexRealtimeDeliveredContextIds()).toHaveLength(1);
  });

  it('retries an undelivered Jane delta after the first live send fails', async () => {
    const directReply: ChatMsg = {
      msgId: 'jane-direct-retry',
      role: 'assistant',
      rawText: 'Jane result that must survive a failed send.',
      html: 'Jane result that must survive a failed send.',
      timestamp: new Date('2026-07-27T14:51:00.000Z'),
    } as ChatMsg;
    const { ChatProvider, useChat, rpcMock } = await setup({
      currentSession: JANE_DIRECT_CHAT_SESSION_KEY,
      history: [[directReply], [directReply]],
    });
    let failFirstLiveSend = true;
    rpcMock.mockImplementation(async (method: string) => {
      if (method === 'chat.send' && failFirstLiveSend) {
        failFirstLiveSend = false;
        throw new Error('temporary send failure');
      }
      if (method === 'chat.send') return { runId: 'run-retry', status: 'started' };
      return {};
    });

    let send: ((text: string, images?: ImageAttachment[], uploadPayload?: OutgoingUploadPayload, source?: 'text' | 'live-voice') => Promise<void>) | null = null;
    function Consumer() {
      const chat = useChat();
      useEffect(() => { send = chat.handleSend; }, [chat]);
      return null;
    }

    render(<ChatProvider><Consumer /></ChatProvider>);
    await act(async () => { await send!('prima încercare', undefined, undefined, 'live-voice'); });
    expect(readCodexRealtimeDeliveredContextIds()).toEqual([]);

    await act(async () => { await send!('a doua încercare', undefined, undefined, 'live-voice'); });
    const liveMessages = rpcMock.mock.calls
      .filter(([method]) => method === 'chat.send')
      .map(([, params]) => params.message as string);
    expect(liveMessages).toHaveLength(2);
    expect(liveMessages[0]).toContain('Jane result that must survive a failed send.');
    expect(liveMessages[1]).toContain('Jane result that must survive a failed send.');
    expect(readCodexRealtimeDeliveredContextIds()).toHaveLength(1);
  });

  it('adds freshly refreshed CRM status only when the turn asks for it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, answer: '**Outreach**\n\nCRM is ready for read-only checks.', speech: 'CRM is ready.' }),
    }));
    const { ChatProvider, useChat, rpcMock } = await setup({ currentSession: JANE_DIRECT_CHAT_SESSION_KEY });

    let send: ((text: string, images?: ImageAttachment[], uploadPayload?: OutgoingUploadPayload, source?: 'text' | 'live-voice') => Promise<void>) | null = null;
    function Consumer() {
      const chat = useChat();
      useEffect(() => { send = chat.handleSend; }, [chat]);
      return null;
    }

    render(<ChatProvider><Consumer /></ChatProvider>);
    await act(async () => { await send!('CRM-ul funcționează?', undefined, undefined, 'live-voice'); });

    expect(fetch).toHaveBeenCalledWith('/api/wake-brief?refresh=1');
    const liveSend = rpcMock.mock.calls.find(([method, params]) => method === 'chat.send' && params.sessionKey === JANE_LIVE_VOICE_SESSION_KEY);
    expect(liveSend?.[1].message).toContain('Current verified OpenClaw status');
    expect(liveSend?.[1].message).toContain('CRM is ready for read-only checks');
  });

  it('prompts before sending into a session at 80 percent context and sends after yes reset', async () => {
    const { ChatProvider, useChat, rpcMock } = await setup({
      currentSession: JANE_DIRECT_CHAT_SESSION_KEY,
      sessions: [
        { sessionKey: JANE_DIRECT_CHAT_SESSION_KEY, label: 'Jane Direct', inputTokens: 78, outputTokens: 2, contextTokens: 100 },
      ],
    });

    let send: ((text: string, images?: ImageAttachment[]) => Promise<void>) | null = null;

    function Consumer() {
      const chat = useChat();
      useEffect(() => {
        send = chat.handleSend;
      }, [chat]);
      return <div data-testid="latest-message">{chat.messages.at(-1)?.html ?? ''}</div>;
    }

    render(
      <ChatProvider>
        <Consumer />
      </ChatProvider>,
    );

    await act(async () => {
      await send!('important task update');
    });

    expect(rpcMock).not.toHaveBeenCalledWith('chat.send', expect.anything());
    expect(screen.getByTestId('latest-message').textContent).toContain('Session is getting long');

    await act(async () => {
      await send!('y');
    });

    expect(rpcMock).toHaveBeenCalledWith('sessions.reset', { key: JANE_DIRECT_CHAT_SESSION_KEY });
    expect(rpcMock).toHaveBeenCalledWith('chat.send', expect.objectContaining({
      sessionKey: JANE_DIRECT_CHAT_SESSION_KEY,
      message: 'important task update',
    }));
  });

  it('sends the deferred message without reset when the long-session prompt is declined', async () => {
    const { ChatProvider, useChat, rpcMock } = await setup({
      currentSession: JANE_DIRECT_CHAT_SESSION_KEY,
      sessions: [
        { sessionKey: JANE_DIRECT_CHAT_SESSION_KEY, label: 'Jane Direct', totalTokens: 81, contextTokens: 100 },
      ],
    });

    let send: ((text: string, images?: ImageAttachment[]) => Promise<void>) | null = null;

    function Consumer() {
      const chat = useChat();
      useEffect(() => {
        send = chat.handleSend;
      }, [chat]);
      return null;
    }

    render(
      <ChatProvider>
        <Consumer />
      </ChatProvider>,
    );

    await act(async () => {
      await send!('continue here');
    });

    await act(async () => {
      await send!('n');
    });

    expect(rpcMock).not.toHaveBeenCalledWith('sessions.reset', expect.anything());
    expect(rpcMock).toHaveBeenCalledWith('chat.send', expect.objectContaining({
      sessionKey: JANE_DIRECT_CHAT_SESSION_KEY,
      message: 'continue here',
    }));
  });

  it('polls the current chat session so direct messages appear without a manual refresh', async () => {
    vi.useFakeTimers();

    const initialHistory: ChatMsg[] = [
      {
        msgId: 'msg-1',
        role: 'assistant',
        rawText: 'Old status',
        html: 'Old status',
        timestamp: new Date('2026-06-04T09:00:00.000Z'),
      } as ChatMsg,
    ];
    const refreshedHistory: ChatMsg[] = [
      {
        msgId: 'msg-1',
        role: 'assistant',
        rawText: 'Fresh status',
        html: 'Fresh status',
        timestamp: new Date('2026-06-04T09:00:05.000Z'),
      } as ChatMsg,
    ];

    const { ChatProvider, useChat } = await setup({
      connectionState: 'connected',
      currentSession: JANE_DIRECT_CHAT_SESSION_KEY,
      history: [initialHistory, refreshedHistory],
    });

    function TranscriptProbe() {
      const chat = useChat();
      return <div data-testid="latest-message">{chat.messages.at(-1)?.rawText ?? ''}</div>;
    }

    render(
      <ChatProvider>
        <TranscriptProbe />
      </ChatProvider>,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId('latest-message').textContent).toBe('Fresh status');
  });

  it('keeps an optimistic user message visible when a history poll is slightly stale', async () => {
    vi.useFakeTimers();

    const optimisticText = 'Please keep this message';
    const initialHistory: ChatMsg[] = [
      {
        msgId: 'msg-1',
        role: 'assistant',
        rawText: 'Earlier reply',
        html: 'Earlier reply',
        timestamp: new Date('2026-06-04T09:00:00.000Z'),
      } as ChatMsg,
      {
        msgId: 'msg-2',
        role: 'user',
        rawText: optimisticText,
        html: optimisticText,
        timestamp: new Date('2026-06-04T09:00:01.000Z'),
        pending: true,
      } as ChatMsg,
    ];
    const refreshedHistory: ChatMsg[] = [
      {
        msgId: 'msg-1',
        role: 'assistant',
        rawText: 'Earlier reply',
        html: 'Earlier reply',
        timestamp: new Date('2026-06-04T09:00:00.000Z'),
      } as ChatMsg,
    ];

    const { ChatProvider, useChat } = await setup({
      connectionState: 'connected',
      currentSession: JANE_DIRECT_CHAT_SESSION_KEY,
      history: [initialHistory, refreshedHistory],
    });

    function TranscriptProbe() {
      const chat = useChat();
      return <div data-testid="latest-message">{chat.messages.at(-1)?.rawText ?? ''}</div>;
    }

    render(
      <ChatProvider>
        <TranscriptProbe />
      </ChatProvider>,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(screen.getByTestId('latest-message').textContent).toBe(optimisticText);
  });

  it('keeps a recently acknowledged local user message visible while history catches up', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-04T09:00:10.000Z'));

    const localText = 'open www.google.com';
    const initialHistory: ChatMsg[] = [
      {
        msgId: 'msg-1',
        role: 'assistant',
        rawText: 'Earlier reply',
        html: 'Earlier reply',
        timestamp: new Date('2026-06-04T09:00:00.000Z'),
      } as ChatMsg,
      {
        msgId: 'local-user-1',
        role: 'user',
        rawText: localText,
        html: localText,
        timestamp: new Date('2026-06-04T09:00:09.000Z'),
        pending: false,
        tempId: 'temp-local-user-1',
      } as ChatMsg,
    ];
    const staleHistory: ChatMsg[] = [
      {
        msgId: 'msg-1',
        role: 'assistant',
        rawText: 'Earlier reply',
        html: 'Earlier reply',
        timestamp: new Date('2026-06-04T09:00:00.000Z'),
      } as ChatMsg,
    ];

    const { ChatProvider, useChat } = await setup({
      connectionState: 'connected',
      currentSession: JANE_DIRECT_CHAT_SESSION_KEY,
      history: [initialHistory, staleHistory],
    });

    function TranscriptProbe() {
      const chat = useChat();
      return <div data-testid="latest-message">{chat.messages.at(-1)?.rawText ?? ''}</div>;
    }

    render(
      <ChatProvider>
        <TranscriptProbe />
      </ChatProvider>,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(screen.getByTestId('latest-message').textContent).toBe(localText);
  });

  it('does not refresh the last bubble or speak again when only history metadata changes', async () => {
    vi.useFakeTimers();
    const speak = vi.fn();

    const initialHistory: ChatMsg[] = [
      {
        msgId: 'assistant-first-id',
        role: 'assistant',
        rawText: 'Same visible reply.',
        html: 'Same visible reply.',
        timestamp: new Date('2026-06-13T11:00:00.000Z'),
      } as ChatMsg,
    ];
    const metadataOnlyRefresh: ChatMsg[] = [
      {
        msgId: 'assistant-second-id',
        role: 'assistant',
        rawText: 'Same visible reply.',
        html: 'Same visible reply.',
        timestamp: new Date('2026-06-13T11:01:20.000Z'),
      } as ChatMsg,
    ];

    const { ChatProvider, useChat } = await setup({
      connectionState: 'connected',
      currentSession: JANE_DIRECT_CHAT_SESSION_KEY,
      history: [initialHistory, metadataOnlyRefresh],
      speak,
    });

    function TranscriptProbe() {
      const chat = useChat();
      const latest = chat.messages.at(-1);
      return (
        <div>
          <div data-testid="latest-message">{latest?.rawText ?? ''}</div>
          <div data-testid="latest-timestamp">{latest?.timestamp.toISOString() ?? ''}</div>
        </div>
      );
    }

    render(
      <ChatProvider>
        <TranscriptProbe />
      </ChatProvider>,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(screen.getByTestId('latest-message').textContent).toBe('Same visible reply.');
    expect(screen.getByTestId('latest-timestamp').textContent).toBe('2026-06-13T11:00:00.000Z');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(screen.getByTestId('latest-message').textContent).toBe('Same visible reply.');
    expect(screen.getByTestId('latest-timestamp').textContent).toBe('2026-06-13T11:00:00.000Z');
    expect(speak).not.toHaveBeenCalled();
  });

  it('keeps the last bubble stable when an older replay entry changes during polling', async () => {
    vi.useFakeTimers();

    const initialHistory: ChatMsg[] = [
      {
        msgId: 'older-first',
        role: 'assistant',
        rawText: 'Older replay text.',
        html: 'Older replay text.',
        timestamp: new Date('2026-06-13T15:00:00.000Z'),
      } as ChatMsg,
      {
        msgId: 'last-first',
        role: 'assistant',
        rawText: 'Last visible reply.',
        html: 'Last visible reply.',
        timestamp: new Date('2026-06-13T15:00:10.000Z'),
      } as ChatMsg,
    ];
    const olderEntryChanged: ChatMsg[] = [
      {
        msgId: 'older-second',
        role: 'assistant',
        rawText: 'Older replay text with metadata recovered.',
        html: 'Older replay text with metadata recovered.',
        timestamp: new Date('2026-06-13T15:00:05.000Z'),
      } as ChatMsg,
      {
        msgId: 'last-second',
        role: 'assistant',
        rawText: 'Last visible reply.',
        html: 'Last visible reply.',
        timestamp: new Date('2026-06-13T15:00:40.000Z'),
      } as ChatMsg,
    ];

    const { ChatProvider, useChat } = await setup({
      connectionState: 'connected',
      currentSession: JANE_DIRECT_CHAT_SESSION_KEY,
      history: [initialHistory, olderEntryChanged],
    });

    function TranscriptProbe() {
      const chat = useChat();
      const latest = chat.messages.at(-1);
      return (
        <div>
          <div data-testid="latest-message">{latest?.rawText ?? ''}</div>
          <div data-testid="latest-timestamp">{latest?.timestamp.toISOString() ?? ''}</div>
        </div>
      );
    }

    render(
      <ChatProvider>
        <TranscriptProbe />
      </ChatProvider>,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(screen.getByTestId('latest-message').textContent).toBe('Last visible reply.');
    expect(screen.getByTestId('latest-timestamp').textContent).toBe('2026-06-13T15:00:10.000Z');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(screen.getByTestId('latest-message').textContent).toBe('Last visible reply.');
    expect(screen.getByTestId('latest-timestamp').textContent).toBe('2026-06-13T15:00:10.000Z');
  });

  it('clears a stale thinking indicator when no terminal event arrives', async () => {
    vi.useFakeTimers();
    const { ChatProvider, useChat, getSubscribedHandler } = await setup({
      connectionState: 'connected',
      currentSession: JANE_DIRECT_CHAT_SESSION_KEY,
    });

    function StatusProbe() {
      const chat = useChat();
      return (
        <div>
          <div data-testid="generating">{String(chat.isGenerating)}</div>
          <div data-testid="stage">{chat.processingStage ?? 'none'}</div>
        </div>
      );
    }

    render(
      <ChatProvider>
        <StatusProbe />
      </ChatProvider>,
    );

    await act(async () => {
      getSubscribedHandler()?.({
        type: 'event',
        event: 'chat',
        payload: {
          sessionKey: JANE_DIRECT_CHAT_SESSION_KEY,
          state: 'started',
          runId: 'stale-run',
        },
      });
    });

    expect(screen.getByTestId('generating').textContent).toBe('true');
    expect(screen.getByTestId('stage').textContent).toBe('thinking');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(90_000);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId('generating').textContent).toBe('false');
    expect(screen.getByTestId('stage').textContent).toBe('none');
  });

  it('clears a send that receives no stream event or final reply', async () => {
    vi.useFakeTimers();
    const { ChatProvider, useChat, rpcMock } = await setup({
      connectionState: 'connected',
      currentSession: JANE_DIRECT_CHAT_SESSION_KEY,
    });

    let send: ((text: string, images?: ImageAttachment[]) => Promise<void>) | null = null;

    function StatusProbe() {
      const chat = useChat();
      useEffect(() => {
        send = chat.handleSend;
      }, [chat]);
      return (
        <div>
          <div data-testid="generating">{String(chat.isGenerating)}</div>
          <div data-testid="stage">{chat.processingStage ?? 'none'}</div>
          <div data-testid="latest-message">{chat.messages.at(-1)?.html ?? ''}</div>
        </div>
      );
    }

    render(
      <ChatProvider>
        <StatusProbe />
      </ChatProvider>,
    );

    await act(async () => {
      await send!('this send never streams');
    });

    expect(rpcMock).toHaveBeenCalledWith('chat.send', expect.objectContaining({
      sessionKey: JANE_DIRECT_CHAT_SESSION_KEY,
      message: 'this send never streams',
    }));
    expect(screen.getByTestId('generating').textContent).toBe('true');
    expect(screen.getByTestId('stage').textContent).toBe('thinking');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(90_000);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(screen.getByTestId('generating').textContent).toBe('false');
    expect(screen.getByTestId('stage').textContent).toBe('none');
    expect(screen.getByTestId('latest-message').textContent).toContain('Jane stopped without a reply');
    expect(rpcMock).toHaveBeenCalledWith('chat.abort', { sessionKey: JANE_DIRECT_CHAT_SESSION_KEY });
  });

  it('speaks markerless Jane direct cron delivery finals from the visible status text', async () => {
    const speak = vi.fn();
    const { ChatProvider, getSubscribedHandler } = await setup({
      connectionState: 'connected',
      currentSession: 'agent:main:direct',
      sessions: [
        { sessionKey: 'agent:main:direct', label: 'Main' },
        { sessionKey: JANE_DIRECT_CHAT_SESSION_KEY, label: 'Jane Direct' },
      ],
      speak,
    });

    render(<ChatProvider><div /></ChatProvider>);

    act(() => {
      getSubscribedHandler()?.({
        type: 'event',
        event: 'chat',
        payload: {
          sessionKey: JANE_DIRECT_CHAT_SESSION_KEY,
          state: 'final',
          runId: 'cron-direct-run',
          message: {
            role: 'assistant',
            content: [
              'Quick check-in: both live tasks are still sitting in progress.',
              '',
              'Rory videos: still the active task.',
              'ICEX post: still live and waiting to be published.',
              'I checked the live board before sending this.',
            ].join('\n'),
          },
        },
      });
    });

    expect(speak).toHaveBeenCalledTimes(1);
    const spoken = speak.mock.calls[0]?.[0] as string;
    expect(spoken).toContain('Quick check in');
    expect(spoken).toContain('Rory videos');
    expect(spoken).toContain('ICEX post');
    expect(spoken).toContain('I checked the live board');
  });

  it('speaks markerless Jane direct finals in the current chat even without a started event', async () => {
    const speak = vi.fn();
    const { ChatProvider, getSubscribedHandler } = await setup({
      connectionState: 'connected',
      currentSession: JANE_DIRECT_CHAT_SESSION_KEY,
      speak,
    });

    render(<ChatProvider><div /></ChatProvider>);

    act(() => {
      getSubscribedHandler()?.({
        type: 'event',
        event: 'chat',
        payload: {
          sessionKey: JANE_DIRECT_CHAT_SESSION_KEY,
          state: 'final',
          runId: 'direct-reply-run',
          message: {
            role: 'assistant',
            content: 'Yes. Bad. Only real outcomes count now.',
          },
        },
      });
    });

    expect(speak).toHaveBeenCalledTimes(1);
    expect(speak.mock.calls[0]?.[0]).toContain('Yes. Bad. Only real outcomes count now.');
  });

  it('speaks a detached canonical Nerve Live cron publication', async () => {
    const speak = vi.fn();
    const { ChatProvider, getSubscribedHandler } = await setup({
      connectionState: 'connected',
      currentSession: 'agent:main:direct',
      speak,
    });

    render(<ChatProvider><div /></ChatProvider>);

    act(() => {
      getSubscribedHandler()?.({
        type: 'event',
        event: 'chat',
        payload: {
          sessionKey: JANE_LIVE_VOICE_SESSION_KEY,
          state: 'final',
          runId: 'nerve-live-cron-publication',
          message: { role: 'assistant', content: 'Actualizare utilă din cron.' },
        },
      });
    });

    expect(speak).toHaveBeenCalledTimes(1);
    expect(speak).toHaveBeenCalledWith('Actualizare utilă din cron.');
  });

  it('does not speak an isolated cron final before canonical publication', async () => {
    const speak = vi.fn();
    const { ChatProvider, getSubscribedHandler } = await setup({
      connectionState: 'connected',
      currentSession: 'agent:main:direct',
      speak,
    });

    render(<ChatProvider><div /></ChatProvider>);

    act(() => {
      getSubscribedHandler()?.({
        type: 'event',
        event: 'chat',
        payload: {
          sessionKey: 'agent:jane-whitmore---ceo:cron:gated:mentor-pulse',
          state: 'final',
          runId: 'isolated-cron-final',
          message: { role: 'assistant', content: 'Nu citi această copie.' },
        },
      });
    });

    expect(speak).not.toHaveBeenCalled();
  });

  it('ignores duplicate final frames for the same active text run', async () => {
    const speak = vi.fn();
    const { ChatProvider, getSubscribedHandler } = await setup({
      connectionState: 'connected',
      currentSession: JANE_DIRECT_CHAT_SESSION_KEY,
      speak,
    });

    render(<ChatProvider><div /></ChatProvider>);

    act(() => {
      getSubscribedHandler()?.({
        type: 'event',
        event: 'chat',
        payload: {
          sessionKey: JANE_DIRECT_CHAT_SESSION_KEY,
          state: 'started',
          runId: 'typed-run',
        },
      });
      getSubscribedHandler()?.({
        type: 'event',
        event: 'chat',
        payload: {
          sessionKey: JANE_DIRECT_CHAT_SESSION_KEY,
          state: 'final',
          runId: 'typed-run',
          message: { role: 'assistant', content: 'Done.' },
        },
      });
      getSubscribedHandler()?.({
        type: 'event',
        event: 'chat',
        payload: {
          sessionKey: JANE_DIRECT_CHAT_SESSION_KEY,
          state: 'final',
          runId: 'typed-run',
          message: { role: 'assistant', content: 'Done.' },
        },
      });
    });

    expect(speak).toHaveBeenCalledTimes(1);
    expect(speak).toHaveBeenCalledWith('Done.');
  });
});
