import { afterEach, describe, expect, it } from 'vitest';
import {
  clearHubModelPricing,
  computeModelUsageCost,
  pricingKeysForModel,
  replaceHubModelPricing,
  resolveModelPricing,
} from '../../shared/model-pricing';

afterEach(() => {
  clearHubModelPricing();
});

describe('pricingKeysForModel', () => {
  it('maps direct provider ids to vendor-prefixed pricing keys', () => {
    expect(pricingKeysForModel('anthropic', 'claude-opus-4-8')[0]).toBe(
      'anthropic/claude-opus-4.8'
    );
    expect(pricingKeysForModel('anthropic', 'claude-haiku-4-5-20251001')[0]).toBe(
      'anthropic/claude-haiku-4.5'
    );
    expect(pricingKeysForModel('openai', 'gpt-5.6-luna')).toEqual(['openai/gpt-5.6-luna']);
    expect(pricingKeysForModel('gemini', 'gemini-3.7-flash')).toEqual(['google/gemini-3.7-flash']);
  });

  it('prices bare and vendor-prefixed ids identically for every vendor', () => {
    replaceHubModelPricing([
      {
        id: 'claude-fable-5',
        provider: 'anthropic',
        inputPrice: 10,
        outputPrice: 50,
        cacheReadPrice: 1,
        cacheWritePrice: 12.5,
      },
      {
        id: 'claude-haiku-4.5',
        provider: 'anthropic',
        inputPrice: 1,
        outputPrice: 5,
        cacheReadPrice: 0.1,
        cacheWritePrice: 1.25,
      },
      {
        id: 'claude-haiku-5.5',
        provider: 'anthropic',
        inputPrice: 0.1,
        outputPrice: 0.5,
      },
      {
        id: 'claude-sonnet-5.5',
        provider: 'anthropic',
        inputPrice: 2,
        outputPrice: 10,
      },
      {
        id: 'claude-opus-5-5',
        provider: 'anthropic',
        inputPrice: 4,
        outputPrice: 20,
      },
      {
        id: 'gpt-5.6-luna',
        provider: 'openai',
        inputPrice: 0.2,
        outputPrice: 1.2,
      },
      {
        id: 'gpt-image-2.5-flare',
        provider: 'openai',
        inputPrice: 5,
        outputPrice: 30,
      },
      {
        id: 'gemini-3.7-flash',
        provider: 'google',
        inputPrice: 0.75,
        outputPrice: 3.75,
      },
      {
        id: 'kimi-k3',
        provider: 'moonshotai',
        inputPrice: 3,
        outputPrice: 15,
      },
    ]);

    const pairs: Array<[string, string, string]> = [
      ['anthropic', 'claude-fable-5', 'anthropic/claude-fable-5'],
      ['anthropic', 'claude-haiku-4-5', 'anthropic/claude-haiku-4.5'],
      ['anthropic', 'claude-haiku-5-5', 'anthropic/claude-haiku-5.5'],
      ['anthropic', 'claude-sonnet-5-5', 'anthropic/claude-sonnet-5.5'],
      ['anthropic', 'claude-opus-5-5', 'anthropic/claude-opus-5-5'],
      ['openai', 'gpt-5.6-luna', 'openai/gpt-5.6-luna'],
      ['openai', 'gpt-image-2.5-flare-2026-09-08', 'openai/gpt-image-2.5-flare'],
      ['gemini', 'gemini-3.7-flash', 'google/gemini-3.7-flash'],
      ['gemini', 'gemini-3.7-flash', 'gemini/gemini-3.7-flash'],
      ['custom', 'kimi-k3', 'moonshotai/kimi-k3'],
    ];
    for (const [provider, bare, prefixed] of pairs) {
      const a = resolveModelPricing(provider, bare);
      expect(a, bare).not.toBeNull();
      expect(resolveModelPricing(provider, prefixed), prefixed).toEqual(a);
    }
  });
});

describe('resolveModelPricing', () => {
  it('uses the injected Hub catalog', () => {
    replaceHubModelPricing([
      {
        id: 'claude-opus-4.8',
        provider: 'anthropic',
        inputPrice: 5,
        outputPrice: 25,
        cacheReadPrice: 0.5,
        cacheWritePrice: 6.25,
      },
      {
        id: 'gpt-image-2.5-flare',
        provider: 'openai',
        inputPrice: 5,
        outputPrice: 30,
        cacheReadPrice: 1.25,
      },
    ]);

    expect(resolveModelPricing('anthropic', 'claude-opus-4-8')?.input).toBe(5);
    expect(resolveModelPricing('openai', 'gpt-image-2.5-flare')).toMatchObject({
      input: 5,
      output: 30,
      cacheRead: 1.25,
    });
    expect(resolveModelPricing('openai', 'gpt-image-2.5-flare-2026-09-08')?.input).toBe(5);
    expect(resolveModelPricing('openai', 'gpt-image-9')).toBeNull();
  });

  it('skips rows with no input or output rate', () => {
    replaceHubModelPricing([
      {
        id: 'free-model',
        provider: 'openai',
        inputPrice: null,
        outputPrice: null,
      },
    ]);
    expect(resolveModelPricing('openai', 'free-model')).toBeNull();
  });
});

describe('computeModelUsageCost', () => {
  it('bills image-input tokens at the input rate and treats null cache as 0', () => {
    const cost = computeModelUsageCost(
      { input: 5, output: 30 },
      { input: 500_000, imageInput: 1_000_000, output: 100_000, cacheRead: 1_000_000 }
    );
    // text 0.5M×$5 + image 1M×$5 + output 0.1M×$30 + cache 0
    expect(cost.input).toBeCloseTo(7.5);
    expect(cost.output).toBeCloseTo(3);
    expect(cost.cached).toBeCloseTo(0);
    expect(cost.total).toBeCloseTo(10.5);
  });
});
