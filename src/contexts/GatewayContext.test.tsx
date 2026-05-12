import { useEffect } from 'react';
import { render, act } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { GatewayProvider, useGateway } from './GatewayContext';

const { rpcMock, useWebSocketMock } = vi.hoisted(() => ({
  rpcMock: vi.fn(),
  useWebSocketMock: vi.fn(),
}));

vi.mock('@/hooks/useWebSocket', () => ({
  useWebSocket: useWebSocketMock,
}));

function GatewayProbe({ onValue }: { onValue: (value: string) => void }) {
  const { thinking } = useGateway();

  useEffect(() => {
    onValue(thinking);
  }, [thinking, onValue]);

  return null;
}

describe('GatewayContext', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    rpcMock.mockReset();
    useWebSocketMock.mockReset();
    useWebSocketMock.mockReturnValue({
      connectionState: 'connected',
      connect: vi.fn(),
      disconnect: vi.fn(),
      rpc: rpcMock,
      onEvent: { current: null },
      connectError: '',
      reconnectAttempt: 0,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('clears stale thinking when the latest poll no longer reports effort state', async () => {
    let statusCalls = 0;

    rpcMock.mockImplementation(async (method: string) => {
      if (method === 'status') {
        statusCalls += 1;
        return { model: 'gpt-5.4-mini', thinking: statusCalls === 1 ? 'high' : '' };
      }

      return {};
    });

    const observed: string[] = [];

    render(
      <GatewayProvider>
        <GatewayProbe onValue={(value) => observed.push(value)} />
      </GatewayProvider>,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(observed.at(-1)).toBe('high');

    await act(async () => {
      vi.advanceTimersByTime(60_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(observed.at(-1)).toBe('--');
    expect(rpcMock).not.toHaveBeenCalledWith('sessions.list', expect.anything());
  });
});
