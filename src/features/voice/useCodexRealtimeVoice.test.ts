import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCodexRealtimeVoice } from './useCodexRealtimeVoice';
import { resolveCodexRealtimeApproval, subscribeCodexRealtimeApprovals } from './codexRealtimeBridge';

class FakeSocket {
  static OPEN = 1;
  static instance: FakeSocket;
  readyState = FakeSocket.OPEN;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];

  constructor() { FakeSocket.instance = this; }
  send(message: string) { this.sent.push(message); }
  close() { this.readyState = 3; }
  emit(message: object) { this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent); }
}

class FakeAudio {
  static instance: FakeAudio;
  autoplay = false;
  muted = false;
  srcObject: MediaStream | null = null;
  play = vi.fn(async () => undefined);

  constructor() { FakeAudio.instance = this; }
}

describe('useCodexRealtimeVoice', () => {
  const stopTrack = vi.fn();
  const microphoneTrack = { enabled: true, readyState: 'live', stop: stopTrack };

  beforeEach(() => {
    stopTrack.mockClear();
    microphoneTrack.enabled = true;
    window.localStorage.clear();
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.stubGlobal('Audio', FakeAudio);
    vi.stubGlobal('RTCPeerConnection', class {
      ontrack = null;
      addTrack() {}
      createDataChannel() {}
      createOffer() { return Promise.resolve({ type: 'offer', sdp: 'v=0\r\n' }); }
      setLocalDescription() { return Promise.resolve(); }
      setRemoteDescription() { return Promise.resolve(); }
      close() {}
    });
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn().mockResolvedValue({
        getAudioTracks: () => [microphoneTrack],
        getTracks: () => [microphoneTrack],
      }) },
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it('keeps listening after a post-start realtime playback error', async () => {
    const { result, unmount } = renderHook(() => useCodexRealtimeVoice(vi.fn()));
    let started!: Promise<boolean>;
    await act(async () => { started = result.current.start(); });

    act(() => FakeSocket.instance.emit({ method: 'nerve/realtime/ready', params: {} }));
    await waitFor(() => expect(FakeSocket.instance.sent).toHaveLength(1));
    expect(JSON.parse(FakeSocket.instance.sent[0]).params.voice).toBe('juniper');

    act(() => FakeSocket.instance.emit({ method: 'thread/realtime/started', params: {} }));
    await expect(started).resolves.toBe(true);
    act(() => FakeSocket.instance.emit({
      method: 'thread/realtime/error',
      params: { message: 'Connection reset by peer' },
    }));

    expect(result.current.status).toBe('listening');
    expect(result.current.error).toBe('Voice playback was interrupted; listening is still active.');
    expect(stopTrack).not.toHaveBeenCalled();
    unmount();
  });

  it('keeps WebRTC output live while user speech arrives', async () => {
    const { result, unmount } = renderHook(() => useCodexRealtimeVoice(vi.fn()));
    let started!: Promise<boolean>;
    await act(async () => { started = result.current.start(); });
    act(() => FakeSocket.instance.emit({ method: 'nerve/realtime/ready', params: {} }));
    await waitFor(() => expect(FakeSocket.instance.sent).toHaveLength(1));
    act(() => FakeSocket.instance.emit({ method: 'thread/realtime/started', params: {} }));
    await expect(started).resolves.toBe(true);

    expect(FakeAudio.instance.muted).toBe(false);

    act(() => FakeSocket.instance.emit({
      method: 'thread/realtime/transcript/delta',
      params: { role: 'user', delta: 'Stai puțin' },
    }));

    expect(FakeAudio.instance.muted).toBe(false);
    expect(result.current.status).toBe('listening');

    expect(FakeAudio.instance.muted).toBe(false);
    expect(FakeSocket.instance.sent.map((entry) => JSON.parse(entry).method)).not.toContain('thread/realtime/appendSpeech');
    unmount();
  });

  it('mutes only microphone input while keeping GPT-Live and Jane audio active', async () => {
    const { result, unmount } = renderHook(() => useCodexRealtimeVoice(vi.fn()));
    let started!: Promise<boolean>;
    await act(async () => { started = result.current.start(); });
    act(() => FakeSocket.instance.emit({ method: 'nerve/realtime/ready', params: {} }));
    await waitFor(() => expect(FakeSocket.instance.sent).toHaveLength(1));
    act(() => FakeSocket.instance.emit({ method: 'thread/realtime/started', params: {} }));
    await expect(started).resolves.toBe(true);

    act(() => result.current.toggleMicrophoneMuted());
    expect(result.current.isMicrophoneMuted).toBe(true);
    expect(microphoneTrack.enabled).toBe(false);
    expect(result.current.status).toBe('listening');
    expect(stopTrack).not.toHaveBeenCalled();

    expect(FakeAudio.instance.muted).toBe(false);

    act(() => result.current.toggleMicrophoneMuted());
    expect(result.current.isMicrophoneMuted).toBe(false);
    expect(microphoneTrack.enabled).toBe(true);
    unmount();
  });

  it('batches transcript deltas into one caption render while preserving the complete final text', async () => {
    vi.useFakeTimers();
    try {
      const onTranscript = vi.fn();
      const { result, unmount } = renderHook(() => useCodexRealtimeVoice(onTranscript));
      let started!: Promise<boolean>;
      await act(async () => { started = result.current.start(); });
      act(() => FakeSocket.instance.emit({ method: 'nerve/realtime/ready', params: {} }));
      await act(async () => { await Promise.resolve(); });
      act(() => FakeSocket.instance.emit({ method: 'thread/realtime/started', params: {} }));
      await expect(started).resolves.toBe(true);

      act(() => {
        FakeSocket.instance.emit({ method: 'thread/realtime/transcript/delta', params: { role: 'assistant', delta: 'One ' } });
        FakeSocket.instance.emit({ method: 'thread/realtime/transcript/delta', params: { role: 'assistant', delta: 'complete ' } });
        FakeSocket.instance.emit({ method: 'thread/realtime/transcript/delta', params: { role: 'assistant', delta: 'reply' } });
      });

      expect(result.current.caption).toBeNull();
      await act(async () => { await vi.advanceTimersByTimeAsync(50); });
      expect(result.current.caption).toEqual({ role: 'assistant', text: 'One complete reply' });

      act(() => FakeSocket.instance.emit({
        method: 'thread/realtime/transcript/done',
        params: { role: 'assistant', text: 'One complete reply.' },
      }));
      expect(result.current.caption).toEqual({ role: 'assistant', text: 'One complete reply.' });
      expect(onTranscript).toHaveBeenNthCalledWith(1, { role: 'assistant', text: 'One ', final: false });
      expect(onTranscript).toHaveBeenNthCalledWith(3, { role: 'assistant', text: 'One complete reply', final: false });
      expect(onTranscript).toHaveBeenLastCalledWith({ role: 'assistant', text: 'One complete reply.', final: true });
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps completed user speech as passive transcript history', async () => {
    const onTranscript = vi.fn();
    const { result, unmount } = renderHook(() => useCodexRealtimeVoice(onTranscript));
    let started!: Promise<boolean>;
    await act(async () => { started = result.current.start(); });
    act(() => FakeSocket.instance.emit({ method: 'nerve/realtime/ready', params: {} }));
    await waitFor(() => expect(FakeSocket.instance.sent).toHaveLength(1));
    act(() => FakeSocket.instance.emit({ method: 'thread/realtime/started', params: {} }));
    await expect(started).resolves.toBe(true);

    act(() => {
      FakeSocket.instance.emit({ method: 'thread/realtime/transcript/delta', params: { role: 'user', delta: 'Mută taskul în done' } });
      FakeSocket.instance.emit({ method: 'thread/realtime/transcript/delta', params: { role: 'assistant', delta: 'Sigur.' } });
      FakeSocket.instance.emit({ method: 'thread/realtime/transcript/done', params: { role: 'user', text: 'Mută taskul în done' } });
    });

    expect(onTranscript).toHaveBeenCalledWith({ role: 'user', text: 'Mută taskul în done', final: true });
    expect(FakeSocket.instance.sent.map((entry) => JSON.parse(entry).method)).not.toContain('chat.send');
    unmount();
  });

  it('reports an unexpected disconnect and leaves realtime idle', async () => {
    const getUserMedia = vi.mocked(navigator.mediaDevices.getUserMedia);
    const { result, unmount } = renderHook(() => useCodexRealtimeVoice(vi.fn()));
    let started!: Promise<boolean>;
    await act(async () => { started = result.current.start(); });
    act(() => FakeSocket.instance.emit({ method: 'nerve/realtime/ready', params: {} }));
    await waitFor(() => expect(FakeSocket.instance.sent).toHaveLength(1));
    act(() => FakeSocket.instance.emit({ method: 'thread/realtime/started', params: {} }));
    await expect(started).resolves.toBe(true);

    act(() => FakeSocket.instance.onclose?.());

    expect(result.current.status).toBe('idle');
    expect(result.current.error).toBe('GPT-Live disconnected; reconnecting automatically…');
    expect(stopTrack).not.toHaveBeenCalled();

    await act(async () => { started = result.current.start(); });
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    act(() => FakeSocket.instance.emit({ method: 'nerve/realtime/ready', params: {} }));
    await waitFor(() => expect(FakeSocket.instance.sent).toHaveLength(1));
    act(() => FakeSocket.instance.emit({ method: 'thread/realtime/started', params: {} }));
    await expect(started).resolves.toBe(true);

    unmount();
    expect(stopTrack).toHaveBeenCalledTimes(1);
  });

  it('sends typed text through the active realtime thread', async () => {
    const { result, unmount } = renderHook(() => useCodexRealtimeVoice(vi.fn()));
    let started!: Promise<boolean>;
    await act(async () => { started = result.current.start(); });
    act(() => FakeSocket.instance.emit({ method: 'nerve/realtime/ready', params: {} }));
    await waitFor(() => expect(FakeSocket.instance.sent).toHaveLength(1));
    act(() => FakeSocket.instance.emit({ method: 'thread/realtime/started', params: {} }));
    await expect(started).resolves.toBe(true);

    act(() => result.current.sendText('Continuă aceeași conversație'));

    expect(FakeSocket.instance.sent.map((entry) => JSON.parse(entry))).toContainEqual(expect.objectContaining({
      method: 'thread/realtime/appendText',
      params: { role: 'user', text: 'Continuă aceeași conversație' },
    }));
    unmount();
  });

  it('presents and resolves a native Codex approval on the same socket', async () => {
    const approvals = vi.fn();
    const unsubscribe = subscribeCodexRealtimeApprovals(approvals);
    const { result, unmount } = renderHook(() => useCodexRealtimeVoice());
    let started!: Promise<boolean>;
    await act(async () => { started = result.current.start(); });
    act(() => FakeSocket.instance.emit({ method: 'nerve/realtime/ready', params: {} }));
    await waitFor(() => expect(FakeSocket.instance.sent).toHaveLength(1));
    act(() => FakeSocket.instance.emit({ method: 'thread/realtime/started', params: {} }));
    await expect(started).resolves.toBe(true);

    act(() => FakeSocket.instance.emit({
      id: 42,
      method: 'item/commandExecution/requestApproval',
      params: { command: 'git status', availableDecisions: ['accept', 'decline'] },
    }));
    expect(approvals).toHaveBeenCalledWith(expect.objectContaining({ id: 42 }));

    act(() => resolveCodexRealtimeApproval(42, 'accept'));
    expect(FakeSocket.instance.sent.map((entry) => JSON.parse(entry))).toContainEqual({
      id: 42,
      result: { decision: 'accept' },
    });
    expect(approvals).toHaveBeenLastCalledWith(null);
    unsubscribe();
    unmount();
  });
});
