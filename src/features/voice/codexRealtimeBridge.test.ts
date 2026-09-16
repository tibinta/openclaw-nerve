import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isCodexRealtimeBootstrapDelivered,
  markCodexRealtimeBootstrapDelivered,
  markCodexRealtimeContextDelivered,
  readCodexRealtimeDeliveredContextIds,
  resetCodexRealtimeSessionSync,
  resolveCodexRealtimeApproval,
  setCodexRealtimeApprovalResolver,
} from './codexRealtimeBridge';

describe('codexRealtimeBridge session sync', () => {
  beforeEach(() => window.localStorage.clear());
  it('persists delivered deltas and clears them with the live session', () => {
    markCodexRealtimeContextDelivered(['ctx-a', 'ctx-a', 'ctx-b']);
    markCodexRealtimeBootstrapDelivered();

    expect(readCodexRealtimeDeliveredContextIds()).toEqual(['ctx-a', 'ctx-b']);
    expect(isCodexRealtimeBootstrapDelivered()).toBe(true);

    resetCodexRealtimeSessionSync();
    expect(readCodexRealtimeDeliveredContextIds()).toEqual([]);
    expect(isCodexRealtimeBootstrapDelivered()).toBe(false);
  });

  it('routes a native approval decision only through the active realtime socket', () => {
    const resolver = vi.fn();
    setCodexRealtimeApprovalResolver(resolver);
    resolveCodexRealtimeApproval(42, 'accept');
    expect(resolver).toHaveBeenCalledWith(42, 'accept');
    setCodexRealtimeApprovalResolver(null);
    expect(() => resolveCodexRealtimeApproval(42, 'accept')).toThrow('unavailable');
  });
});
