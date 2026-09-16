import { describe, expect, it } from 'vitest';
import type { BackendModelInfo } from '../../shared/backend-config';
import {
  GPT_IMAGE_25_FLARE,
  GPT_IMAGE_25_SUNBURST,
  hasGptImage25Access,
  isGptImage25ModelId,
  resolveGptImage25ModelId,
} from '../../shared/image-generation';

function model(id: string, hasBudget = true): BackendModelInfo {
  return { id, name: id, provider: 'openai', hasBudget };
}

describe('image-generation helpers', () => {
  it('detects gpt-image-2.5 model ids', () => {
    expect(isGptImage25ModelId(GPT_IMAGE_25_FLARE)).toBe(true);
    expect(isGptImage25ModelId('gpt-image-2.5-sunburst-2026-09-08')).toBe(true);
    expect(isGptImage25ModelId('gpt-5.4')).toBe(false);
  });

  it('hasGptImage25Access respects budget flag', () => {
    expect(hasGptImage25Access([model(GPT_IMAGE_25_FLARE)])).toBe(true);
    expect(hasGptImage25Access([model(GPT_IMAGE_25_FLARE, false)])).toBe(false);
    expect(hasGptImage25Access([model('gpt-5.4')])).toBe(false);
  });

  it('resolveGptImage25ModelId prefers flare', () => {
    expect(
      resolveGptImage25ModelId([model(GPT_IMAGE_25_SUNBURST), model(GPT_IMAGE_25_FLARE)])
    ).toBe(GPT_IMAGE_25_FLARE);
  });

  it('resolveGptImage25ModelId falls back to sunburst or first grant', () => {
    expect(resolveGptImage25ModelId([model(GPT_IMAGE_25_SUNBURST)])).toBe(GPT_IMAGE_25_SUNBURST);
    expect(resolveGptImage25ModelId([model('gpt-image-2.5-custom')])).toBe('gpt-image-2.5-custom');
    expect(resolveGptImage25ModelId([])).toBeNull();
  });
});
