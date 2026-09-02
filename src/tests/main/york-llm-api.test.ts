import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  listYorkLlmModels,
  resetYorkLlmModelsCacheForTests,
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
  });
});
