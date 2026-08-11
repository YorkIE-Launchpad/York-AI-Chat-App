import { describe, expect, it } from 'vitest';
import {
  MEETING_PREP_MARKER,
  buildEnrichedMeetingTitle,
  buildMeetingPrepNote,
  isVagueMeetingTitle,
  parseEventAttendees,
} from '../src/main/matter/matter-calendar-enrichment';

describe('isVagueMeetingTitle', () => {
  it('flags generic-only titles', () => {
    for (const title of [
      'Sync',
      'catch up',
      'Meeting',
      'Zoom meeting',
      'Chat',
      '1:1',
      'one on one',
      'Quick sync',
      'Check-in',
      'Huddle',
      'Touch base',
      'Follow up',
      'Team sync',
      'Chat with me',
    ]) {
      expect(isVagueMeetingTitle(title), title).toBe(true);
    }
  });

  it('keeps specific titles', () => {
    for (const title of [
      '1:1 with Ada',
      'Sync — Launchpad QA',
      'Catch up on Acme pricing',
      'Sprint planning',
      'Unblock checkout',
      'Customer kickoff',
    ]) {
      expect(isVagueMeetingTitle(title), title).toBe(false);
    }
  });

  it('treats empty / tiny titles as vague', () => {
    expect(isVagueMeetingTitle('')).toBe(true);
    expect(isVagueMeetingTitle('  ')).toBe(true);
    expect(isVagueMeetingTitle('ab')).toBe(true);
  });
});

describe('parseEventAttendees', () => {
  it('parses Attendees line with names and emails', () => {
    const body = [
      'evt1: Sync (2026-08-11T14:00:00Z → 2026-08-11T14:30:00Z)',
      'Attendees: Ada Lovelace <ada@york.ie>, bob@client.com, Carol',
    ].join('\n\n');
    const attendees = parseEventAttendees(body);
    expect(attendees).toEqual([
      { name: 'Ada Lovelace', email: 'ada@york.ie' },
      { name: 'bob', email: 'bob@client.com' },
      { name: 'Carol', email: '' },
    ]);
  });
});

describe('buildEnrichedMeetingTitle + buildMeetingPrepNote', () => {
  const attendees = [
    { name: 'Ada Lovelace', email: 'ada@york.ie' },
    { name: 'Bob Smith', email: 'bob@client.com' },
    { name: 'Carol', email: 'carol@york.ie' },
  ];

  it('titles from attendees and topic', () => {
    expect(
      buildEnrichedMeetingTitle({
        originalTitle: 'Sync',
        attendees,
        topicHint: 'Acme pricing',
      })
    ).toBe('Sync w/ Ada, Bob +1 — Acme pricing');
  });

  it('titles from attendees only', () => {
    expect(
      buildEnrichedMeetingTitle({
        originalTitle: 'Catch up',
        attendees: attendees.slice(0, 1),
      })
    ).toBe('Catch-up w/ Ada');
  });

  it('falls back to original when no people or topic', () => {
    expect(
      buildEnrichedMeetingTitle({
        originalTitle: 'Sync',
        attendees: [],
      })
    ).toBe('Sync');
  });

  it('builds prep note with marker and sections', () => {
    const enrichedTitle = buildEnrichedMeetingTitle({
      originalTitle: 'Meeting',
      attendees: attendees.slice(0, 2),
      topicHint: 'Q3 roadmap',
    });
    const note = buildMeetingPrepNote({
      originalTitle: 'Meeting',
      when: '2026-08-11T15:00:00Z → 2026-08-11T15:30:00Z',
      attendees: attendees.slice(0, 2),
      enrichedTitle,
      hits: [
        {
          source: 'slack',
          label: '#acme · Ada',
          detail: 'Can we align on pricing before the call?',
          url: 'https://slack.com/archives/C1/p1',
        },
        {
          source: 'gmail',
          label: 'Re: Acme Q3 roadmap',
          detail: 'Attached latest deck',
          url: 'https://mail.google.com/mail/u/0/#all/abc',
        },
      ],
    });
    expect(note.startsWith(MEETING_PREP_MARKER)).toBe(true);
    expect(note).toContain('**Original invite:** Meeting');
    expect(note).toContain('Ada Lovelace <ada@york.ie>');
    expect(note).toContain('### Recent Slack');
    expect(note).toContain('#acme · Ada');
    expect(note).toContain('### Email');
    expect(note).toContain('Re: Acme Q3 roadmap');
    expect(note).toContain('### Sources');
  });
});
