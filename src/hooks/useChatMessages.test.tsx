import { renderHook, act } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useRef } from 'react';
import { useChatMessages } from './useChatMessages';

function useProbe(rpc: (method: string, params?: Record<string, unknown>) => Promise<unknown>) {
  const currentSessionRef = useRef('agent:jane:main');
  return useChatMessages({ rpc, currentSessionRef });
}

describe('useChatMessages', () => {
  it('loads only the first visible history page on session switch', async () => {
    const rpc = vi.fn(async () => ({ messages: [] }));
    const { result } = renderHook(() => useProbe(rpc));

    await act(async () => {
      await result.current.loadHistory('agent:jane:main');
    });

    expect(rpc).toHaveBeenCalledWith('chat.history', {
      sessionKey: 'agent:jane:main',
      limit: 50,
    });
  });
});
