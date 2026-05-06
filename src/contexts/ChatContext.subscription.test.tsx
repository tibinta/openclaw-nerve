/** Regression test: ChatContext should not resubscribe on local state updates. */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import type { ImageAttachment } from '@/features/chat/types';
import { JANE_DIRECT_CHAT_SESSION_KEY } from '@/features/sessions/sessionKeys';

describe('ChatContext subscription stability', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  async function setup() {
    const subscribeMock = vi.fn(() => () => {});
    const rpcMock = vi.fn(async (method: string) => {
      if (method === 'chat.send') return { runId: 'run-1', status: 'started' };
      return {};
    });
    const setCurrentSessionMock = vi.fn();

    vi.doMock('./GatewayContext', () => ({
      useGateway: () => ({
        connectionState: 'disconnected',
        rpc: rpcMock,
        subscribe: subscribeMock,
      }),
    }));

    vi.doMock('./SessionContext', () => ({
      useSessionContext: () => ({
        currentSession: '',
        sessions: [
          { sessionKey: JANE_DIRECT_CHAT_SESSION_KEY, label: 'Jane Direct' },
        ],
        setCurrentSession: setCurrentSessionMock,
      }),
    }));

    vi.doMock('./SettingsContext', () => ({
      useSettings: () => ({
        soundEnabled: false,
        speak: vi.fn(),
      }),
    }));

    const mod = await import('./ChatContext');
    return { ...mod, subscribeMock, rpcMock, setCurrentSessionMock };
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
});
