import { describe, expect, it, vi, beforeEach } from 'vitest';

const listYorkLlmModels = vi.fn();
const update = vi.fn();
const getAll = vi.fn();

vi.mock('../../main/config/york-llm-api', () => ({
  listYorkLlmModels: (...args: unknown[]) => listYorkLlmModels(...args),
}));

vi.mock('../../main/config/config-store', () => ({
  configStore: {
    getAll: () => getAll(),
    update: (...args: unknown[]) => update(...args),
  },
}));

vi.mock('../../main/utils/logger', () => ({
  log: vi.fn(),
  logWarn: vi.fn(),
}));

import { DEFAULT_YORK_LLM_BASE_URL, YORK_LLM_PROVIDER } from '../../shared/york-llm-config';

describe('bootstrapYorkLlmDefault', () => {
  beforeEach(() => {
    vi.resetModules();
    listYorkLlmModels.mockReset();
    update.mockReset();
    getAll.mockReset();
  });

  it('migrates openrouter/free to first York LLM model', async () => {
    getAll.mockReturnValue({
      provider: 'openrouter',
      model: 'openrouter/free',
    });
    listYorkLlmModels.mockResolvedValue([{ id: '/models/a.gguf', name: 'York LLM V1' }]);

    const { bootstrapYorkLlmDefault } =
      await import('../../main/config/york-llm-default-bootstrap');
    await bootstrapYorkLlmDefault();

    expect(listYorkLlmModels).toHaveBeenCalledWith({ forceRefresh: true });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: YORK_LLM_PROVIDER,
        baseUrl: DEFAULT_YORK_LLM_BASE_URL,
        model: '/models/a.gguf',
        isConfigured: true,
      })
    );
  });

  it('does not migrate intentional Auto picks', async () => {
    getAll.mockReturnValue({
      provider: 'anthropic',
      model: 'auto',
    });
    const { bootstrapYorkLlmDefault } =
      await import('../../main/config/york-llm-default-bootstrap');
    await bootstrapYorkLlmDefault();
    expect(listYorkLlmModels).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('fills an empty York selection with the first listed model', async () => {
    getAll.mockReturnValue({
      provider: YORK_LLM_PROVIDER,
      baseUrl: DEFAULT_YORK_LLM_BASE_URL,
      model: '',
    });
    listYorkLlmModels.mockResolvedValue([{ id: '/models/a.gguf', name: 'York LLM V1' }]);

    const { ensureConcreteYorkLlmModel } =
      await import('../../main/config/york-llm-default-bootstrap');
    await expect(ensureConcreteYorkLlmModel()).resolves.toBe(true);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: YORK_LLM_PROVIDER,
        model: '/models/a.gguf',
        isConfigured: true,
      })
    );
  });

  it('leaves a concrete York model and local Ollama alone', async () => {
    getAll.mockReturnValue({
      provider: YORK_LLM_PROVIDER,
      baseUrl: DEFAULT_YORK_LLM_BASE_URL,
      model: '/models/kept.gguf',
    });
    const { ensureConcreteYorkLlmModel } =
      await import('../../main/config/york-llm-default-bootstrap');
    await expect(ensureConcreteYorkLlmModel()).resolves.toBe(false);
    expect(listYorkLlmModels).not.toHaveBeenCalled();

    getAll.mockReturnValue({
      provider: YORK_LLM_PROVIDER,
      baseUrl: 'http://localhost:11434/v1',
      model: '',
    });
    await expect(ensureConcreteYorkLlmModel()).resolves.toBe(false);
    expect(update).not.toHaveBeenCalled();
  });

  it('does not migrate intentional Claude picks', async () => {
    getAll.mockReturnValue({
      provider: 'anthropic',
      model: 'claude-sonnet-5',
    });
    const { bootstrapYorkLlmDefault } =
      await import('../../main/config/york-llm-default-bootstrap');
    await bootstrapYorkLlmDefault();
    expect(listYorkLlmModels).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});
