import { describe, expect, it } from 'vitest';
import { loopDueBucket, normalizeLoopsRuntimeConfig, parseLoopQuickAdd } from '../../shared/loops';

// Wednesday, 2026-09-30 10:00 local
const NOW = new Date(2026, 8, 30, 10, 0, 0, 0).getTime();

function ymd(ms: number | null): string | null {
  if (ms == null) return null;
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

describe('parseLoopQuickAdd', () => {
  it('leaves plain text without a due date', () => {
    expect(parseLoopQuickAdd('  review the deck  ', NOW)).toEqual({
      title: 'review the deck',
      dueAt: null,
    });
  });

  it('parses tomorrow and today', () => {
    expect(ymd(parseLoopQuickAdd('call Raj tomorrow', NOW).dueAt)).toBe('2026-10-1');
    const today = parseLoopQuickAdd('ship notes by today', NOW);
    expect(today.title).toBe('ship notes');
    expect(ymd(today.dueAt)).toBe('2026-9-30');
  });

  it('parses a weekday as the next occurrence', () => {
    const fri = parseLoopQuickAdd('send deck to Raj fri', NOW);
    expect(fri.title).toBe('send deck to Raj');
    expect(ymd(fri.dueAt)).toBe('2026-10-2');
    expect(ymd(parseLoopQuickAdd('sync on wednesday', NOW).dueAt)).toBe('2026-10-7');
  });

  it('parses m/d and rolls past dates into next year', () => {
    expect(ymd(parseLoopQuickAdd('renew licence 10/15', NOW).dueAt)).toBe('2026-10-15');
    expect(ymd(parseLoopQuickAdd('tax filing 3/1', NOW).dueAt)).toBe('2027-3-1');
  });
});

describe('loopDueBucket', () => {
  it('buckets by day boundaries', () => {
    const day = 24 * 60 * 60 * 1000;
    expect(loopDueBucket(null, NOW)).toBe('later');
    expect(loopDueBucket(NOW - day, NOW)).toBe('overdue');
    expect(loopDueBucket(NOW + 60_000, NOW)).toBe('today');
    expect(loopDueBucket(NOW + 3 * day, NOW)).toBe('week');
    expect(loopDueBucket(NOW + 10 * day, NOW)).toBe('later');
  });
});

describe('normalizeLoopsRuntimeConfig', () => {
  it('defaults on and clamps the threshold', () => {
    expect(normalizeLoopsRuntimeConfig(undefined)).toEqual({
      captureFromMeetings: true,
      captureFromMatter: true,
      matterConfidenceThreshold: 0.7,
      screenedVersion: 0,
      capturePrompt: '',
    });
    expect(
      normalizeLoopsRuntimeConfig({ captureFromMatter: false, matterConfidenceThreshold: 4 })
    ).toEqual({
      captureFromMeetings: true,
      captureFromMatter: false,
      matterConfidenceThreshold: 1,
      screenedVersion: 0,
      capturePrompt: '',
    });
    expect(
      normalizeLoopsRuntimeConfig({ capturePrompt: '  only my commitments  ' }).capturePrompt
    ).toBe('only my commitments');
  });
});
