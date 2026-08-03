import { describe, expect, it } from 'vitest';
import { looksLikeJunkTitle } from '../src/main/matter/matter-collector';
import { repairMatterRankerJson } from '../src/main/matter/matter-ranker';

describe('looksLikeJunkTitle', () => {
  it('flags Launchpad JSON path fragments', () => {
    expect(looksLikeJunkTitle('"path": [')).toBe(true);
    expect(looksLikeJunkTitle('"path":[')).toBe(true);
    expect(looksLikeJunkTitle('path: {')).toBe(true);
    expect(looksLikeJunkTitle('"expected":')).toBe(true);
  });

  it('keeps human titles', () => {
    expect(looksLikeJunkTitle('Release 2.4 blocked on QA')).toBe(false);
    expect(looksLikeJunkTitle('1:1 with Ada')).toBe(false);
  });
});

describe('repairMatterRankerJson', () => {
  it('converts word rankScore values to numbers', () => {
    const repaired = repairMatterRankerJson(
      '{"pulse":"ok","items":[{"fingerprint":"a","rankScore": sixty,"confidence": high}]}'
    );
    const parsed = JSON.parse(repaired) as {
      items: Array<{ rankScore: number; confidence: number }>;
    };
    expect(parsed.items[0].rankScore).toBe(60);
    // unknown word "high" → safe default 0.5 for confidence
    expect(parsed.items[0].confidence).toBe(0.5);
  });

  it('coerces quoted numeric strings', () => {
    const repaired = repairMatterRankerJson('{"rankScore": "75", "confidence": "0.8"}');
    const parsed = JSON.parse(repaired) as { rankScore: number; confidence: number };
    expect(parsed.rankScore).toBe(75);
    expect(parsed.confidence).toBe(0.8);
  });
});
