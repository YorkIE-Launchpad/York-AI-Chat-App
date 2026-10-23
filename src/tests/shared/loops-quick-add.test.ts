import { describe, expect, it } from 'vitest';
import {
  formatDueFollowUpDigest,
  isFollowUpMorningWindow,
  loopDueBucket,
  normalizeLoopsRuntimeConfig,
  parseLoopQuickAdd,
  parseLoopQuickAddDraft,
  type Loop,
} from '../../shared/loops';

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

describe('parseLoopQuickAddDraft', () => {
  it('keeps a single line as the title with no notes', () => {
    const draft = parseLoopQuickAddDraft('send deck to Raj fri', NOW);
    expect(draft.title).toBe('send deck to Raj');
    expect(draft.notes).toBeNull();
    expect(ymd(draft.dueAt)).toBe('2026-10-2');
  });

  it('keeps following lines as markdown notes, preserving list structure', () => {
    const draft = parseLoopQuickAddDraft(
      '\nPrep Acme review tomorrow\n\n- pricing sheet\n  - enterprise tier\n1. send recap\n2. book follow-up\n\n',
      NOW
    );
    expect(draft.title).toBe('Prep Acme review');
    expect(ymd(draft.dueAt)).toBe('2026-10-1');
    expect(draft.notes).toBe(
      '- pricing sheet\n  - enterprise tier\n1. send recap\n2. book follow-up'
    );
  });

  it('returns an empty title for blank input', () => {
    expect(parseLoopQuickAddDraft('  \n \n', NOW)).toEqual({ title: '', notes: null, dueAt: null });
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
      morningSlackDigestEnabled: true,
      morningDigestSentDay: '',
    });
    expect(
      normalizeLoopsRuntimeConfig({ captureFromMatter: false, matterConfidenceThreshold: 4 })
    ).toEqual({
      captureFromMeetings: true,
      captureFromMatter: false,
      matterConfidenceThreshold: 1,
      screenedVersion: 0,
      capturePrompt: '',
      morningSlackDigestEnabled: true,
      morningDigestSentDay: '',
    });
    expect(
      normalizeLoopsRuntimeConfig({ capturePrompt: '  only my commitments  ' }).capturePrompt
    ).toBe('only my commitments');
    expect(
      normalizeLoopsRuntimeConfig({ morningSlackDigestEnabled: false }).morningSlackDigestEnabled
    ).toBe(false);
    expect(
      normalizeLoopsRuntimeConfig({ morningDigestSentDay: '2026-10-16' }).morningDigestSentDay
    ).toBe('2026-10-16');
    expect(
      normalizeLoopsRuntimeConfig({ morningDigestSentDay: 'yesterday' }).morningDigestSentDay
    ).toBe('');
  });
});

function loop(partial: Partial<Loop>): Loop {
  return {
    id: partial.id || 'loop',
    fingerprint: 'fp',
    title: partial.title || 'Follow up',
    notes: null,
    researchNote: null,
    researchSources: [],
    researchStatus: 'idle',
    researchError: null,
    researchedAt: null,
    origin: 'manual',
    sourceRef: {},
    owner: 'me',
    counterpart: null,
    projectName: null,
    dueAt: null,
    priority: 'normal',
    status: 'open',
    autoCaptured: false,
    createdAt: NOW,
    updatedAt: NOW,
    closedAt: null,
    ...partial,
  };
}

describe('morning follow-up digest', () => {
  const morning = new Date(2026, 9, 16, 8, 30, 0, 0).getTime();

  it('is open from 8:05 through 11:00 local', () => {
    expect(isFollowUpMorningWindow(new Date(2026, 9, 16, 8, 4).getTime())).toBe(false);
    expect(isFollowUpMorningWindow(new Date(2026, 9, 16, 8, 5).getTime())).toBe(true);
    expect(isFollowUpMorningWindow(new Date(2026, 9, 16, 11, 0).getTime())).toBe(true);
    expect(isFollowUpMorningWindow(new Date(2026, 9, 16, 11, 1).getTime())).toBe(false);
  });

  it('lists only follow-ups I own that are overdue or due today', () => {
    const digest = formatDueFollowUpDigest(
      [
        loop({ id: 'later', title: 'Next month', dueAt: morning + 20 * 24 * 60 * 60 * 1000 }),
        loop({ id: 'wait', title: 'Waiting', owner: 'other', dueAt: morning - 86_400_000 }),
        loop({ id: 'today', title: 'Send the deck', counterpart: 'Ava', dueAt: morning + 60_000 }),
        loop({ id: 'over', title: 'Review the PR', dueAt: morning - 86_400_000 }),
        loop({ id: 'done', title: 'Closed', status: 'done', dueAt: morning - 86_400_000 }),
      ],
      morning
    );
    expect(digest).toEqual({
      title: 'Due follow-ups',
      day: '2026-10-16',
      body: ['2 follow-ups', '• Review the PR (overdue)', '• Send the deck · Ava (due today)'].join(
        '\n'
      ),
    });
  });

  it('returns null when nothing is due', () => {
    expect(formatDueFollowUpDigest([loop({ title: 'Someday' })], morning)).toBeNull();
  });
});
