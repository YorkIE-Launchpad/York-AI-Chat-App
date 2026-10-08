import { describe, expect, it } from 'vitest';
import { normalizeMatterRuntimeConfig } from '../../main/matter/matter-config';
import { meetsMatterConfidence } from '../../shared/matter';

describe('meetsMatterConfidence', () => {
  it('passes everything when the threshold is off', () => {
    expect(meetsMatterConfidence({ confidence: 0.1, pinned: false }, 0)).toBe(true);
  });

  it('keeps signals at or above the threshold and drops the rest', () => {
    expect(meetsMatterConfidence({ confidence: 0.7, pinned: false }, 0.7)).toBe(true);
    expect(meetsMatterConfidence({ confidence: 0.69, pinned: false }, 0.7)).toBe(false);
  });

  it('always keeps pinned signals', () => {
    expect(meetsMatterConfidence({ confidence: 0.2, pinned: true }, 0.9)).toBe(true);
  });
});

describe('normalizeMatterRuntimeConfig minConfidence', () => {
  it('defaults to 0 when missing or invalid', () => {
    expect(normalizeMatterRuntimeConfig({}).minConfidence).toBe(0);
    expect(normalizeMatterRuntimeConfig({ minConfidence: 'high' }).minConfidence).toBe(0);
    expect(normalizeMatterRuntimeConfig({ minConfidence: Number.NaN }).minConfidence).toBe(0);
  });

  it('clamps to 0–1 and rounds to two decimals', () => {
    expect(normalizeMatterRuntimeConfig({ minConfidence: 1.4 }).minConfidence).toBe(1);
    expect(normalizeMatterRuntimeConfig({ minConfidence: -0.2 }).minConfidence).toBe(0);
    expect(normalizeMatterRuntimeConfig({ minConfidence: 0.6500001 }).minConfidence).toBe(0.65);
  });
});
