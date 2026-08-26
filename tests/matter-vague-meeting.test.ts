import { describe, expect, it } from 'vitest';
import { calendarOrbitSeverity } from '../src/shared/matter-time';
import {
  MEETING_PREP_MARKER,
  buildEnrichedMeetingTitle,
  buildMeetingPrepNote,
  cleanSlackPrepText,
  extractBrowseUrls,
  formatPriorMeetingHit,
  isMeetingPrepNote,
  isVagueMeetingTitle,
  parseEventAttendees,
  parseSlackHistoryBody,
  parseSlackSearchBody,
  preserveMeetingPrepRawDetails,
  scoreChannelName,
  summarizeHubEmployee,
  summarizeHubLeaveCalendar,
  titleSearchTokens,
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
          label: 'DM · Ada',
          detail: 'Can we follow up on pricing before the call?',
          url: 'https://slack.com/archives/D1/p1',
        },
        {
          source: 'channel',
          label: '#acme-eng',
          detail: 'Need owner for Q3 deck',
        },
        {
          source: 'gmail',
          label: 'Re: Acme Q3 roadmap',
          detail: 'Attached latest deck — please review action items',
          url: 'https://mail.google.com/mail/u/0/#all/abc',
        },
        formatPriorMeetingHit({
          id: 'm1',
          title: 'Acme sync',
          startedAt: Date.parse('2026-08-01T15:00:00Z'),
          notes: {
            summary: 'Aligned on pricing',
            keyTopics: ['pricing', 'timeline'],
            actionItems: ['Ada to send proposal', 'Bob to confirm budget'],
          },
        }),
      ],
    });
    expect(note.startsWith(MEETING_PREP_MARKER)).toBe(true);
    expect(note).toContain('**Meeting:** Meeting');
    expect(note).toContain('Ada Lovelace <ada@york.ie>');
    expect(note).toMatch(/\*\*Meeting:\*\*[^\n]+\n\n\*\*When:\*\*/);
    expect(note).not.toContain('### Invite notes');
    expect(note).toContain('### Recent Slack (DMs / people)');
    expect(note).toContain('DM · Ada');
    expect(note).toContain('### Mutual / project channels');
    expect(note).toContain('#acme-eng');
    expect(note).toContain('### Email');
    expect(note).toContain('Re: Acme Q3 roadmap');
    expect(note).toContain('### Prior Zoom meetings');
    expect(note).toContain('Action items: Ada to send proposal');
    expect(note).toContain('### Open loops / action items');
    expect(note).toMatch(/Ada to send proposal/);
    expect(note).toContain('### Suggested agenda');
    expect(note).toContain('### Connectors');
    expect(note).toContain('### Sources');
  });

  it('strips Slack mention IDs from prep text', () => {
    expect(cleanSlackPrepText('nileshs: <@U076ER71DB4>, thanks')).toBe(
      'nileshs: @someone, thanks'
    );
    expect(cleanSlackPrepText('<@U076ER71DB4|Kalrav> hi')).toBe('@Kalrav hi');
    const note = buildMeetingPrepNote({
      originalTitle: 'Sync',
      when: 'Wed',
      attendees: [],
      enrichedTitle: 'Sync',
      hits: [
        {
          source: 'slack',
          label: '#eng · Ada',
          detail: 'ping <@U076ER71DB4> about the blocker',
        },
      ],
    });
    expect(note).not.toMatch(/U076ER71DB4/);
    expect(note).toContain('@someone');
  });
});

describe('parseSlackSearchBody / parseSlackHistoryBody (prep)', () => {
  it('parses id|name search lines used by Slack MCP', () => {
    const parsed = parseSlackSearchBody(
      'C012ABCDEF|#eng [1700000000.000100] Ada: please follow up on the blocker\nLink: https://slack.com/archives/C012ABCDEF/p1700000000000100'
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0].channel).toBe('C012ABCDEF');
    expect(parsed[0].channelLabel).toBe('eng');
    expect(parsed[0].user).toBe('Ada');
    expect(parsed[0].text).toContain('follow up');
    expect(parsed[0].link).toContain('slack.com');
  });

  it('parses history/thread [ts] user: text lines', () => {
    const parsed = parseSlackHistoryBody(
      [
        '[1700000000.000100] Ada: need a decision by Friday',
        'Link: https://slack.com/archives/C1/p1',
        '[1700000001.000200] Bob: will send the deck',
      ].join('\n'),
      4
    );
    expect(parsed).toHaveLength(2);
    expect(parsed[0].user).toBe('Ada');
    expect(parsed[0].link).toContain('slack.com');
    expect(parsed[1].text).toContain('will send');
  });
});

describe('formatPriorMeetingHit + channel scoring', () => {
  it('surfaces action items and topics in the hit detail', () => {
    const hit = formatPriorMeetingHit({
      id: 'abc',
      title: 'Launchpad QA',
      startedAt: Date.parse('2026-08-20T12:00:00Z'),
      notes: {
        summary: 'Walked through flaky tests',
        keyTopics: ['CI', 'flake'],
        actionItems: ['Fix flaky e2e', 'Retest tomorrow'],
      },
    });
    expect(hit.source).toBe('meeting');
    expect(hit.label).toContain('Launchpad QA');
    expect(hit.detail).toContain('Action items: Fix flaky e2e');
    expect(hit.detail).toContain('Topics: CI; flake');
  });

  it('scores channels with title and project tokens', () => {
    const attendees = [{ name: 'Ada', email: 'ada@york.ie' }];
    expect(scoreChannelName('general', attendees, ['acme'])).toBe(0);
    expect(scoreChannelName('acme-delivery', attendees, ['acme', 'delivery'])).toBeGreaterThan(
      scoreChannelName('random-chat', attendees, ['acme'])
    );
    expect(titleSearchTokens('Acme Launchpad QA sync')).toEqual(
      expect.arrayContaining(['acme', 'launchpad'])
    );
  });
});

describe('preserveMeetingPrepRawDetails + extractBrowseUrls', () => {
  it('keeps prep note when scan would overwrite with invite payload', () => {
    const prep = `${MEETING_PREP_MARKER}\n\n**Meeting:** Sync`;
    expect(isMeetingPrepNote(prep)).toBe(true);
    expect(preserveMeetingPrepRawDetails(prep, '{"title":"Sync"}')).toBe(prep);
    expect(preserveMeetingPrepRawDetails(prep, `${MEETING_PREP_MARKER}\nnew`)).toBe(
      `${MEETING_PREP_MARKER}\nnew`
    );
    expect(preserveMeetingPrepRawDetails('invite', 'new invite')).toBe('new invite');
  });

  it('extracts external browse URLs and skips meet/zoom/google', () => {
    const urls = extractBrowseUrls(
      [
        'See https://acme.example.com/deck',
        'Join https://meet.google.com/abc-defg-hij',
        'Zoom https://zoom.us/j/123',
        'Also https://docs.client.io/plan',
      ].join('\n')
    );
    expect(urls).toEqual(['https://acme.example.com/deck', 'https://docs.client.io/plan']);
  });
});

describe('calendarOrbitSeverity', () => {
  it('maps soon / today / week', () => {
    const now = Date.now();
    expect(calendarOrbitSeverity(now + 30 * 60 * 1000).orbit).toBe('now');
    expect(calendarOrbitSeverity(now + 30 * 60 * 1000).severity).toBe('critical');
    expect(calendarOrbitSeverity(now + 5 * 60 * 60 * 1000).orbit).toBe('today');
    expect(calendarOrbitSeverity(now + 3 * 24 * 60 * 60 * 1000).orbit).toBe('week');
  });
});

describe('summarizeHubLeaveCalendar / summarizeHubEmployee', () => {
  it('formats leave JSON instead of dumping braces', () => {
    const payload = JSON.stringify({
      body: JSON.stringify({
        success: true,
        data: {
          leaves: [
            {
              employee_name: 'Irfan',
              employee_email: 'irfan@york.ie',
              leaveType: 'PRIVILEGE',
              startDate: '2026-08-26',
              endDate: '2026-08-26',
              status: 'APPROVED',
            },
            {
              employee_name: 'Kalrav',
              employee_email: 'kalrav@york.ie',
              leaveType: 'SICK',
              startDate: '2026-08-27',
              endDate: '2026-08-28',
              status: 'APPROVED',
            },
          ],
        },
      }),
    });
    const summary = summarizeHubLeaveCalendar(payload, ['irfan@york.ie']);
    expect(summary).toContain('Irfan');
    expect(summary).toContain('PRIVILEGE');
    expect(summary).not.toContain('"leaves"');
    expect(summary).not.toMatch(/^\s*\{/);
  });

  it('formats employee JSON into name · title · squad', () => {
    const payload = JSON.stringify({
      body: {
        success: true,
        data: {
          employees: [
            {
              email: 'kalrav@york.ie',
              name: 'Kalrav Parsana',
              title: 'Engineer',
              squad: 'Platform',
            },
          ],
        },
      },
    });
    const summary = summarizeHubEmployee(payload, 'kalrav@york.ie');
    expect(summary).toBe('Kalrav Parsana · Engineer · Platform');
    expect(summary).not.toContain('{');
  });
});
