import { describe, expect, it } from 'vitest';
import { pricingKeysForModel, resolveModelPricing } from '../../shared/model-pricing';

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
  it('uses the bundled snapshot', () => {
    expect(resolveModelPricing('anthropic', 'claude-opus-4-8')?.input).toBe(5);
    expect(resolveModelPricing('anthropic', 'claude-haiku-5-5')).toMatchObject({
      input: 0.1,
      output: 0.5,
      longContext: { minPromptTokens: 100000, input: 0.5, output: 2.5 },
    });
    expect(resolveModelPricing('openai', 'gpt-image-2.5-flare')).toMatchObject({
      input: 5,
      imageInput: 8,
      output: 30,
    });
    expect(resolveModelPricing('openai', 'gpt-image-2.5-flare-2026-09-08')?.imageInput).toBe(8);
    expect(resolveModelPricing('openai', 'gpt-image-9')).toBeNull();
  });
});
