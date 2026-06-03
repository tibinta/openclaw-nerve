import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

const { mockUseGateway, mockUseSessionContext } = vi.hoisted(() => ({
  mockUseGateway: vi.fn(),
  mockUseSessionContext: vi.fn(),
}));

vi.mock('@/contexts/GatewayContext', () => ({
  useGateway: () => mockUseGateway(),
}));

vi.mock('@/contexts/SessionContext', () => ({
  useSessionContext: () => mockUseSessionContext(),
}));

import { buildModelCatalogUiError, buildSelectableModelList, type GatewayModelInfo, useModelEffort } from './useModelEffort';

const CONFIGURED_MODELS: GatewayModelInfo[] = [
  { id: 'zai/glm-4.7', label: 'glm-4.7', provider: 'zai' },
  { id: 'ollama/qwen2.5:7b-instruct-q5_K_M', label: 'qwen-local', provider: 'ollama' },
];

function jsonResponse(data: unknown, init: { ok?: boolean; status?: number } = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => data,
  };
}

describe('buildSelectableModelList', () => {
  it('returns configured models unchanged when available', () => {
    expect(buildSelectableModelList(CONFIGURED_MODELS, null)).toEqual(CONFIGURED_MODELS);
  });

  it('returns no fake fallback models when configured catalog is empty', () => {
    expect(buildSelectableModelList([], null)).toEqual([]);
  });

  it('appends the current active model when it is missing from the configured catalog', () => {
    expect(buildSelectableModelList(CONFIGURED_MODELS, 'openrouter/xiaomi/mimo-v2-pro')).toEqual([
      ...CONFIGURED_MODELS,
      { id: 'openrouter/xiaomi/mimo-v2-pro', label: 'xiaomi/mimo-v2-pro', provider: 'openrouter' },
    ]);
  });

  it('does not append a phantom model when a configured option already has the same base name', () => {
    const models: GatewayModelInfo[] = [
      { id: 'openai/gpt-5.4', label: 'gpt-5.4', provider: 'openai' },
    ];

    expect(buildSelectableModelList(models, 'openai-codex/gpt-5.4')).toEqual(models);
  });
});

describe('useModelEffort', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    localStorage.clear();
    vi.clearAllMocks();

    mockUseGateway.mockReturnValue({
      rpc: vi.fn(),
      connectionState: 'connected',
      model: 'zai/glm-4.7',
      thinking: 'medium',
    });

    mockUseSessionContext.mockReturnValue({
      currentSession: 'agent:main:subagent:preview-run',
      sessions: [
        { key: 'agent:main:main', model: 'zai/glm-4.7' },
        { key: 'agent:main:subagent:preview-run', model: 'openrouter/xiaomi/mimo-v2-pro' },
      ],
      updateSession: vi.fn(),
    });

    globalThis.fetch = vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url === '/api/gateway/models') {
        return Promise.resolve(jsonResponse({ models: CONFIGURED_MODELS, error: null }));
      }
      if (url.startsWith('/api/gateway/session-info?sessionKey=')) {
        return Promise.resolve(jsonResponse({}));
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('keeps the current session model visible when the gateway context model belongs to a different session', async () => {
    const { result } = renderHook(() => useModelEffort());

    await waitFor(() => {
      expect(result.current.selectedModel).toBe('openrouter/xiaomi/mimo-v2-pro');
    });

    await waitFor(() => {
      expect(result.current.modelOptions.map((option) => option.value)).toContain('openrouter/xiaomi/mimo-v2-pro');
    });

    expect(result.current.modelOptions).toEqual([
      { value: 'zai/glm-4.7', label: 'glm-4.7' },
      { value: 'ollama/qwen2.5:7b-instruct-q5_K_M', label: 'qwen-local' },
      { value: 'openrouter/xiaomi/mimo-v2-pro', label: 'xiaomi/mimo-v2-pro' },
    ]);
  });

  it('does not call session-info when no session is selected', async () => {
    mockUseSessionContext.mockReturnValue({
      currentSession: '',
      sessions: [],
      updateSession: vi.fn(),
    });

    const { result } = renderHook(() => useModelEffort());

    await waitFor(() => {
      expect(result.current.selectedModel).toBe('zai/glm-4.7');
    });

    const fetchMock = globalThis.fetch as unknown as { mock: { calls: unknown[][] } };
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/api/gateway/models'))).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/api/gateway/session-info'))).toBe(false);
  });

  it('sends effort off as an explicit thinking level instead of null', async () => {
    const rpc = vi.fn().mockResolvedValue({});
    const updateSession = vi.fn();
    const sessionKey = 'agent:main:main';

    mockUseGateway.mockReturnValue({
      rpc,
      connectionState: 'connected',
      model: 'zai/glm-4.7',
      thinking: 'medium',
    });

    mockUseSessionContext.mockReturnValue({
      currentSession: sessionKey,
      sessions: [
        { key: sessionKey, model: 'zai/glm-4.7', thinkingLevel: 'medium' },
      ],
      updateSession,
    });

    const { result } = renderHook(() => useModelEffort());

    await act(async () => {
      await result.current.handleEffortChange('off');
    });

    expect(rpc).toHaveBeenCalledWith('sessions.patch', expect.objectContaining({
      key: sessionKey,
      thinkingLevel: 'off',
    }));
    expect(rpc).not.toHaveBeenCalledWith('sessions.patch', expect.objectContaining({
      thinkingLevel: null,
    }));
    expect(updateSession).toHaveBeenCalledWith(sessionKey, expect.objectContaining({
      thinkingLevel: 'off',
    }));
  });

  it('turns fast replies on by setting fastMode and effort off together', async () => {
    const rpc = vi.fn().mockResolvedValue({});
    const updateSession = vi.fn();
    const sessionKey = 'agent:jane:direct';

    mockUseGateway.mockReturnValue({
      rpc,
      connectionState: 'connected',
      model: 'zai/glm-4.7',
      thinking: 'medium',
    });

    mockUseSessionContext.mockReturnValue({
      currentSession: sessionKey,
      sessions: [
        { key: sessionKey, model: 'zai/glm-4.7', thinkingLevel: 'medium' },
      ],
      updateSession,
    });

    const { result } = renderHook(() => useModelEffort());

    await act(async () => {
      await result.current.handleFastReplyModeChange(true);
    });

    expect(result.current.fastReplyMode).toBe(true);
    expect(result.current.selectedEffort).toBe('off');
    expect(localStorage.getItem(`oc-fast-reply-${sessionKey}`)).toBe('true');
    expect(rpc).toHaveBeenCalledWith('sessions.patch', expect.objectContaining({
      key: sessionKey,
      fastMode: true,
      thinkingLevel: 'off',
    }));
    expect(updateSession).toHaveBeenCalledWith(sessionKey, expect.objectContaining({
      fastMode: true,
      thinkingLevel: 'off',
    }));
  });
});

describe('buildModelCatalogUiError', () => {
  it('returns the backend error when the configured catalog is empty', () => {
    expect(buildModelCatalogUiError([], 'Could not load configured models')).toBe('Could not load configured models');
  });

  it('suppresses the backend error when configured models exist', () => {
    expect(buildModelCatalogUiError(CONFIGURED_MODELS, 'Could not load configured models')).toBeNull();
  });
});
