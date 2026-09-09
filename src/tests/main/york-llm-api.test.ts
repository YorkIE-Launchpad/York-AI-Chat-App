import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getYorkLlmModelContextWindow,
  listYorkLlmModels,
  resetYorkLlmModelsCacheForTests,
  YORK_LLM_MODELS_TIMEOUT_MS,
} from '../../main/config/york-llm-api';

describe('york-llm-api', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    resetYorkLlmModelsCacheForTests();
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
    resetYorkLlmModelsCacheForTests();
  });

  it('parses llama.cpp model list with context metadata', async () => {
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
});
