import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getYorkLlmModelContextWindow,
  listYorkLlmModels,
  resetYorkLlmModelsCacheForTests,
  resolveYorkLlmOneShotConfig,
  YORK_LLM_MODELS_TIMEOUT_MS,
} from '../../main/config/york-llm-api';
import type { AppConfig } from '../../main/config/config-store';

describe('york-llm-api', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    resetYorkLlmModelsCacheForTests();
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetYorkLlmModelsCacheForTests();
  });

  it('parses llama.cpp model list with context metadata', async () => {
    vi.stubEnv('YORK_LLM_API_KEY', 'test-york-llm-key');
    vi.mocked(global.fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          object: 'list',
          data: [
            {
              id: '/Users/dhavalj/models/Qwen3.6-35B-A3B/Qwen3.6-35B-A3B-UD-IQ2_M.gguf',
              meta: { n_ctx: 125184 },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    const models = await listYorkLlmModels();
    expect(models).toEqual([
      {
        id: '/Users/dhavalj/models/Qwen3.6-35B-A3B/Qwen3.6-35B-A3B-UD-IQ2_M.gguf',
        name: 'York LLM V1',
        contextWindow: 125184,
      },
    ]);
    expect(vi.mocked(global.fetch).mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer test-york-llm-key',
        }),
        signal: expect.any(AbortSignal),
      })
    );
    expect(YORK_LLM_MODELS_TIMEOUT_MS).toBe(180_000);
  });

  it('returns undefined when /models times out so chat can continue', async () => {
    vi.mocked(global.fetch).mockRejectedValueOnce(
      new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    );

    await expect(
      getYorkLlmModelContextWindow(
        '/Users/dhavalj/models/Qwen3.6-35B-A3B/Qwen3.6-35B-A3B-UD-IQ2_M.gguf'
      )
    ).resolves.toBeUndefined();
  });

  describe('resolveYorkLlmOneShotConfig', () => {
    const baseConfig = {
      provider: 'openai',
      customProtocol: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-openai',
      model: 'gpt-5.4',
    } as unknown as AppConfig;

    it('reuses the active York model without listing', async () => {
      const config = {
        ...baseConfig,
        provider: 'ollama',
        baseUrl: 'http://llm.yorkdevs.link:2222/v1',
        model: 'active-york.gguf',
      } as unknown as AppConfig;

      const resolved = await resolveYorkLlmOneShotConfig(config);
      expect(resolved).toMatchObject({
        provider: 'ollama',
        customProtocol: 'openai',
        model: 'active-york.gguf',
      });
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('falls back to the first listed York model when the active model is not York', async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ id: 'first.gguf' }, { id: 'second.gguf' }] }), {
          status: 200,
        })
      );

      const resolved = await resolveYorkLlmOneShotConfig(baseConfig);
      expect(resolved.provider).toBe('ollama');
      expect(resolved.model).toBe('first.gguf');
      expect(resolved.baseUrl).toContain('llm.yorkdevs.link');
      expect(resolved.apiKey).not.toBe('sk-openai');
    });

    it('throws when York LLM lists no models', async () => {
      vi.mocked(global.fetch)
        .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }));

      await expect(resolveYorkLlmOneShotConfig(baseConfig)).rejects.toThrow(
        'York LLM has no models available'
      );
    });
  });
});
