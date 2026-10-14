import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackendModelInfo } from '../../shared/backend-config';
import {
  clearFreeModelCatalogCache,
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

describe('resolveFreeModelForChild', () => {
  beforeEach(() => {
    clearFreeModelCatalogCache();
  });

  it('resolves via eco Auto', async () => {
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
