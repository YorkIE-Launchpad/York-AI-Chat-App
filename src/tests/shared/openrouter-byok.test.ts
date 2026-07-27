import { describe, expect, it } from 'vitest';
import type { BackendModelInfo } from '../../shared/backend-config';
import {
  filterModelsForOpenRouterKey,
  resolveYorkPaidEcoFallback,
} from '../../shared/openrouter-fallback';
import { isOpenRouterAccountLimitError } from '../../shared/openrouter-limit';
import {
  hasOpenRouterUserApiKey,
  withOpenRouterUserKeyHeader,
  YORK_OPENROUTER_USER_KEY_HEADER,
} from '../../shared/openrouter-user-key';

describe('openrouter user key helpers', () => {
  it('detects configured keys', () => {
    expect(hasOpenRouterUserApiKey('')).toBe(false);
    expect(hasOpenRouterUserApiKey('  ')).toBe(false);
    expect(hasOpenRouterUserApiKey('sk-or-v1-abc')).toBe(true);
  });

  it('attaches BYOK header without touching Authorization', () => {
    const model = withOpenRouterUserKeyHeader(
      { id: 'openrouter/free', headers: { 'X-Title': 'York' } as Record<string, string> },
      'sk-or-test'
    );
    expect(model.headers?.[YORK_OPENROUTER_USER_KEY_HEADER]).toBe('sk-or-test');
    expect(model.headers?.['X-Title']).toBe('York');
    expect(model.headers?.Authorization).toBeUndefined();
  });
});

describe('filterModelsForOpenRouterKey', () => {
  const catalog: BackendModelInfo[] = [
    { id: 'openrouter/free', name: 'Free', provider: 'openrouter' },
    { id: 'claude-haiku-4-5', name: 'Haiku', provider: 'anthropic' },
  ];

  it('keeps OpenRouter when key present', () => {
    expect(filterModelsForOpenRouterKey(catalog, 'sk-or').map((m) => m.provider)).toEqual([
      'openrouter',
      'anthropic',
    ]);
  });

  it('drops OpenRouter when key missing', () => {
    expect(filterModelsForOpenRouterKey(catalog, '').map((m) => m.provider)).toEqual(['anthropic']);
  });
});

describe('resolveYorkPaidEcoFallback', () => {
  it('never picks OpenRouter', () => {
    const catalog: BackendModelInfo[] = [
      { id: 'openrouter/free', name: 'Free', provider: 'openrouter' },
      { id: 'claude-haiku-4-5', name: 'Haiku', provider: 'anthropic' },
      { id: 'gpt-5.4-mini', name: 'Mini', provider: 'openai' },
    ];
    const pick = resolveYorkPaidEcoFallback({
      enabledModels: catalog,
      promptText: 'hi',
      preference: 'eco',
    });
    expect(pick).not.toBeNull();
    expect(pick!.provider).not.toBe('openrouter');
  });

  it('returns null when only OpenRouter models exist', () => {
    const pick = resolveYorkPaidEcoFallback({
      enabledModels: [{ id: 'openrouter/free', name: 'Free', provider: 'openrouter' }],
      promptText: 'hi',
    });
    expect(pick).toBeNull();
  });
});

describe('isOpenRouterAccountLimitError', () => {
  it('matches rate and credit errors only for OpenRouter', () => {
    expect(isOpenRouterAccountLimitError('openrouter', '429 rate limited')).toBe(true);
    expect(isOpenRouterAccountLimitError('openrouter', '402 more credits required')).toBe(true);
    expect(isOpenRouterAccountLimitError('anthropic', '429 rate limited')).toBe(false);
  });
});
