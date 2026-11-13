import { describe, expect, it } from 'vitest';
import {
  collectMatterSignals,
  extractHubInboxRecords,
  hubAwarenessRecordIsFresh,
  hubKudosIsForUser,
  hubKudosRecipientEmail,
  hubRecordNewestTimestampMs,
  resolveHubServerId,
  type HubInboxRecord,
  type RawMatterSignal,
} from '../src/main/matter/matter-collector';
import { heuristicRank, selectSignalsForRanker } from '../src/main/matter/matter-ranker';
import type { MCPManager } from '../src/main/mcp/mcp-manager';
import { DEFAULT_HUB_MCP_NAME, DEFAULT_HUB_MCP_SERVER_ID } from '../src/shared/mcp-defaults';
import type { MatterSourcesConfig } from '../src/shared/matter';

const HUB_ONLY: MatterSourcesConfig = {
  calendar: false,
  slack: false,
  gmail: false,
  jira: false,
  hub: true,
  meeting: false,
  launchpad: false,
};

function envelopeResult(body: unknown) {
  return {
    content: [{ type: 'text', text: JSON.stringify({ body }) }],
  };
}

function hubEnvelope(data: unknown) {
  return envelopeResult({ success: true, data, statusCode: 200, message: 'OK' });
}

function mockHubMcp(
  handlers: Record<string, (args: Record<string, unknown>) => unknown>,
  options?: { serverId?: string; connected?: boolean; name?: string }
): {
  mcp: MCPManager;
  calls: Array<{ name: string; args: Record<string, unknown> }>;
} {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const toolNames = Object.keys(handlers);
  const serverId = options?.serverId ?? DEFAULT_HUB_MCP_SERVER_ID;
  const connected = options?.connected ?? true;
  const mcp = {
    getServerStatus: () => [
      {
        id: serverId,
        name: options?.name ?? DEFAULT_HUB_MCP_NAME,
        connected,
        status: connected ? 'connected' : 'disabled',
        toolCount: toolNames.length,
      },
    ],
    getTools: () =>
      toolNames.map((originalName) => ({
        name: `mcp__Hub__${originalName}`,
        originalName,
        serverId,
        serverName: options?.name ?? DEFAULT_HUB_MCP_NAME,
      })),
    callTool: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      const original = name.includes('__') ? name.split('__').pop() || name : name;
      const handler = handlers[original];
      if (!handler) return envelopeResult('');
      return handler(args);
    },
  } as unknown as MCPManager;
  return { mcp, calls };
}

describe('extractHubInboxRecords', () => {
  it('parses JSON notification objects and marks read items', () => {
    const records = extractHubInboxRecords(
      JSON.stringify({
        notifications: [
          { id: 'n1', title: 'Kudos received', message: 'Jay sent you kudos', unread: true },
          { id: 'n2', title: 'Old ping', message: 'already seen', isRead: true },
        ],
      })
    );
    expect(records.find((r) => r.id === 'n1')?.unread).toBe(true);
    expect(records.find((r) => r.id === 'n2')?.unread).toBe(false);
  });

  it('unwraps Hub { success, data } envelopes without treating message OK as a record', () => {
    const records = extractHubInboxRecords(
      JSON.stringify({
        success: true,
        statusCode: 200,
        message: 'OK',
        data: [
          { id: 'k-1', message: 'Great collab', sender_name: 'Jay' },
          { id: 'a-1', title: 'Office closed Friday', description: 'WFH' },
        ],
      })
    );
    expect(records.some((r) => /OK/i.test(r.title) && r.id == null)).toBe(false);
    expect(records.find((r) => r.id === 'k-1')?.title).toMatch(/Jay sent kudos/i);
    expect(records.find((r) => r.id === 'a-1')?.title).toMatch(/Office closed/i);
  });

  it('synthesizes titles for leave rows without a title field', () => {
    const records = extractHubInboxRecords(
      JSON.stringify({
        success: true,
        data: [
          {
            id: '4821',
            employee_name: 'Ada',
            leaveType: 'PRIVILEGE',
            status: 'PENDING',
          },
        ],
      })
    );
    expect(records).toHaveLength(1);
    expect(records[0]?.id).toBe('4821');
    expect(records[0]?.title).toMatch(/Ada/i);
    expect(records[0]?.title).toMatch(/PRIVILEGE/i);
  });

  it('parses leave-approval lines', () => {
    const records = extractHubInboxRecords(
      'Ada applied for PRIVILEGE leave #4821\nNo pending requests'
    );
    expect(records).toHaveLength(1);
    expect(records[0]?.title).toMatch(/Ada applied/i);
    expect(records[0]?.id).toBe('4821');
  });
});

describe('collectMatterSignals Hub inbox', () => {
  it('collects kudos and announcements, and skips leave, WFH, and timesheet tools', async () => {
    const { mcp, calls } = mockHubMcp({
      list_kudos: () =>
        hubEnvelope([{ id: 'k-1', message: 'Great collab', sender_name: 'Jay', unread: true }]),
      list_my_timesheet_drafts: () =>
        hubEnvelope([{ id: 'td-1', week_start: '2026-08-10', status: 'DRAFT' }]),
      list_pending_leave_wfh_requests: () =>
        hubEnvelope([
          { id: '4821', employee_name: 'Ada', leaveType: 'PRIVILEGE', status: 'PENDING' },
        ]),
      list_pending_wfh_requests: () =>
        hubEnvelope([{ id: 'wfh-1', employee_name: 'Ada', wfhType: 'WFH', status: 'PENDING' }]),
      list_pending_leave_requests: () =>
        hubEnvelope([{ id: '4822', employee_name: 'Ada', leaveType: 'SICK', status: 'PENDING' }]),
      get_leave_wfh_calendar: () =>
        hubEnvelope([{ id: 'cal-1', employee_name: 'Ada', leaveType: 'PRIVILEGE' }]),
      list_pending_timesheet_reviews: () =>
        hubEnvelope([{ id: 'ts-9', title: 'Sam timesheet week of Aug 10', status: 'SUBMITTED' }]),
      list_announcements: () =>
        hubEnvelope([{ id: 'a-1', title: 'Office closed Friday', type: 'announcement' }]),
    });

    const result = await collectMatterSignals({
      mcpManager: mcp,
      meetingService: null,
      profile: { name: 'Kalrav', email: 'kalrav@york.ie' },
      sources: HUB_ONLY,
    });

    const toolsCalled = calls.map((c) => c.name.split('__').pop());
    expect(toolsCalled).not.toContain('list_notifications');
    expect(toolsCalled).not.toContain('list_hub_requests');
    expect(toolsCalled).not.toContain('list_pending_leave_wfh_requests');
    expect(toolsCalled).not.toContain('list_pending_wfh_requests');
    expect(toolsCalled).not.toContain('list_pending_leave_requests');
    expect(toolsCalled).not.toContain('get_leave_wfh_calendar');
    expect(toolsCalled).not.toContain('list_my_timesheet_drafts');
    expect(toolsCalled).not.toContain('list_pending_timesheet_reviews');
    expect(toolsCalled).toContain('list_kudos');
    expect(toolsCalled).toContain('list_announcements');
    expect(
      calls.some((c) => c.name.includes('list_announcements') && 'time_sensitive' in (c.args || {}))
    ).toBe(false);

    const hub = result.signals.filter((s) => s.source === 'hub');
    expect(hub.some((s) => s.fingerprint === 'hub:kudos:k-1')).toBe(true);
    expect(
      hub.some(
        (s) => /leave|wfh|timesheet/i.test(s.fingerprint) || /leave|wfh|timesheet/i.test(s.title)
      )
    ).toBe(false);
    expect(hub.some((s) => s.fingerprint === 'hub:announcement:a-1')).toBe(true);
    expect(hub.find((s) => s.fingerprint === 'hub:kudos:k-1')?.orbitHint).toBe('week');
    expect(result.sourcesChecked).toContain('hub');
  });

  it('keeps kudos the user received and drops kudos sent to someone else', async () => {
    const { mcp, calls } = mockHubMcp({
      list_kudos: () =>
        hubEnvelope([
          {
            id: 'k-other',
            message: 'Abhijit has been doing outstanding work',
            sender_email: 'lay.s@york.ie',
            recipient_email: 'abhijit.p@york.ie',
          },
          {
            id: 'k-mine',
            message: 'Nice work',
            sender_email: 'ada@york.ie',
            recipient_email: 'kalrav@york.ie',
          },
        ]),
      list_announcements: () => hubEnvelope([]),
    });

    const result = await collectMatterSignals({
      mcpManager: mcp,
      meetingService: null,
      profile: { name: 'Kalrav', email: 'kalrav@york.ie' },
      sources: HUB_ONLY,
    });

    const kudosCalls = calls.filter((c) => c.name.includes('list_kudos'));
    expect(kudosCalls).toHaveLength(1);
    expect(kudosCalls[0]?.args.recipient).toBe('kalrav@york.ie');
    expect(kudosCalls[0]?.args.recipient_email).toBe('kalrav@york.ie');
    expect(kudosCalls.some((c) => c.args.recipient == null && c.args.limit != null)).toBe(false);

    const fingerprints = result.signals.map((s) => s.fingerprint);
    expect(fingerprints).toContain('hub:kudos:k-mine');
    expect(fingerprints).not.toContain('hub:kudos:k-other');
  });

  it('does not pull the company kudos feed when the scoped query is empty', async () => {
    const { mcp, calls } = mockHubMcp({
      list_kudos: (args) => {
        if (args.recipient || args.recipient_email) return hubEnvelope([]);
        return hubEnvelope([
          {
            id: 'k-org',
            message: 'Outstanding work',
            sender_email: 'lay.s@york.ie',
            recipient_email: 'abhijit.p@york.ie',
          },
        ]);
      },
      list_announcements: () => hubEnvelope([]),
    });

    const result = await collectMatterSignals({
      mcpManager: mcp,
      meetingService: null,
      profile: { name: 'Kalrav', email: 'kalrav@york.ie' },
      sources: HUB_ONLY,
    });

    expect(calls.filter((c) => c.name.includes('list_kudos'))).toHaveLength(1);
    expect(result.signals.some((s) => s.fingerprint.startsWith('hub:kudos:'))).toBe(false);
  });

  it('collects Hub when the connector is connected under a non-default id', async () => {
    const { mcp, calls } = mockHubMcp(
      {
        list_kudos: () => hubEnvelope([{ id: 'k-2', message: 'Nice work', sender_name: 'Sam' }]),
        list_announcements: () => envelopeResult(''),
      },
      { serverId: 'migrated-hub-id', name: DEFAULT_HUB_MCP_NAME }
    );

    expect(resolveHubServerId(mcp)).toBe('migrated-hub-id');

    const result = await collectMatterSignals({
      mcpManager: mcp,
      meetingService: null,
      profile: { name: 'Kalrav', email: 'kalrav@york.ie' },
      sources: HUB_ONLY,
    });
    expect(calls.some((c) => c.name.includes('list_kudos'))).toBe(true);
    expect(result.signals.some((s) => s.fingerprint === 'hub:kudos:k-2')).toBe(true);
    expect(result.sourcesChecked).toContain('hub');
  });

  it('skips Hub when the connector is disconnected', async () => {
    const { mcp, calls } = mockHubMcp(
      { list_kudos: () => envelopeResult('should not run') },
      { connected: false }
    );
    const result = await collectMatterSignals({
      mcpManager: mcp,
      meetingService: null,
      profile: null,
      sources: HUB_ONLY,
    });
    expect(calls).toHaveLength(0);
    expect(result.sourcesSkipped).toContain('hub');
  });

  it('skips Hub when the source is disabled', async () => {
    const { mcp, calls } = mockHubMcp({
      list_kudos: () => envelopeResult('should not run'),
    });
    const result = await collectMatterSignals({
      mcpManager: mcp,
      meetingService: null,
      profile: null,
      sources: { ...HUB_ONLY, hub: false },
    });
    expect(calls).toHaveLength(0);
    expect(result.sourcesSkipped).toContain('hub');
  });
});

describe('hub kudos recipient', () => {
  it('reads recipient_email from a Hub kudos row', () => {
    expect(
      hubKudosRecipientEmail({
        id: 'f43f5103-c8f3-48ab-b69e-1726394415ca',
        sender_email: 'lay.s@york.ie',
        recipient_email: 'abhijit.p@york.ie',
        message: 'Outstanding work',
      })
    ).toBe('abhijit.p@york.ie');
  });

  it('treats a kudo for someone else as not for the signed-in user', () => {
    const raw = JSON.stringify({
      RECIPIENT_EMAIL: 'abhijit.p@york.ie',
      SENDER_EMAIL: 'lay.s@york.ie',
      MESSAGE: 'Outstanding work',
    });
    expect(hubKudosIsForUser(raw, 'kalrav@york.ie')).toBe(false);
    expect(hubKudosIsForUser(raw, 'abhijit.p@york.ie')).toBe(true);
    expect(hubKudosIsForUser({ message: 'Nice work' }, 'kalrav@york.ie')).toBe(true);
  });
});

describe('Hub awareness recency', () => {
  const now = Date.parse('2026-09-07T12:00:00.000Z');

  it('picks the newest of created_at / updated_at', () => {
    expect(
      hubRecordNewestTimestampMs({
        created_at: '2026-03-17T06:29:39.332Z',
        updated_at: '2026-04-10T09:27:09.981Z',
      })
    ).toBe(Date.parse('2026-04-10T09:27:09.981Z'));
  });

  it('treats missing timestamps as fresh for awareness kinds', () => {
    const record: HubInboxRecord = {
      id: 'k-no-date',
      title: 'Jay sent kudos',
      summary: 'thanks',
      unread: true,
      raw: { id: 'k-no-date', message: 'thanks' },
    };
    expect(hubAwarenessRecordIsFresh('kudos', record, now)).toBe(true);
    expect(hubAwarenessRecordIsFresh('announcement', record, now)).toBe(true);
  });

  it('drops awareness records older than 30 days and keeps recent ones', () => {
    const stale: HubInboxRecord = {
      id: 'k-old',
      title: 'First kudos ever',
      summary: 'very first kudos',
      unread: true,
      raw: {
        id: 'k-old',
        message: 'very first kudos',
        created_at: '2026-03-17T06:29:39.332Z',
        updated_at: '2026-04-10T09:27:09.981Z',
      },
    };
    const recent: HubInboxRecord = {
      id: 'k-new',
      title: 'Recent kudos',
      summary: 'shipped last week',
      unread: true,
      raw: {
        id: 'k-new',
        message: 'shipped last week',
        created_at: '2026-08-28T10:00:00.000Z',
      },
    };
    expect(hubAwarenessRecordIsFresh('kudos', stale, now)).toBe(false);
    expect(hubAwarenessRecordIsFresh('announcement', stale, now)).toBe(false);
    expect(hubAwarenessRecordIsFresh('kudos', recent, now)).toBe(true);
  });

  it('never age-filters non-awareness kinds even when timestamps are old', () => {
    const oldRequest: HubInboxRecord = {
      id: 'req-old',
      title: 'Hub request',
      summary: 'still open',
      unread: true,
      raw: { id: 'req-old', status: 'open', created_at: '2026-01-01T00:00:00.000Z' },
    };
    expect(hubAwarenessRecordIsFresh('request', oldRequest, now)).toBe(true);
  });

  it('omits stale kudos/announcements from collectMatterSignals', async () => {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const staleIso = new Date(now - 120 * day).toISOString();
    const freshIso = new Date(now - 5 * day).toISOString();

    const { mcp } = mockHubMcp({
      list_kudos: () =>
        hubEnvelope([
          {
            id: 'k-stale',
            message: 'very first kudos',
            sender_name: 'Kalrav',
            created_at: staleIso,
            updated_at: staleIso,
          },
          {
            id: 'k-fresh',
            message: 'Nice ship',
            sender_name: 'Ada',
            created_at: freshIso,
          },
        ]),
      list_announcements: () =>
        hubEnvelope([
          {
            id: 'a-stale',
            title: 'Old all-hands',
            created_at: staleIso,
          },
          {
            id: 'a-fresh',
            title: 'Office closed Friday',
            published_at: freshIso,
          },
        ]),
      list_my_timesheet_drafts: () =>
        hubEnvelope([
          {
            id: 'td-old',
            week_start: '2026-01-05',
            status: 'DRAFT',
            created_at: staleIso,
          },
        ]),
      list_pending_timesheet_reviews: () =>
        hubEnvelope([{ id: 'ts-old', title: 'Old timesheet review', status: 'SUBMITTED' }]),
    });

    const result = await collectMatterSignals({
      mcpManager: mcp,
      meetingService: null,
      profile: { name: 'Kalrav', email: 'kalrav@york.ie' },
      sources: HUB_ONLY,
    });

    const fps = result.signals.map((s) => s.fingerprint);
    expect(fps).toContain('hub:kudos:k-fresh');
    expect(fps).not.toContain('hub:kudos:k-stale');
    expect(fps).toContain('hub:announcement:a-fresh');
    expect(fps).not.toContain('hub:announcement:a-stale');
    expect(fps).not.toContain('hub:timesheet_draft:td-old');
    expect(fps.some((fp) => fp.startsWith('hub:timesheet:'))).toBe(false);
    // Scan contract: MatterService.runScan → reconcileAbsentItems(collected fingerprints).
    // Stale kudos omitted here leave the seen-set, so prior active rows expire after the grace.
    expect(fps.filter((fp) => fp.startsWith('hub:kudos:'))).toEqual(['hub:kudos:k-fresh']);
  });
});

describe('heuristicRank Hub notifications', () => {
  it('keeps Hub items without action verbs', () => {
    const signal: RawMatterSignal = {
      fingerprint: 'hub:kudos:k-1',
      source: 'hub',
      title: 'Jay sent you kudos',
      summary: 'Great collab',
      rawExcerpt: 'Great collab',
      severityHint: 'signal',
      orbitHint: 'week',
      categoryHint: 'people',
      muteKeys: ['source:hub'],
    };
    const ranked = heuristicRank([signal], null, 10);
    expect(ranked.items).toHaveLength(1);
    expect(ranked.items[0]?.source).toBe('hub');
  });

  it('places Hub items with a today hint on today, not watching', () => {
    const signal: RawMatterSignal = {
      fingerprint: 'hub:announcement:a-1',
      source: 'hub',
      title: 'Office closed Friday',
      summary: 'Read the announcement',
      rawExcerpt: 'Office closed Friday',
      severityHint: 'warning',
      orbitHint: 'today',
      categoryHint: 'people',
      muteKeys: ['source:hub'],
    };
    const ranked = heuristicRank([signal], null, 10);
    expect(ranked.items[0]?.orbit).toBe('today');
  });
});

describe('selectSignalsForRanker Hub reservation', () => {
  it('reserves Hub slots when other sources arrive first', () => {
    const calendar = Array.from({ length: 40 }, (_, i) => ({
      fingerprint: `cal:${i}`,
      source: 'calendar' as const,
      title: `Meeting ${i}`,
      summary: 'soon',
      rawExcerpt: '',
      severityHint: 'signal' as const,
      orbitHint: 'today' as const,
      categoryHint: 'time' as const,
      muteKeys: [],
    }));
    const hub = Array.from({ length: 5 }, (_, i) => ({
      fingerprint: `hub:kudos:${i}`,
      source: 'hub' as const,
      title: `Kudos ${i}`,
      summary: 'thanks',
      rawExcerpt: '',
      severityHint: 'signal' as const,
      orbitHint: 'week' as const,
      categoryHint: 'people' as const,
      muteKeys: [],
    }));
    const pool = selectSignalsForRanker([...calendar, ...hub], 40);
    expect(pool.filter((s) => s.source === 'hub')).toHaveLength(5);
    expect(pool.length).toBe(40);
  });
});
