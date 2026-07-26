import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackendModelInfo } from '../../shared/backend-config';
import {
  OPENROUTER_FREE_ROUTER_ID,
  clearFreeModelCatalogCache,
  pickFreeOpenRouterModel,
  resolveFreeModelForChild,
} from '../../main/agent/free-model-resolve';

vi.mock('../../main/config/backend-client', () => ({
  fetchBackendModels: vi.fn(async () => [] as BackendModelInfo[]),
}));

vi.mock('../../main/agent/auto-model-resolve', async () => {
  const actual = await vi.importActual<typeof import('../../main/agent/auto-model-resolve')>(
    '../../main/agent/auto-model-resolve'
  );
  return {
    ...actual,
    resolveAutoModelIfNeeded: vi.fn(async (input: { model?: string; preference?: string }) => {
      if ((input.model || '').toLowerCase() !== 'auto') {
        return {
          usedAuto: false,
          modelId: input.model || '',
          provider: 'anthropic',
          customProtocol: 'anthropic',
          baseUrl: '',
          apiKey: '',
          pick: null,
        };
      }
      return {
        usedAuto: true,
        modelId: 'claude-haiku-4-5',
        provider: 'anthropic',
        customProtocol: 'anthropic',
        baseUrl: 'http://127.0.0.1:3001/anthropic',
        apiKey: 'sk-york-ie-local-proxy',
        pick: {
          provider: 'anthropic',
          modelId: 'claude-haiku-4-5',
          tier: 'fast',
          score: 0,
          reason: 'test',
        },
      };
    }),
  };
});

describe('pickFreeOpenRouterModel', () => {
  it('prefers openrouter/free when present', () => {
    const catalog: BackendModelInfo[] = [
      { id: 'meta-llama/llama-3.2-3b-instruct:free', name: 'Llama', provider: 'openrouter' },
      { id: OPENROUTER_FREE_ROUTER_ID, name: 'Free', provider: 'openrouter' },
      { id: 'claude-sonnet-5', name: 'Sonnet', provider: 'anthropic' },
    ];
    const pick = pickFreeOpenRouterModel(catalog);
    expect(pick?.model.id).toBe(OPENROUTER_FREE_ROUTER_ID);
    expect(pick?.strategy).toBe('openrouter-free');
  });

  it('falls back to first :free variant', () => {
    const catalog: BackendModelInfo[] = [
      { id: 'qwen/qwen3-coder:free', name: 'Qwen', provider: 'openrouter' },
      { id: 'claude-sonnet-5', name: 'Sonnet', provider: 'anthropic' },
    ];
    const pick = pickFreeOpenRouterModel(catalog);
    expect(pick?.model.id).toBe('qwen/qwen3-coder:free');
    expect(pick?.strategy).toBe('openrouter-free-variant');
  });

  it('returns null when no free OpenRouter models exist', () => {
    const catalog: BackendModelInfo[] = [
      { id: 'claude-sonnet-5', name: 'Sonnet', provider: 'anthropic' },
      { id: 'anthropic/claude-sonnet-5', name: 'OR Sonnet', provider: 'openrouter' },
    ];
    expect(pickFreeOpenRouterModel(catalog)).toBeNull();
  });
});

describe('resolveFreeModelForChild', () => {
  beforeEach(() => {
    clearFreeModelCatalogCache();
  });

  it('resolves openrouter/free from catalog', async () => {
    const result = await resolveFreeModelForChild({
      promptText: 'list leave requests',
      enabledModels: [
        { id: OPENROUTER_FREE_ROUTER_ID, name: 'Free', provider: 'openrouter' },
        { id: 'claude-sonnet-5', name: 'Sonnet', provider: 'anthropic' },
      ],
    });
    expect(result.strategy).toBe('openrouter-free');
    expect(result.provider).toBe('openrouter');
    expect(result.modelId).toBe(OPENROUTER_FREE_ROUTER_ID);
    expect(result.customProtocol).toBe('openai');
    expect(result.baseUrl).toContain('/openrouter');
  });

  it('falls back to eco Auto when no free models', async () => {
    const result = await resolveFreeModelForChild({
      promptText: 'hi',
      enabledModels: [{ id: 'claude-haiku-4-5', name: 'Haiku', provider: 'anthropic' }],
      parent: { model: 'auto', autoModelPreference: 'balanced' },
    });
    expect(result.strategy).toBe('eco-auto');
    expect(result.modelId).toBe('claude-haiku-4-5');
    expect(result.provider).toBe('anthropic');
  });
});
