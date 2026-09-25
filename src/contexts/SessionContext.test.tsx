import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { SessionProvider, isSessionActivelyBusy, useSessionContext } from './SessionContext';
import { getSessionKey, type GatewayEvent } from '@/types';
import { JANE_DIRECT_CHAT_SESSION_KEY, JANE_LIVE_VOICE_SESSION_KEY } from '@/features/sessions/sessionKeys';
import {
  CODEX_REALTIME_BOOTSTRAP_STORAGE_KEY,
  CODEX_REALTIME_CONTEXT_DELIVERED_STORAGE_KEY,
} from '@/features/voice/codexRealtimeBridge';

const mockUseGateway = vi.fn();
const mockUseSettings = vi.fn();
const playPingMock = vi.fn();
let rpcMock: ReturnType<typeof vi.fn>;
let subscribeMock: ReturnType<typeof vi.fn>;
let connectionStateValue: 'disconnected' | 'connecting' | 'connected' | 'reconnecting' = 'connected';
let subscribedHandler: ((msg: GatewayEvent) => void) | null = null;
let soundEnabledValue = true;

vi.mock('./GatewayContext', () => ({
  useGateway: () => mockUseGateway(),
}));

vi.mock('./SettingsContext', () => ({
  useSettings: () => mockUseSettings(),
}));

vi.mock('@/features/voice/audio-feedback', () => ({
  playPing: (...args: unknown[]) => playPingMock(...args),
}));

function jsonResponse(data: unknown): Response {
  return {
    ok: true,
    json: async () => data,
  } as Response;
}

function SessionLabels() {
  const { sessions, currentSession } = useSessionContext();

  return (
    <div>
      <div data-testid="current-session">{currentSession}</div>
      {sessions.map((session) => (
        <div key={getSessionKey(session)}>{session.label || session.displayName || getSessionKey(session)}</div>
      ))}
    </div>
  );
}

function SessionUnreadProbe() {
  const { currentSession, unreadSessions, setCurrentSession } = useSessionContext();

  return (
    <div>
      <div data-testid="current-session">{currentSession}</div>
      <div data-testid="reviewer-unread">{String(Boolean(unreadSessions['agent:reviewer:main']))}</div>
      <button data-testid="select-reviewer" onClick={() => setCurrentSession('agent:reviewer:main')}>
        Select reviewer
      </button>
    </div>
  );
}

function SessionStatusProbe() {
  const { agentStatus } = useSessionContext();
  return <div data-testid="reviewer-status">{agentStatus['agent:reviewer:main']?.status ?? 'NONE'}</div>;
}

function SessionDeleteAllProbe() {
  const { currentSession, deleteAllSessions, sessions } = useSessionContext();

  return (
    <div>
      <div data-testid="current-session">{currentSession}</div>
      <div data-testid="session-count">{sessions.length}</div>
      <button data-testid="delete-all" onClick={() => void deleteAllSessions()}>
        Delete all
      </button>
    </div>
  );
}

function SessionDeleteSingleProbe() {
  const { currentSession, deleteSession, setCurrentSession } = useSessionContext();

  return (
    <div>
      <div data-testid="current-session">{currentSession}</div>
      <button data-testid="select-designer" onClick={() => setCurrentSession('agent:designer:main')}>
        Select designer
      </button>
      <button data-testid="delete-single" onClick={() => void deleteSession('agent:designer:main')}>
        Delete single
      </button>
    </div>
  );
}

function SessionAutoCompactProbe() {
  const { currentSession, refreshSessions, setCurrentSession } = useSessionContext();

  return (
    <div>
      <div data-testid="current-session">{currentSession}</div>
      <button data-testid="select-live" onClick={() => setCurrentSession(JANE_LIVE_VOICE_SESSION_KEY)}>
        Select live
      </button>
      <button data-testid="refresh" onClick={() => void refreshSessions()}>
        Refresh
      </button>
    </div>
  );
}

function SessionRefreshProbe() {
  const { currentSession, sessions, refreshSessions, setCurrentSession } = useSessionContext();

  return (
    <div>
      <div data-testid="current-session">{currentSession}</div>
      <div data-testid="session-count">{sessions.length}</div>
      <button data-testid="select-reviewer" onClick={() => setCurrentSession('agent:reviewer:main')}>
        Select reviewer
      </button>
      <button data-testid="refresh" onClick={() => void refreshSessions()}>
        Refresh
      </button>
      {sessions.map((session) => (
        <div key={getSessionKey(session)}>{session.label || session.displayName || getSessionKey(session)}</div>
      ))}
    </div>
  );
}

describe('SessionContext', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    subscribedHandler = null;
    soundEnabledValue = true;
    connectionStateValue = 'connected';

    rpcMock = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'sessions.list') {
        const filtered = params && Object.prototype.hasOwnProperty.call(params, 'activeMinutes');
        return {
          sessions: filtered
            ? [
                { sessionKey: 'agent:main:main', label: 'Main' },
                { sessionKey: 'agent:main:cron:daily-digest', label: 'Cron: Daily Digest' },
              ]
            : [
                { sessionKey: 'agent:main:main', label: 'Main' },
                { sessionKey: 'agent:designer:main', label: 'Designer', updatedAt: 1774099479671 },
                { sessionKey: 'agent:main:cron:daily-digest', label: 'Cron: Daily Digest' },
              ],
        };
      }
      return {};
    });

    subscribeMock = vi.fn((handler: (msg: GatewayEvent) => void) => {
      subscribedHandler = handler;
      return () => {};
    });

    mockUseGateway.mockImplementation(() => ({
      connectionState: connectionStateValue,
      rpc: rpcMock,
      subscribe: subscribeMock,
    }));

    mockUseSettings.mockImplementation(() => ({
      soundEnabled: soundEnabledValue,
    }));

    globalThis.fetch = vi.fn((input: string | URL | Request) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

      if (url.includes('/api/server-info')) return Promise.resolve(jsonResponse({ agentName: 'Jen' }));
      if (url.includes('/api/agentlog')) return Promise.resolve(jsonResponse([]));
      if (url.includes('/api/sessions/hidden')) return Promise.resolve(jsonResponse({ ok: true, sessions: [] }));
      if (url.includes('/api/sessions/delete-all')) return Promise.resolve(jsonResponse({ ok: true, deleted: 2, failed: [] }));
      return Promise.resolve(jsonResponse({}));
    }) as typeof fetch;
  });

  it('treats stale running sessions as idle when there is no active run', () => {
    expect(isSessionActivelyBusy({
      sessionKey: 'agent:jane:main',
      status: 'running',
      state: 'running',
      hasActiveRun: false,
      busy: true,
      processing: true,
    }, false)).toBe(false);
  });

  it('keeps active-run sessions busy even if the stored status is stale', () => {
    expect(isSessionActivelyBusy({
      sessionKey: 'agent:jane:main',
      status: 'idle',
      hasActiveRun: true,
    }, false)).toBe(true);
  });

  it('calls agents.create when spawning a root agent', async () => {
    function Spawn() {
      const { spawnSession } = useSessionContext();
      return <button data-testid="spawn" onClick={() => spawnSession({
        kind: 'root', agentName: 'Test', task: 'hi', model: 'anthropic/claude-sonnet-4-5',
      })} />;
    }

    render(<SessionProvider><Spawn /></SessionProvider>);
    await waitFor(() => expect(rpcMock).toHaveBeenCalled());
    screen.getByTestId('spawn').click();
    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith('agents.create', expect.objectContaining({ name: 'Test' }));
    });
  });

  it('seeds Jane chat on the main root before the first sessions poll completes', async () => {
    rpcMock.mockImplementation(async (method: string) => {
      if (method === 'sessions.list') {
        return { sessions: [] };
      }
      return {};
    });

    render(<SessionProvider><SessionLabels /></SessionProvider>);

    await waitFor(() => {
      expect(screen.getByTestId('current-session').textContent).toBe('agent:main:main');
    });
  });

  it('subagent spawn calls /api/sessions/spawn-subagent, refreshes sessions, and switches to the returned child', async () => {
    let sessionsListCalls = 0;
    rpcMock.mockImplementation(async (method: string) => {
      if (method === 'sessions.list') {
        sessionsListCalls += 1;
        return sessionsListCalls >= 2
          ? {
              sessions: [
                { sessionKey: 'agent:reviewer:main', label: 'Reviewer' },
                { sessionKey: 'agent:reviewer:subagent:new-child-uuid', label: 'Reviewer child' },
              ],
            }
          : {
              sessions: [
                { sessionKey: 'agent:reviewer:main', label: 'Reviewer' },
              ],
            };
      }
      return {};
    });

    const spawnedChildKey = 'agent:reviewer:subagent:new-child-uuid';
    const fetchSpy = vi.fn((input: string | URL | Request) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

      if (url.includes('/api/sessions/spawn-subagent')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ ok: true, sessionKey: spawnedChildKey, mode: 'direct' }),
        } as Response);
      }
      if (url.includes('/api/server-info')) return Promise.resolve(jsonResponse({ agentName: 'Jen' }));
      if (url.includes('/api/agentlog')) return Promise.resolve(jsonResponse([]));
      if (url.includes('/api/sessions/hidden')) return Promise.resolve(jsonResponse({ ok: true, sessions: [] }));
      return Promise.resolve(jsonResponse({}));
    }) as typeof fetch;
    globalThis.fetch = fetchSpy;

    function SpawnSubagent() {
      const { spawnSession, currentSession } = useSessionContext();
      return (
        <div>
          <div data-testid="current-session">{currentSession}</div>
          <button
            data-testid="spawn-subagent"
            onClick={() => spawnSession({
              kind: 'subagent',
              task: 'do something',
              label: 'my-task',
              cleanup: 'keep',
              parentSessionKey: 'agent:reviewer:main',
            })}
          />
        </div>
      );
    }

    render(<SessionProvider><SpawnSubagent /></SessionProvider>);

    await waitFor(() => {
      expect(screen.getByTestId('current-session').textContent).toBe(JANE_DIRECT_CHAT_SESSION_KEY);
    });

    await act(async () => {
      screen.getByTestId('spawn-subagent').click();
    });

    await waitFor(() => {
      expect(screen.getByTestId('current-session').textContent).toBe(spawnedChildKey);
    });

    const spawnCall = fetchSpy.mock.calls.find(([input]) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      return url.includes('/api/sessions/spawn-subagent');
    });
    expect(spawnCall).toBeDefined();
    expect(spawnCall?.[1]).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(JSON.parse(String((spawnCall?.[1] as RequestInit).body))).toEqual({
      parentSessionKey: 'agent:reviewer:main',
      task: 'do something',
      label: 'my-task',
      cleanup: 'keep',
    });
    expect(sessionsListCalls).toBeGreaterThanOrEqual(2);
  });

  it('surfaces route error when subagent spawn fails', async () => {
    rpcMock.mockImplementation(async (method: string) => {
      if (method === 'sessions.list') {
        return { sessions: [{ sessionKey: 'agent:reviewer:main', label: 'Reviewer' }] };
      }
      return {};
    });

    globalThis.fetch = vi.fn((input: string | URL | Request) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

      if (url.includes('/api/sessions/spawn-subagent')) {
        return Promise.resolve({
          ok: false,
          json: async () => ({ ok: false, error: 'Gateway connection failed' }),
        } as Response);
      }
      if (url.includes('/api/server-info')) return Promise.resolve(jsonResponse({ agentName: 'Jen' }));
      if (url.includes('/api/agentlog')) return Promise.resolve(jsonResponse([]));
      if (url.includes('/api/sessions/hidden')) return Promise.resolve(jsonResponse({ ok: true, sessions: [] }));
      return Promise.resolve(jsonResponse({}));
    }) as typeof fetch;

    let caughtError: Error | null = null;

    function SpawnSubagentError() {
      const { spawnSession } = useSessionContext();
      return (
        <button
          data-testid="spawn-error"
          onClick={async () => {
            try {
              await spawnSession({
                kind: 'subagent',
                task: 'do something',
                parentSessionKey: 'agent:reviewer:main',
              });
            } catch (err) {
              caughtError = err as Error;
            }
          }}
        />
      );
    }

    render(<SessionProvider><SpawnSubagentError /></SessionProvider>);
    await waitFor(() => expect(rpcMock).toHaveBeenCalled());

    await act(async () => {
      screen.getByTestId('spawn-error').click();
    });

    await waitFor(() => {
      expect(caughtError).not.toBeNull();
    });

    expect(caughtError!.message).toContain('Gateway connection failed');
  });

  it('root spawn still uses agents.create + chat.send and does not call spawn-subagent route', async () => {
    rpcMock.mockImplementation(async (method: string) => {
      if (method === 'sessions.list') {
        return { sessions: [{ sessionKey: 'agent:main:main', label: 'Main' }] };
      }
      return {};
    });

    const fetchSpy = vi.fn((input: string | URL | Request) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      if (url.includes('/api/server-info')) return Promise.resolve(jsonResponse({ agentName: 'Jen' }));
      if (url.includes('/api/agentlog')) return Promise.resolve(jsonResponse([]));
      if (url.includes('/api/sessions/hidden')) return Promise.resolve(jsonResponse({ ok: true, sessions: [] }));
      return Promise.resolve(jsonResponse({}));
    }) as typeof fetch;
    globalThis.fetch = fetchSpy;

    function SpawnRoot() {
      const { spawnSession } = useSessionContext();
      return (
        <button
          data-testid="spawn-root"
          onClick={() => spawnSession({ kind: 'root', agentName: 'NewAgent', task: 'hi' })}
        />
      );
    }

    render(<SessionProvider><SpawnRoot /></SessionProvider>);
    await waitFor(() => expect(rpcMock).toHaveBeenCalled());

    await act(async () => {
      screen.getByTestId('spawn-root').click();
    });

    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith('agents.create', expect.objectContaining({ name: 'NewAgent' }));
      expect(rpcMock).toHaveBeenCalledWith('chat.send', expect.objectContaining({ message: 'hi' }));
    });

    const spawnRouteCalled = fetchSpy.mock.calls.some(([input]) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      return url.includes('/api/sessions/spawn-subagent');
    });
    expect(spawnRouteCalled).toBe(false);
  });

  it('root spawn preserves explicit thinking off for the session and first message', async () => {
    rpcMock.mockImplementation(async (method: string) => {
      if (method === 'sessions.list') {
        return { sessions: [{ sessionKey: 'agent:main:main', label: 'Main' }] };
      }
      return {};
    });

    function SpawnRootOff() {
      const { spawnSession } = useSessionContext();
      return (
        <button
          data-testid="spawn-root-off"
          onClick={() => spawnSession({ kind: 'root', agentName: 'FastAgent', task: 'hi', thinking: 'off' })}
        />
      );
    }

    render(<SessionProvider><SpawnRootOff /></SessionProvider>);
    await waitFor(() => expect(rpcMock).toHaveBeenCalled());

    await act(async () => {
      screen.getByTestId('spawn-root-off').click();
    });

    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith('sessions.patch', expect.objectContaining({
        key: 'agent:fastagent:main',
        thinkingLevel: 'off',
      }));
      expect(rpcMock).toHaveBeenCalledWith('chat.send', expect.objectContaining({
        sessionKey: 'agent:fastagent:main',
        thinking: 'off',
      }));
    });
  });

  it('keeps Jane direct selected even when only the Jane root and legacy main are in the first tiny snapshot', async () => {
    rpcMock.mockImplementation(async (method: string) => {
      if (method === 'sessions.list') {
        return {
          sessions: [
            { sessionKey: 'agent:main:main', label: 'Main' },
            { sessionKey: 'agent:jane-whitmore---ceo:main', label: 'Jane Whitmore' },
          ],
        };
      }
      return {};
    });

    render(
      <SessionProvider>
        <SessionLabels />
      </SessionProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('current-session').textContent).toBe(JANE_DIRECT_CHAT_SESSION_KEY);
    });
  });

  it('defaults to the Jane direct chat thread when it is available', async () => {
    rpcMock.mockImplementation(async (method: string) => {
      if (method === 'sessions.list') {
        return {
          sessions: [
            { sessionKey: 'agent:main:main', label: 'Main' },
            { sessionKey: JANE_DIRECT_CHAT_SESSION_KEY, label: 'Jane Direct' },
            { sessionKey: 'agent:reviewer:main', label: 'Reviewer' },
          ],
        };
      }
      return {};
    });

    render(
      <SessionProvider>
        <SessionLabels />
      </SessionProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('current-session').textContent).toBe(JANE_DIRECT_CHAT_SESSION_KEY);
    });
  });

  it('uses a unique config name when spawning a duplicate root agent', async () => {
    rpcMock.mockImplementation(async (method: string) => {
      if (method === 'sessions.list') {
        return {
          sessions: [
            { sessionKey: 'agent:main:main', label: 'Main' },
            { sessionKey: 'agent:test:main', label: 'Test' },
          ],
        };
      }
      return {};
    });

    function Spawn() {
      const { spawnSession } = useSessionContext();
      return <button data-testid="spawn-duplicate" onClick={() => spawnSession({
        kind: 'root', agentName: 'Test', task: 'hi', model: 'anthropic/claude-sonnet-4-5',
      })} />;
    }

    render(<SessionProvider><Spawn /></SessionProvider>);
    await waitFor(() => expect(rpcMock).toHaveBeenCalledWith('sessions.list', { activeMinutes: 10080, limit: 3 }));
    screen.getByTestId('spawn-duplicate').click();
    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith('agents.create', expect.objectContaining({
        name: 'Test 2',
        workspace: '~/.openclaw/workspace-test-2',
      }));
      expect(rpcMock).toHaveBeenCalledWith('sessions.patch', expect.objectContaining({
        key: 'agent:test-2:main',
        label: 'Test',
      }));
    });
  });

  it('uses a bounded recent gateway session list for sidebar refreshes so Nerve does not overload the gateway', async () => {
    render(
      <SessionProvider>
        <SessionLabels />
      </SessionProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText('Cron: Daily Digest')).toBeInTheDocument();
    });

    expect(rpcMock).toHaveBeenCalledWith('sessions.list', { activeMinutes: 10080, limit: 3 });
  });

  it('keeps the last live snapshot when one refresh returns an empty list', async () => {
    let sessionsListCalls = 0;
    rpcMock.mockImplementation(async (method: string) => {
      if (method === 'sessions.list') {
        sessionsListCalls += 1;
        return {
          sessions: sessionsListCalls === 1
            ? [
                { sessionKey: 'agent:main:main', label: 'Main' },
                { sessionKey: 'agent:designer:main', label: 'Designer' },
              ]
            : [],
        };
      }
      return {};
    });

    render(
      <SessionProvider>
        <SessionRefreshProbe />
      </SessionProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('session-count').textContent).toBe('2');
    });
    expect(screen.getByTestId('current-session').textContent).toBe(JANE_DIRECT_CHAT_SESSION_KEY);

    await act(async () => {
      screen.getByTestId('refresh').click();
    });

    expect(screen.getByTestId('session-count').textContent).toBe('2');
    expect(screen.getByTestId('current-session').textContent).toBe(JANE_DIRECT_CHAT_SESSION_KEY);
    expect(sessionsListCalls).toBe(2);
  });

  it('keeps the manually selected session when a manual refresh returns a partial snapshot', async () => {
    let sessionsListCalls = 0;
    rpcMock.mockImplementation(async (method: string) => {
      if (method === 'sessions.list') {
        sessionsListCalls += 1;
        return {
          sessions: sessionsListCalls === 1
            ? [
                { sessionKey: 'agent:jane-whitmore---ceo:main', label: 'Jane' },
                { sessionKey: 'agent:reviewer:main', label: 'Reviewer' },
              ]
            : [{ sessionKey: 'agent:jane-whitmore---ceo:main', label: 'Jane' }],
        };
      }
      return {};
    });

    render(
      <SessionProvider>
        <SessionRefreshProbe />
      </SessionProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('session-count').textContent).toBe('2');
    });
    await act(async () => {
      screen.getByTestId('select-reviewer').click();
    });

    await act(async () => {
      screen.getByTestId('refresh').click();
    });

    expect(screen.getByTestId('current-session').textContent).toBe('agent:reviewer:main');
    expect(screen.getByTestId('session-count').textContent).toBe('1');
    expect(sessionsListCalls).toBe(2);
  });

  it('refreshes agent presence from the session snapshot so stale busy states clear without a manual reload', async () => {
    vi.useFakeTimers();

    let sessionsListCalls = 0;
    rpcMock.mockImplementation(async (method: string) => {
      if (method === 'sessions.list') {
        sessionsListCalls += 1;
        return {
          sessions: sessionsListCalls === 1
            ? [
                { sessionKey: 'agent:main:main', label: 'Main' },
                { sessionKey: 'agent:reviewer:main', label: 'Reviewer', state: 'running', hasActiveRun: true },
              ]
            : [
                { sessionKey: 'agent:main:main', label: 'Main' },
                { sessionKey: 'agent:reviewer:main', label: 'Reviewer', state: 'idle', hasActiveRun: false },
              ],
        };
      }
      return {};
    });

    render(
      <SessionProvider>
        <SessionStatusProbe />
      </SessionProvider>,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId('reviewer-status').textContent).toBe('THINKING');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId('reviewer-status').textContent).toBe('IDLE');

    expect(sessionsListCalls).toBeGreaterThanOrEqual(2);
  });

  it('clears a stale event-only thinking status when no terminal event arrives', async () => {
    vi.useFakeTimers();

    rpcMock.mockImplementation(async (method: string) => {
      if (method === 'sessions.list') {
        return {
          sessions: [
            { sessionKey: 'agent:main:main', label: 'Main' },
            { sessionKey: 'agent:reviewer:main', label: 'Reviewer' },
          ],
        };
      }
      return {};
    });

    render(
      <SessionProvider>
        <SessionStatusProbe />
      </SessionProvider>,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId('reviewer-status').textContent).toBe('NONE');

    act(() => {
      subscribedHandler?.({
        type: 'event',
        event: 'chat',
        payload: {
          sessionKey: 'agent:reviewer:main',
          state: 'started',
        },
      });
    });

    expect(screen.getByTestId('reviewer-status').textContent).toBe('THINKING');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(95_000);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId('reviewer-status').textContent).toBe('IDLE');
  });

  it('shows a newly announced session immediately before the full session list catches up', async () => {
    let sessionsListCalls = 0;
    rpcMock.mockImplementation(async (method: string) => {
      if (method === 'sessions.list') {
        sessionsListCalls += 1;
        return {
          sessions: [
            { sessionKey: 'agent:jane-whitmore---ceo:main', label: 'Jane Whitmore - CEO' },
          ],
        };
      }
      return {};
    });

    render(
      <SessionProvider>
        <SessionRefreshProbe />
      </SessionProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText('Jane Whitmore - CEO')).toBeInTheDocument();
    });

    act(() => {
      subscribedHandler?.({
        type: 'event',
        event: 'chat',
        payload: {
          sessionKey: 'agent:jane-whitmore---ceo:subagent:fresh-worker',
          state: 'started',
        },
      });
    });

    await waitFor(() => {
      expect(screen.getByText('Subagent fresh-wo')).toBeInTheDocument();
    });
    expect(screen.getByTestId('session-count').textContent).toBe('2');
    expect(sessionsListCalls).toBe(1);
  });

  it('deletes every loaded session except the protected main root and resets the current session to blank', async () => {
    rpcMock.mockImplementation(async (method: string) => {
      if (method === 'sessions.list') {
        return {
          sessions: [
            { sessionKey: 'agent:main:main', label: 'Main' },
            { sessionKey: 'agent:designer:main', label: 'Designer' },
            { sessionKey: 'agent:main:cron:daily-digest', label: 'Cron: Daily Digest' },
          ],
        };
      }
      return {};
    });

    render(
      <SessionProvider>
        <SessionDeleteAllProbe />
      </SessionProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('current-session').textContent).toBe(JANE_DIRECT_CHAT_SESSION_KEY);
    });
    await waitFor(() => {
      expect(screen.getByTestId('session-count').textContent).toBe('3');
    });

    await act(async () => {
      screen.getByTestId('delete-all').click();
    });

    await waitFor(() => {
      expect(screen.getByTestId('current-session').textContent).toBe('');
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/sessions/delete-all',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });

  it('deletes a single session and its descendants through the HTTP delete-all route', async () => {
    rpcMock.mockImplementation(async (method: string) => {
      if (method === 'sessions.list') {
        return {
          sessions: [
            { sessionKey: 'agent:main:main', label: 'Main' },
            { sessionKey: 'agent:designer:main', label: 'Designer' },
            { sessionKey: 'agent:designer:subagent:child', label: 'Designer child' },
          ],
        };
      }
      return {};
    });

    render(
      <SessionProvider>
        <SessionDeleteSingleProbe />
      </SessionProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('current-session').textContent).toBe(JANE_DIRECT_CHAT_SESSION_KEY);
    });

    await act(async () => {
      screen.getByTestId('select-designer').click();
      screen.getByTestId('delete-single').click();
    });

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/api/sessions/delete-all',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            keys: ['agent:designer:subagent:child', 'agent:designer:main'],
          }),
        }),
      );
    });
    expect(screen.getByTestId('current-session').textContent).toBe('agent:main:main');
  });

  it('auto-compacts the current session once when context usage crosses 70 percent', async () => {
    let sessionsListCalls = 0;
    rpcMock.mockImplementation(async (method: string) => {
      if (method === 'sessions.list') {
        sessionsListCalls += 1;
        return {
          sessions: [
            {
              sessionKey: JANE_DIRECT_CHAT_SESSION_KEY,
              label: 'Jane Direct',
              totalTokens: 71_000,
              contextTokens: 100_000,
            },
          ],
        };
      }
      if (method === 'sessions.compact') {
        return { ok: true };
      }
      return {};
    });

    render(
      <SessionProvider>
        <SessionAutoCompactProbe />
      </SessionProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('current-session').textContent).toBe(JANE_DIRECT_CHAT_SESSION_KEY);
    });

    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith('sessions.compact', { key: JANE_DIRECT_CHAT_SESSION_KEY });
    });

    const compactCallsBeforeRefresh = rpcMock.mock.calls.filter(([method]) => method === 'sessions.compact').length;

    await act(async () => {
      screen.getByTestId('refresh').click();
    });

    await waitFor(() => {
      expect(rpcMock.mock.calls.filter(([method]) => method === 'sessions.compact').length)
        .toBe(compactCallsBeforeRefresh);
    });

    expect(sessionsListCalls).toBeGreaterThanOrEqual(2);
  });

  it('clears live voice delivery cursors after auto-compacting Nerve Live', async () => {
    window.localStorage.setItem(CODEX_REALTIME_BOOTSTRAP_STORAGE_KEY, '1');
    window.localStorage.setItem(CODEX_REALTIME_CONTEXT_DELIVERED_STORAGE_KEY, JSON.stringify(['ctx-old']));

    rpcMock.mockImplementation(async (method: string) => {
      if (method === 'sessions.list') {
        return {
          sessions: [{
            sessionKey: JANE_LIVE_VOICE_SESSION_KEY,
            label: 'Nerve Live',
            totalTokens: 71_000,
            contextTokens: 100_000,
          }],
        };
      }
      if (method === 'sessions.compact') return { ok: true };
      return {};
    });

    render(
      <SessionProvider>
        <SessionAutoCompactProbe />
      </SessionProvider>,
    );

    await act(async () => {
      screen.getByTestId('select-live').click();
    });
    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith('sessions.compact', { key: JANE_LIVE_VOICE_SESSION_KEY });
    });
    await waitFor(() => {
      expect(window.localStorage.getItem(CODEX_REALTIME_BOOTSTRAP_STORAGE_KEY)).toBeNull();
      expect(window.localStorage.getItem(CODEX_REALTIME_CONTEXT_DELIVERED_STORAGE_KEY)).toBeNull();
    });
  });

  it('marks background top-level roots unread on start and pings when chat reaches a terminal event', async () => {
    rpcMock.mockImplementation(async (method: string) => {
      if (method === 'sessions.list') {
        return {
          sessions: [
            { sessionKey: 'agent:main:main', label: 'Main' },
            { sessionKey: 'agent:reviewer:main', label: 'Reviewer' },
          ],
        };
      }
      return {};
    });

    render(
      <SessionProvider>
        <SessionUnreadProbe />
      </SessionProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('current-session').textContent).toBe(JANE_DIRECT_CHAT_SESSION_KEY);
    });

    act(() => {
      subscribedHandler?.({
        type: 'event',
        event: 'chat',
        payload: {
          sessionKey: 'agent:reviewer:main',
          state: 'started',
        },
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('reviewer-unread').textContent).toBe('true');
    });
    expect(playPingMock).not.toHaveBeenCalled();

    await act(async () => {
      subscribedHandler?.({
        type: 'event',
        event: 'chat',
        payload: {
          sessionKey: 'agent:reviewer:main',
          state: 'final',
        },
      });
      await Promise.resolve();
    });

    expect(playPingMock).toHaveBeenCalledTimes(1);
  });

  it('does not mark the currently viewed root unread or ping for its own chat events', async () => {
    rpcMock.mockImplementation(async (method: string) => {
      if (method === 'sessions.list') {
        return {
          sessions: [
            { sessionKey: 'agent:main:main', label: 'Main' },
            { sessionKey: 'agent:reviewer:main', label: 'Reviewer' },
          ],
        };
      }
      return {};
    });

    render(
      <SessionProvider>
        <SessionUnreadProbe />
      </SessionProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('current-session').textContent).toBe(JANE_DIRECT_CHAT_SESSION_KEY);
    });

    act(() => {
      screen.getByTestId('select-reviewer').click();
    });

    await waitFor(() => {
      expect(screen.getByTestId('current-session').textContent).toBe('agent:reviewer:main');
    });

    act(() => {
      subscribedHandler?.({
        type: 'event',
        event: 'chat',
        payload: {
          sessionKey: 'agent:reviewer:main',
          state: 'started',
        },
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('reviewer-unread').textContent).toBe('false');
    });
    expect(playPingMock).not.toHaveBeenCalled();
  });

  it('does not mark unread or ping when a root becomes current in the same act as its chat event', async () => {
    rpcMock.mockImplementation(async (method: string) => {
      if (method === 'sessions.list') {
        return {
          sessions: [
            { sessionKey: 'agent:main:main', label: 'Main' },
            { sessionKey: 'agent:reviewer:main', label: 'Reviewer' },
          ],
        };
      }
      return {};
    });

    render(
      <SessionProvider>
        <SessionUnreadProbe />
      </SessionProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('current-session').textContent).toBe(JANE_DIRECT_CHAT_SESSION_KEY);
    });

    act(() => {
      screen.getByTestId('select-reviewer').click();
      subscribedHandler?.({
        type: 'event',
        event: 'chat',
        payload: {
          sessionKey: 'agent:reviewer:main',
          state: 'started',
        },
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('current-session').textContent).toBe('agent:reviewer:main');
    });
    expect(screen.getByTestId('reviewer-unread').textContent).toBe('false');
    expect(playPingMock).not.toHaveBeenCalled();
  });

  it('keeps the DONE-to-IDLE timer alive when sound is toggled mid-response', async () => {
    rpcMock.mockImplementation(async (method: string) => {
      if (method === 'sessions.list') {
        return {
          sessions: [
            { sessionKey: 'agent:main:main', label: 'Main' },
            { sessionKey: 'agent:reviewer:main', label: 'Reviewer' },
          ],
        };
      }
      return {};
    });

    const view = render(
      <SessionProvider>
        <SessionStatusProbe />
      </SessionProvider>,
    );

    await waitFor(() => {
      expect(subscribedHandler).not.toBeNull();
    });

    vi.useFakeTimers();

    await act(async () => {
      subscribedHandler?.({
        type: 'event',
        event: 'chat',
        payload: {
          sessionKey: 'agent:reviewer:main',
          state: 'final',
        },
      });
      await Promise.resolve();
    });

    expect(screen.getByTestId('reviewer-status').textContent).toBe('DONE');

    await act(async () => {
      soundEnabledValue = false;
      view.rerender(
        <SessionProvider>
          <SessionStatusProbe />
        </SessionProvider>,
      );
      await Promise.resolve();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100);
    });

    expect(screen.getByTestId('reviewer-status').textContent).toBe('IDLE');
  });

  it('uses the latest refresh callback for delayed refreshes after gateway changes', async () => {
    const rpcBeforeReconnect = vi.fn(async (method: string) => {
      if (method === 'sessions.list') {
        return {
          sessions: [
            { sessionKey: 'agent:main:main', label: 'Main' },
            { sessionKey: 'agent:reviewer:main', label: 'Reviewer' },
          ],
        };
      }
      return {};
    });
    const rpcAfterReconnect = vi.fn(async () => ({}));
    rpcMock = rpcBeforeReconnect;

    const view = render(
      <SessionProvider>
        <SessionStatusProbe />
      </SessionProvider>,
    );

    await waitFor(() => {
      expect(rpcBeforeReconnect).toHaveBeenCalledWith('sessions.list', { activeMinutes: 10080, limit: 3 });
    });

    vi.useFakeTimers();

    await act(async () => {
      subscribedHandler?.({
        type: 'event',
        event: 'chat',
        payload: {
          sessionKey: 'agent:reviewer:main',
          state: 'final',
        },
      });
      await Promise.resolve();
    });

    const preReconnectSessionsListCalls = rpcBeforeReconnect.mock.calls.filter(([method]) => method === 'sessions.list').length;

    await act(async () => {
      connectionStateValue = 'reconnecting';
      rpcMock = rpcAfterReconnect;
      view.rerender(
        <SessionProvider>
          <SessionStatusProbe />
        </SessionProvider>,
      );
      await Promise.resolve();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_600);
    });

    expect(rpcBeforeReconnect.mock.calls.filter(([method]) => method === 'sessions.list')).toHaveLength(preReconnectSessionsListCalls);
    expect(rpcAfterReconnect).not.toHaveBeenCalledWith('sessions.list', expect.anything());
  });

  it('uses the latest refresh callback for missing-session fallback refreshes after gateway changes', async () => {
    const rpcBeforeReconnect = vi.fn(async (method: string) => {
      if (method === 'sessions.list') {
        return {
          sessions: [
            { sessionKey: 'agent:main:main', label: 'Main' },
            { sessionKey: 'agent:reviewer:main', label: 'Reviewer' },
          ],
        };
      }
      return {};
    });
    const rpcAfterReconnect = vi.fn(async () => ({}));
    rpcMock = rpcBeforeReconnect;

    const view = render(
      <SessionProvider>
        <SessionStatusProbe />
      </SessionProvider>,
    );

    await waitFor(() => {
      expect(rpcBeforeReconnect).toHaveBeenCalledWith('sessions.list', { activeMinutes: 10080, limit: 3 });
    });

    vi.useFakeTimers();

    await act(async () => {
      subscribedHandler?.({
        type: 'event',
        event: 'chat',
        payload: {
          sessionKey: 'agent:fresh:main',
          state: 'started',
        },
      });
      await Promise.resolve();
    });

    const preReconnectSessionsListCalls = rpcBeforeReconnect.mock.calls.filter(([method]) => method === 'sessions.list').length;

    await act(async () => {
      connectionStateValue = 'reconnecting';
      rpcMock = rpcAfterReconnect;
      view.rerender(
        <SessionProvider>
          <SessionStatusProbe />
        </SessionProvider>,
      );
      await Promise.resolve();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });

    expect(rpcBeforeReconnect.mock.calls.filter(([method]) => method === 'sessions.list')).toHaveLength(preReconnectSessionsListCalls);
    expect(rpcAfterReconnect).not.toHaveBeenCalledWith('sessions.list', expect.anything());
  });
});
