import { describe, expect, it, vi } from 'vitest';
import {
  extractMeetingLoops,
  judgeMatterCandidates,
  matterDeadline,
  omitDuplicateLoopCandidates,
  prescreenAction,
  selectMatterLoopCandidates,
} from '../../main/loops/loop-extractor';
import type { MeetingSession } from '../../main/meetings/meeting-types';
import { DEFAULT_LOOPS_RUNTIME } from '../../shared/loops';
import type { MatterItem } from '../../shared/matter';

const now = Date.UTC(2026, 8, 29, 10);

describe('prescreenAction', () => {
  it.each([
    'Clarify ownership of tasks offered for handoff during the meeting',
    'Ensure new resources go through the standard onboarding process',
    'Align with the PM on enforcing the established onboarding/offboarding process',
    'Clarify which issue was raised and who will fix it',
    'Confirm what is scheduled for 1 October',
    'Follow up',
  ])('rejects vague item: %s', (text) => {
    expect(prescreenAction(text)).not.toBeNull();
  });

  it.each([
    'Request/grant Git access for Prateek Gwala',
    'Send the Q4 pricing sheet to Priya',
    'Fix the login redirect bug on staging',
  ])('passes concrete item: %s', (text) => {
    expect(prescreenAction(text)).toBeNull();
  });
});

describe('extractMeetingLoops', () => {
  const meeting = {
    id: 'm1',
    title: 'Zoom Meeting',
    startedAt: now,
    attendees: [],
    notes: {
      actionItems: [
        'Clarify which issue was raised and who will fix it',
        'Request/grant Git access for Prateek Gwala',
        'Review access provisioning steps (repo vs. Git) in the onboarding checklist',
      ],
    },
  } as unknown as MeetingSession;

  const noJev = vi.fn().mockResolvedValue(null);

  it('uses Jev to keep items with a specific output and context, LLM only for fields', async () => {
    const jev = vi.fn().mockResolvedValue([
      { keep: true, output: 0.9, context: 0.85, involves: 0.8, owner: 'me' },
      { keep: false, output: 0.3, context: 0.4, involves: 0.6, owner: 'me' },
    ]);
    const complete = vi.fn().mockResolvedValue({
      text: JSON.stringify({
        items: [{ index: 0, owner: 'me', counterpart: 'Prateek Gwala', due: null }],
      }),
    });
    const loops = await extractMeetingLoops(meeting, null, {
      jev,
      llm: { complete, embed: vi.fn() },
    });

    const jevInput = jev.mock.calls[0][0] as { candidates: Array<{ text: string }> };
    expect(jevInput.candidates.map((c) => c.text)).not.toContain(
      'Clarify which issue was raised and who will fix it'
    );
    const fieldsPrompt = JSON.parse(complete.mock.calls[0][0].userPrompt) as {
      items: Array<{ text: string }>;
    };
    expect(fieldsPrompt.items.map((i) => i.text)).toEqual([
      'Request/grant Git access for Prateek Gwala',
    ]);
    expect(loops).toMatchObject([
      { title: 'Request/grant Git access for Prateek Gwala', counterpart: 'Prateek Gwala' },
    ]);
  });

  it('does not call the LLM when Jev rejects everything', async () => {
    const jev = vi.fn().mockResolvedValue([
      { keep: false, output: 0.2, context: 0.2, involves: 0.2, owner: 'me' },
      { keep: false, output: 0.2, context: 0.2, involves: 0.2, owner: 'me' },
    ]);
    const complete = vi.fn();
    const loops = await extractMeetingLoops(meeting, null, {
      jev,
      llm: { complete, embed: vi.fn() },
    });
    expect(loops).toEqual([]);
    expect(complete).not.toHaveBeenCalled();
  });

  it('falls back to the strict LLM screen without Jev', async () => {
    const complete = vi.fn().mockResolvedValue({
      text: JSON.stringify({
        items: [
          { index: 0, keep: true, owner: 'me', counterpart: 'Prateek Gwala', due: null },
          { index: 1, keep: false, owner: 'me', counterpart: null, due: null },
        ],
      }),
    });
    const loops = await extractMeetingLoops(meeting, null, {
      jev: noJev,
      llm: { complete, embed: vi.fn() },
    });
    expect(loops.map((l) => l.title)).toEqual(['Request/grant Git access for Prateek Gwala']);
  });

  it('captures nothing when both judges fail', async () => {
    const complete = vi.fn().mockRejectedValue(new Error('offline'));
    expect(
      await extractMeetingLoops(meeting, null, { jev: noJev, llm: { complete, embed: vi.fn() } })
    ).toEqual([]);
  });
});

describe('selectMatterLoopCandidates', () => {
  const base = {
    status: 'active',
    source: 'slack',
    severity: 'warning',
    orbit: 'today',
    confidence: 0.9,
    title: 'Send signed SOW to Acme legal',
    suggestedAction: 'Reply to Dana with the signed SOW',
  } as unknown as MatterItem;

  it('keeps concrete, confident, actionable signals', () => {
    expect(selectMatterLoopCandidates([base], DEFAULT_LOOPS_RUNTIME)).toHaveLength(1);
  });

  it('skips meeting-sourced signals and generic suggestions', () => {
    const meetingItem = { ...base, source: 'meeting' } as MatterItem;
    const generic = {
      ...base,
      suggestedAction: 'Complete, delegate, or dismiss this action.',
    } as MatterItem;
    expect(selectMatterLoopCandidates([meetingItem, generic], DEFAULT_LOOPS_RUNTIME)).toEqual([]);
  });
});

describe('judgeMatterCandidates', () => {
  const item = {
    title: 'Send signed SOW to Acme legal',
    suggestedAction: 'Reply',
    summary: '',
  } as unknown as MatterItem;

  it('drops what Jev rejects', async () => {
    const jev = vi
      .fn()
      .mockResolvedValue([{ keep: false, output: 0.2, context: 0.9, involves: 0.9, owner: 'me' }]);
    expect(await judgeMatterCandidates([item], null, { jev })).toEqual([]);
  });

  it('falls back to the strict LLM screen when Jev is unavailable', async () => {
    const jev = vi.fn().mockResolvedValue(null);
    const complete = vi.fn().mockResolvedValue({
      text: JSON.stringify({
        items: [{ index: 0, keep: true, owner: 'me', counterpart: null, due: null }],
      }),
    });
    expect(
      await judgeMatterCandidates([item], null, { jev, llm: { complete, embed: vi.fn() } })
    ).toEqual([item]);
  });

  it('captures nothing when Jev is unavailable and the LLM screen fails', async () => {
    const jev = vi.fn().mockResolvedValue(null);
    const complete = vi.fn().mockRejectedValue(new Error('offline'));
    expect(
      await judgeMatterCandidates([item], null, { jev, llm: { complete, embed: vi.fn() } })
    ).toEqual([]);
  });
});

describe('omitDuplicateLoopCandidates', () => {
  it('keeps one loop when the same ask is worded differently', () => {
    const kept = omitDuplicateLoopCandidates([
      {
        title: 'Please review the Q3 deck before Friday',
        notes: 'Q3 deck review needed by Friday',
      },
      {
        title: 'Q3 deck needs your review by Friday',
        notes: 'Please review the Q3 deck before Friday',
      },
      { title: 'Send standup notes from this morning', notes: 'standup notes from this morning' },
    ]);
    expect(kept.map((item) => item.title)).toEqual([
      'Please review the Q3 deck before Friday',
      'Send standup notes from this morning',
    ]);
  });

  it('drops a new loop that paraphrases one already captured', () => {
    const kept = omitDuplicateLoopCandidates(
      [
        {
          title: 'Q3 deck needs your review by Friday',
          notes: 'Please review the Q3 deck before Friday',
        },
      ],
      [
        {
          title: 'Please review the Q3 deck before Friday',
          notes: 'Q3 deck review needed by Friday',
        },
      ]
    );
    expect(kept).toEqual([]);
  });
});

describe('matterDeadline', () => {
  it('ignores past dueAt (Matter falls back to the signal timestamp)', () => {
    expect(matterDeadline({ dueAt: now - 3_600_000 } as MatterItem, now)).toBeNull();
  });

  it('keeps future deadlines', () => {
    expect(matterDeadline({ dueAt: now + 86_400_000 } as MatterItem, now)).toBe(now + 86_400_000);
  });

  it('handles missing dueAt', () => {
    expect(matterDeadline({ dueAt: null } as MatterItem, now)).toBeNull();
  });
});
