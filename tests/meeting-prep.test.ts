import { beforeEach, describe, expect, it, vi } from 'vitest';

const runPiAiOneShotMock = vi.hoisted(() => vi.fn());
const fetchWebPageMock = vi.hoisted(() =>
  vi.fn(async () => 'HTTP 200\n\n<p>Acme builds rockets.</p>')
);

vi.mock('../src/main/agent/sdk-one-shot', () => ({
  runPiAiOneShot: runPiAiOneShotMock,
}));
vi.mock('../src/main/tools/web-fetch', () => ({
  fetchWebPage: fetchWebPageMock,
}));

import type { AppConfig } from '../src/main/config/config-store';
import type { MCPManager } from '../src/main/mcp/mcp-manager';
import { MEETING_PREP_MARKER, meetingPrepKind } from '../src/shared/matter';
import {
  cadenceFromRrule,
  classifyMeeting,
  detectRecurrence,
  isSameSeries,
  seriesIdFromEventId,
} from '../src/main/matter/meeting-prep/classify';
import {
  filterSeriesInstances,
  matchLocalSeriesMeetings,
  parseActionOwner,
  parseCalendarEvents,
} from '../src/main/matter/meeting-prep/series-history';
import { actionKeyPhrase } from '../src/main/matter/meeting-prep/verify-actions';
import {
  companyNameFromDomain,
  externalDomains,
  splitAttendees,
} from '../src/main/matter/meeting-prep/party-research';
import {
  parsePrepBrief,
  selectEvidenceForPrompt,
} from '../src/main/matter/meeting-prep/synthesize';
import { renderPrepBrief } from '../src/main/matter/meeting-prep/render';
import {
  EvidencePool,
  type PrepBrief,
  type SeriesHistory,
} from '../src/main/matter/meeting-prep/types';
import { runMeetingPrep, inviteDescription } from '../src/main/matter/meeting-prep';

describe('classifyMeeting', () => {
  it('treats RRULE invites as recurring with cadence', () => {
    const body =
      'evt1: Acme weekly (2026-09-28T10:00:00Z → 2026-09-28T10:30:00Z)\n\nRecurrence:\nRRULE:FREQ=WEEKLY;BYDAY=MO';
    const result = classifyMeeting({ inviteBody: body, eventId: 'evt1', pastSameTitleCount: 0 });
    expect(result.kind).toBe('recurring');
    expect(result.cadence).toBe('weekly');
    expect(result.reason).toBe('rrule');
  });

  it('uses RecurringEventId and instance-id suffixes', () => {
    expect(
      classifyMeeting({ inviteBody: 'RecurringEventId: abc123', pastSameTitleCount: 0 }).seriesId
    ).toBe('abc123');
    const fromId = detectRecurrence('', 'abc123_20260928T100000Z');
    expect(fromId.recurring).toBe(true);
    expect(fromId.seriesId).toBe('abc123');
  });

  it('falls back to repeated titles, otherwise one-off', () => {
    expect(classifyMeeting({ inviteBody: '', pastSameTitleCount: 2 }).kind).toBe('recurring');
    expect(classifyMeeting({ inviteBody: '', pastSameTitleCount: 1 }).kind).toBe('one_off');
  });

  it('maps RRULE frequencies to cadence labels', () => {
    expect(cadenceFromRrule('RRULE:FREQ=WEEKLY;INTERVAL=2')).toBe('biweekly');
    expect(cadenceFromRrule('RRULE:FREQ=MONTHLY')).toBe('monthly');
    expect(cadenceFromRrule(null)).toBeNull();
  });

  it('matches series instance ids by prefix', () => {
    expect(seriesIdFromEventId('abc_20260921')).toBe('abc');
    expect(seriesIdFromEventId('plainid')).toBeNull();
    expect(isSameSeries('abc_20260921T100000Z', 'abc')).toBe(true);
    expect(isSameSeries('abcd_20260921T100000Z', 'abc')).toBe(false);
  });
});

describe('series history matching', () => {
  const beforeMs = Date.parse('2026-09-28T10:00:00Z');

  it('keeps earlier instances of the same series, newest first', () => {
    const events = [
      { id: 'abc_20260914T100000Z', title: 'Acme weekly', start: '2026-09-14T10:00:00Z' },
      { id: 'abc_20260921T100000Z', title: 'Acme weekly', start: '2026-09-21T10:00:00Z' },
      { id: 'abc_20260928T100000Z', title: 'Acme weekly', start: '2026-09-28T10:00:00Z' },
      { id: 'zzz_20260920T100000Z', title: 'Acme weekly', start: '2026-09-20T10:00:00Z' },
    ];
    const out = filterSeriesInstances(events, {
      seriesId: 'abc',
      title: 'Acme weekly',
      currentEventId: 'abc_20260928T100000Z',
      beforeMs,
    });
    expect(out.map((e) => e.id)).toEqual(['abc_20260921T100000Z', 'abc_20260914T100000Z']);

    const byTitle = filterSeriesInstances(events, {
      seriesId: null,
      title: 'Acme Weekly',
      currentEventId: null,
      beforeMs,
    });
    expect(byTitle).toHaveLength(3);
  });

  it('matches local meetings by calendar id first, then title', () => {
    const meetings = [
      {
        id: 'm1',
        title: 'Zoom call',
        startedAt: Date.parse('2026-09-21T10:05:00Z'),
        calendarEventId: 'abc_20260921T100000Z',
      },
      {
        id: 'm2',
        title: 'Acme weekly',
        startedAt: Date.parse('2026-09-14T10:05:00Z'),
        calendarEventId: 'other_1',
      },
      { id: 'm3', title: 'Acme weekly', startedAt: Date.parse('2026-09-07T10:05:00Z') },
      { id: 'm4', title: 'Acme weekly', startedAt: Date.parse('2026-09-29T10:05:00Z') },
    ];
    const out = matchLocalSeriesMeetings(meetings, {
      seriesId: 'abc',
      title: 'Acme weekly',
      instanceDates: new Set(['2026-09-21']),
      beforeMs,
    });
    expect(out.map((m) => m.id)).toEqual(['m1', 'm3']);
  });

  it('parses structured search_events output', () => {
    const text = JSON.stringify({
      body: 'abc_1: Acme weekly (2026-09-21T10:00:00Z → 2026-09-21T10:30:00Z)',
      events: [
        {
          id: 'abc_1',
          title: 'Acme weekly',
          start: '2026-09-21T10:00:00Z',
          htmlLink: 'https://cal/1',
        },
      ],
    });
    expect(parseCalendarEvents(text)).toEqual([
      expect.objectContaining({ id: 'abc_1', htmlLink: 'https://cal/1' }),
    ]);
  });

  it('parses action owners and search phrases', () => {
    expect(parseActionOwner('Ada to send the pricing proposal').owner).toBe('Ada');
    expect(parseActionOwner('[Bob] confirm budget').owner).toBe('Bob');
    expect(parseActionOwner('Fix flaky e2e').owner).toBeUndefined();
    const phrase = actionKeyPhrase({ text: 'Ada to send the Q3 pricing proposal', owner: 'Ada' });
    expect(phrase).toContain('pricing');
    expect(phrase).not.toMatch(/\bAda\b/);
  });
});

describe('party research helpers', () => {
  it('splits attendees and extracts company domains', () => {
    const attendees = [
      { name: 'Me', email: 'me@york.ie' },
      { name: 'Ada', email: 'ada@york.ie' },
      { name: 'Wile', email: 'wile@acme-labs.co.uk' },
      { name: 'Road', email: 'road@gmail.com' },
    ];
    const { internal, external } = splitAttendees(attendees, 'me@york.ie');
    expect(internal.map((a) => a.email)).toEqual(['ada@york.ie']);
    expect(externalDomains(external)).toEqual(['acme-labs.co.uk']);
    expect(companyNameFromDomain('acme-labs.co.uk')).toBe('Acme Labs');
    expect(companyNameFromDomain('globex.com')).toBe('Globex');
  });
});

function sampleHistory(pool: EvidencePool): SeriesHistory {
  const origin = pool.add({
    source: 'meeting',
    title: 'Meeting notes: Acme weekly, 2026-09-21',
    excerpt: 'Action items: Ada to send proposal; Bob to confirm budget',
    tags: ['prior-meeting'],
  });
  return {
    seriesId: 'abc',
    cadence: 'weekly',
    pastInstances: [],
    lastHeld: '2026-09-21',
    actionItemsFrom: '2026-09-21',
    actionItems: [
      { text: 'Ada to send proposal', owner: 'Ada', originEvidenceId: origin, evidenceIds: [] },
      { text: 'Bob to confirm budget', owner: 'Bob', originEvidenceId: origin, evidenceIds: [] },
    ],
  };
}

describe('parsePrepBrief', () => {
  it('enforces citations and evidence-backed action statuses', () => {
    const pool = new EvidencePool();
    const invite = pool.add({
      source: 'calendar',
      title: 'Calendar invite: Acme weekly',
      excerpt: 'Weekly sync',
      tags: ['invite'],
    });
    const history = sampleHistory(pool);
    const slack = pool.add({
      source: 'slack',
      title: 'Slack #acme, 2026-09-24',
      excerpt: 'Ada: sent the proposal',
      url: 'https://slack/1',
    });
    const valid = new Set(pool.list().map((e) => e.id));
    const brief = parsePrepBrief(
      JSON.stringify({
        purpose: 'Acme delivery',
        bottomLine: 'Decide on budget.',
        whatChanged: [
          { text: 'Proposal went out', evidenceIds: [slack] },
          { text: 'Uncited rumour', evidenceIds: [] },
          { text: 'Hallucinated source', evidenceIds: ['E99'] },
        ],
        actionReview: [
          { index: 0, item: 'x', status: 'done', evidenceIds: [slack] },
          {
            index: 1,
            item: 'y',
            status: 'done',
            evidenceIds: [history.actionItems[1].originEvidenceId],
          },
        ],
        agenda: [
          { topic: 'Budget', why: 'Blocked', minutes: 15, evidenceIds: [invite] },
          { topic: 'Uncited', why: '', evidenceIds: [] },
        ],
        questionsToAsk: [],
        risks: [],
        peopleNotes: [],
      }),
      valid,
      history
    );
    expect(brief).not.toBeNull();
    expect(brief!.whatChanged).toEqual([{ text: 'Proposal went out', evidenceIds: [slack] }]);
    expect(brief!.agenda.map((a) => a.topic)).toEqual(['Budget']);
    expect(brief!.actionReview[0]).toMatchObject({ item: 'Ada to send proposal', status: 'done' });
    expect(brief!.actionReview[1]).toMatchObject({
      item: 'Bob to confirm budget',
      status: 'unknown',
      evidenceIds: [],
    });
  });

  it('fills missing action items and rejects briefs without an agenda', () => {
    const pool = new EvidencePool();
    const invite = pool.add({
      source: 'calendar',
      title: 'Invite',
      excerpt: 'x',
      tags: ['invite'],
    });
    const history = sampleHistory(pool);
    const valid = new Set(pool.list().map((e) => e.id));
    const brief = parsePrepBrief(
      JSON.stringify({
        bottomLine: 'ok',
        agenda: [{ topic: 'T', why: 'w', evidenceIds: [invite] }],
      }),
      valid,
      history
    );
    expect(brief!.actionReview.map((a) => a.status)).toEqual(['unknown', 'unknown']);
    expect(parsePrepBrief('{"bottomLine":"ok","agenda":[]}', valid, history)).toBeNull();
    expect(parsePrepBrief('not json', valid, history)).toBeNull();
  });

  it('prioritizes invite and action evidence under the prompt budget', () => {
    const pool = new EvidencePool();
    for (let i = 0; i < 5; i++)
      pool.add({ source: 'slack', title: `noise ${i}`, excerpt: 'x'.repeat(100) });
    pool.add({ source: 'slack', title: 'action hit', excerpt: 'done', tags: ['action:0'] });
    pool.add({ source: 'calendar', title: 'invite', excerpt: 'inv', tags: ['invite'] });
    const selected = selectEvidenceForPrompt(pool.list(), 2);
    expect(selected.map((e) => e.title)).toEqual(['invite', 'action hit']);
  });
});

describe('renderPrepBrief', () => {
  const ctx = {
    eventId: 'abc_1',
    title: 'Acme weekly',
    when: '2026-09-28T10:00:00Z → 2026-09-28T10:30:00Z',
    startIso: '2026-09-28T10:00:00.000Z',
    attendees: [],
    inviteBody: '',
    selfEmail: null,
  };

  it('numbers only cited sources, omits empty sections, labels unknown items', () => {
    const pool = new EvidencePool();
    const invite = pool.add({
      source: 'calendar',
      title: 'Calendar invite: Acme weekly',
      excerpt: 'x',
      url: 'https://cal/1',
      tags: ['invite'],
    });
    const slack = pool.add({
      source: 'slack',
      title: 'Slack #acme, 2026-09-24',
      excerpt: 'sent',
      url: 'https://slack/1',
    });
    pool.add({
      source: 'gmail',
      title: 'Email: never cited',
      excerpt: 'nope',
      url: 'https://mail/1',
    });
    const brief: PrepBrief = {
      purpose: 'Acme',
      bottomLine: 'Decide on budget.',
      whatChanged: [{ text: 'Proposal sent', evidenceIds: [slack] }],
      contextSoFar: [],
      actionReview: [
        { item: 'Ada to send proposal', owner: 'Ada', status: 'done', evidenceIds: [slack] },
        { item: 'Bob to confirm budget', owner: 'Bob', status: 'unknown', evidenceIds: [] },
      ],
      agenda: [
        { topic: 'Budget', why: 'Blocked on approval', minutes: 15, evidenceIds: [invite, slack] },
      ],
      questionsToAsk: [],
      risks: [],
      peopleNotes: [],
    };
    const note = renderPrepBrief({
      ctx,
      kind: 'recurring',
      cadence: 'weekly',
      lastHeld: '2026-09-21',
      actionItemsFrom: '2026-09-21',
      brief,
      evidence: pool.list(),
      connectors: [
        { id: 'slack', label: 'Slack', status: 'checked' },
        { id: 'jira', label: 'Jira', status: 'skipped', reason: 'disconnected' },
      ],
    });
    expect(note.startsWith(MEETING_PREP_MARKER)).toBe(true);
    expect(note).toContain('Recurring (weekly) · last held 2026-09-21');
    expect(note).toContain('- Proposal sent [1]');
    expect(note).toContain('**Done:** Ada to send proposal (Ada) [1]');
    expect(note).toContain('**No update found:** Bob to confirm budget (Bob)');
    expect(note).toContain('1. **Budget** (15 min) - Blocked on approval [2][1]');
    expect(note).toContain('1. [Slack #acme, 2026-09-24](https://slack/1)');
    expect(note).toContain('2. [Calendar invite: Acme weekly](https://cal/1)');
    expect(note).not.toContain('never cited');
    expect(note).not.toContain('### Questions to ask');
    expect(note).not.toContain('### Risks');
    expect(note).toContain('Not connected: Jira');
    expect(note.indexOf('**Sources**')).toBeGreaterThan(note.indexOf('### Agenda'));
    expect(meetingPrepKind(note)).toBe('recurring');
  });
});

function fakeMcp(): MCPManager {
  return {
    getTools: () => [],
    getServerStatus: () => [],
    callTool: async () => '',
  } as unknown as MCPManager;
}

describe('runMeetingPrep', () => {
  beforeEach(() => {
    runPiAiOneShotMock.mockReset();
  });

  it('strips connector metadata from the invite description', () => {
    expect(
      inviteDescription(
        'evt: Kickoff (2026-09-28T10:00:00Z → 2026-09-28T11:00:00Z)\n\nAttendees: a@b.com\n\nAgenda: scope and timeline'
      )
    ).toBe('Agenda: scope and timeline');
  });

  it('falls back to a deterministic brief when synthesis is malformed', async () => {
    runPiAiOneShotMock.mockResolvedValue({ text: 'sorry, cannot help' });
    const result = await runMeetingPrep({
      mcpManager: fakeMcp(),
      meetingService: null,
      config: {} as AppConfig,
      originalTitle: 'Globex kickoff',
      when: '2026-09-29T10:00:00Z → 2026-09-29T11:00:00Z',
      attendees: [{ name: 'Ada', email: 'ada@york.ie' }],
      inviteBody: 'Agenda: scope and timeline',
    });
    expect(result.kind).toBe('one_off');
    expect(result.usedFallback).toBe(true);
    expect(result.prepNote.startsWith(MEETING_PREP_MARKER)).toBe(true);
    expect(result.prepNote).toContain('One-off');
    expect(result.prepNote).toContain('### Agenda');
    expect(result.prepNote).toContain('Calendar invite: Globex kickoff');
  });

  it('renders the synthesized brief when the model returns valid JSON', async () => {
    runPiAiOneShotMock.mockResolvedValue({
      text: JSON.stringify({
        purpose: 'Globex kickoff',
        bottomLine: 'Agree scope and first milestone.',
        agenda: [
          { topic: 'Scope', why: 'Needed before staffing', minutes: 20, evidenceIds: ['E1'] },
        ],
        contextSoFar: [],
        peopleNotes: [],
        questionsToAsk: [{ text: 'Who signs off?', evidenceIds: ['E1'] }],
        risks: [],
        whatChanged: [],
        actionReview: [],
      }),
    });
    const result = await runMeetingPrep({
      mcpManager: fakeMcp(),
      meetingService: null,
      config: {} as AppConfig,
      originalTitle: 'Globex kickoff',
      when: '2026-09-29T10:00:00Z → 2026-09-29T11:00:00Z',
      attendees: [],
      inviteBody: 'RecurringEventId: series1\n\nAgenda: scope',
    });
    expect(result.kind).toBe('recurring');
    expect(result.usedFallback).toBe(false);
    expect(result.prepNote).toContain('**Bottom line:** Agree scope and first milestone.');
    expect(result.prepNote).toContain('1. **Scope** (20 min) - Needed before staffing [1]');
    expect(result.suggestedAction).toContain('Lead with: Scope');
  });
});
