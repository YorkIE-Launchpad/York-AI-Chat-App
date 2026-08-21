import { describe, expect, it } from 'vitest';
import type { Api, Model } from '@mariozechner/pi-ai';
import {
  applyOpenRouterClaudeCacheHints,
  enableLongAnthropicPromptCache,
} from '../../main/agent/prompt-cache';

function makeModel(overrides: Partial<Model<Api>> = {}): Model<Api> {
  return {
    id: 'claude-sonnet-4-6',
    name: 'claude-sonnet-4-6',
    api: 'openai-completions',
    provider: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    reasoning: false,
    input: ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 16384,
    ...overrides,
  } as Model<Api>;
}

describe('prompt-cache helpers', () => {
  it('sets PI_CACHE_RETENTION=long unless explicitly none', () => {
    const prev = process.env.PI_CACHE_RETENTION;
    delete process.env.PI_CACHE_RETENTION;
    enableLongAnthropicPromptCache();
    expect(process.env.PI_CACHE_RETENTION).toBe('long');

    process.env.PI_CACHE_RETENTION = 'none';
    enableLongAnthropicPromptCache();
    expect(process.env.PI_CACHE_RETENTION).toBe('none');

    if (prev === undefined) delete process.env.PI_CACHE_RETENTION;
    else process.env.PI_CACHE_RETENTION = prev;
  });

  it('prefixes bare Claude ids and adds OpenRouter session affinity headers', () => {
    const next = applyOpenRouterClaudeCacheHints(makeModel(), 'sess-123');
    expect(next.id).toBe('anthropic/claude-sonnet-4-6');
    expect(next.provider).toBe('openrouter');
    expect(next.headers?.['x-session-id']).toBe('sess-123');
  });

  it('leaves non-OpenRouter models unchanged', () => {
    const model = makeModel({
      provider: 'anthropic',
      api: 'anthropic-messages',
      baseUrl: 'https://api.anthropic.com',
      id: 'claude-sonnet-4-6',
    });
    const next = applyOpenRouterClaudeCacheHints(model, 'sess-123');
    expect(next).toBe(model);
  });
});
