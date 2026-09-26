import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ensureModelPricingFresh,
  parseOpenRouterModelPricing,
  pricingKeysForModel,
  resetModelPricingCache,
  resolveModelPricing,
} from '../../shared/model-pricing';

describe('pricingKeysForModel', () => {
  it('maps direct provider ids to OpenRouter ids', () => {
    expect(pricingKeysForModel('anthropic', 'claude-opus-4-8')[0]).toBe('anthropic/claude-opus-4.8');
    expect(pricingKeysForModel('anthropic', 'claude-haiku-4-5-20251001')[0]).toBe(
      'anthropic/claude-haiku-4.5'
    );
    expect(pricingKeysForModel('openai', 'gpt-5.6-luna')).toEqual(['openai/gpt-5.6-luna']);
    expect(pricingKeysForModel('gemini', 'gemini-3.7-flash')).toEqual(['google/gemini-3.7-flash']);
    expect(pricingKeysForModel('openrouter', 'anthropic/claude-opus-4-8')).toContain(
      'anthropic/claude-opus-4.8'
    );
  });
});

describe('parseOpenRouterModelPricing', () => {
  it('converts per-token strings to per-million and reads long-context overrides', () => {
    const map = parseOpenRouterModelPricing({
      data: [
        {
          id: 'openai/gpt-9',
          pricing: {
            prompt: '0.000002',
            completion: '0.00001',
            input_cache_read: '0.0000002',
            overrides: [{ min_prompt_tokens: 272000, prompt: '0.000004', completion: '0.000015' }],
          },
        },
        { id: 'broken', pricing: {} },
      ],
    });
    expect(map.size).toBe(1);
    expect(map.get('openai/gpt-9')).toEqual({
      input: 2,
      output: 10,
      cacheRead: 0.2,
      longContext: { minPromptTokens: 272000, input: 4, output: 15, cacheRead: 0.2 },
    });
  });
});

describe('ensureModelPricingFresh', () => {
  afterEach(() => resetModelPricingCache());

  it('uses live prices over the snapshot and never throws on failure', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: [{ id: 'anthropic/claude-opus-4.8', pricing: { prompt: '0.00001', completion: '0.0001' } }],
      }),
    })) as unknown as typeof fetch;
    await ensureModelPricingFresh({ fetchFn });
    expect(resolveModelPricing('anthropic', 'claude-opus-4-8')?.input).toBe(10);

    const failing = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    await expect(ensureModelPricingFresh({ fetchFn: failing, force: true })).resolves.toBeUndefined();
    expect(resolveModelPricing('anthropic', 'claude-opus-4-8')?.input).toBe(10);
  });

  it('falls back to the bundled snapshot', () => {
    expect(resolveModelPricing('anthropic', 'claude-opus-4-8')?.input).toBe(5);
    expect(resolveModelPricing('openai', 'gpt-image-2.5-flare')).toMatchObject({
      input: 5,
      imageInput: 8,
      output: 30,
    });
    expect(resolveModelPricing('openai', 'gpt-image-2.5-flare-2026-09-08')?.imageInput).toBe(8);
    expect(resolveModelPricing('openai', 'gpt-image-9')).toBeNull();
  });
});
