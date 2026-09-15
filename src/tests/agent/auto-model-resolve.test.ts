import { beforeEach, describe, expect, it, vi } from 'vitest';

const listYorkLlmModels = vi.fn();
const fetchBackendModels = vi.fn();
const getAll = vi.fn();

vi.mock('../../main/config/york-llm-api', () => ({
  listYorkLlmModels: (...args: unknown[]) => listYorkLlmModels(...args),
}));

vi.mock('../../main/config/backend-client', () => ({
  fetchBackendModels: (...args: unknown[]) => fetchBackendModels(...args),
}));

vi.mock('../../main/config/config-store', () => ({
  configStore: {
    getAll: () => getAll(),
  },
}));

vi.mock('../../main/utils/logger', () => ({
  log: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock('../../shared/backend-config', async () => {
  const actual = await vi.importActual<typeof import('../../shared/backend-config')>(
    '../../shared/backend-config'
  );
  return {
    ...actual,
    applyBackendManagedCredentials: (input: { provider: string }) => ({
      provider: input.provider,
      apiKey: 'proxy-key',
      baseUrl: `https://proxy.example/${input.provider}`,
    }),
    getBackendProxyBaseUrl: (provider: string) => `https://proxy.example/${provider}`,
  };
});

import { resolveAutoModelIfNeeded, formatAutoRouteLabel } from '../../main/agent/auto-model-resolve';
import { YORK_LLM_PROVIDER, DEFAULT_YORK_LLM_BASE_URL } from '../../shared/york-llm-config';

describe('resolveAutoModelIfNeeded York fast tier', () => {
  beforeEach(() => {
    listYorkLlmModels.mockReset();
    fetchBackendModels.mockReset();
    getAll.mockReset();
    getAll.mockReturnValue({ openRouterUserApiKey: '' });
  });

  it('prefers York LLM for low-complexity Auto prompts when available', async () => {
    listYorkLlmModels.mockResolvedValue([{ id: '/models/york.gguf', name: 'York LLM V1' }]);

    const result = await resolveAutoModelIfNeeded({
      model: 'auto',
      preference: 'balanced',
      promptText: 'summarize this meeting briefly',
    });

    expect(result.usedAuto).toBe(true);
    expect(result.provider).toBe(YORK_LLM_PROVIDER);
    expect(result.modelId).toBe('/models/york.gguf');
    expect(result.customProtocol).toBe('openai');
    expect(result.baseUrl).toBe(DEFAULT_YORK_LLM_BASE_URL);
    expect(result.pick?.tier).toBe('fast');
    expect(result.pick?.reason).toContain('york-llm');
    expect(formatAutoRouteLabel(result.pick!)).toBe('York LLM');
    expect(fetchBackendModels).not.toHaveBeenCalled();
  });

  it('uses prefetched York model id without listing', async () => {
    const result = await resolveAutoModelIfNeeded({
      model: 'auto',
      preference: 'eco',
      promptText: 'hi',
      yorkLlmModelId: '/models/prefetched.gguf',
    });

    expect(result.provider).toBe(YORK_LLM_PROVIDER);
    expect(result.modelId).toBe('/models/prefetched.gguf');
    expect(listYorkLlmModels).not.toHaveBeenCalled();
  });

  it('falls back to Hub catalog when York is unavailable', async () => {
    listYorkLlmModels.mockRejectedValue(new Error('offline'));
    fetchBackendModels.mockResolvedValue([
      { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', provider: 'anthropic' },
      { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', provider: 'anthropic' },
    ]);

    const result = await resolveAutoModelIfNeeded({
      model: 'auto',
      preference: 'balanced',
      promptText: 'thanks',
    });

    expect(result.usedAuto).toBe(true);
    expect(result.provider).toBe('anthropic');
    expect(result.modelId).toBe('claude-haiku-4-5');
    expect(result.pick?.tier).toBe('fast');
  });

  it('skips York for image prompts even when routine text score is low', async () => {
    fetchBackendModels.mockResolvedValue([
      { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', provider: 'anthropic' },
    ]);

    const result = await resolveAutoModelIfNeeded({
      model: 'auto',
      preference: 'balanced',
      promptText: 'what is this',
      hasImages: true,
    });

    expect(listYorkLlmModels).not.toHaveBeenCalled();
    expect(result.provider).toBe('anthropic');
    expect(result.modelId).toBe('claude-haiku-4-5');
  });

  it('does not route non-auto models', async () => {
    const result = await resolveAutoModelIfNeeded({
      model: 'claude-fable-5',
      promptText: 'hi',
    });
    expect(result.usedAuto).toBe(false);
    expect(listYorkLlmModels).not.toHaveBeenCalled();
  });
});
