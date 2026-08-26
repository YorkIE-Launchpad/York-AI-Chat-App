import { describe, expect, it } from 'vitest';
import {
  collectMatterSignals,
  extractHubInboxRecords,
  resolveHubServerId,
  type RawMatterSignal,
} from '../src/main/matter/matter-collector';
import {
  heuristicRank,
  selectSignalsForRanker,
} from '../src/main/matter/matter-ranker';
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
  it('collects kudos, timesheet drafts, leave inbox, and announcements via real Hub tools', async () => {
    const { mcp, calls } = mockHubMcp({
      list_kudos: () =>
        hubEnvelope([{ id: 'k-1', message: 'Great collab', sender_name: 'Jay', unread: true }]),
      list_my_timesheet_drafts: () =>
        hubEnvelope([{ id: 'td-1', week_start: '2026-08-10', status: 'DRAFT' }]),
      list_pending_leave_wfh_requests: () =>
        hubEnvelope([
          { id: '4821', employee_name: 'Ada', leaveType: 'PRIVILEGE', status: 'PENDING' },
        ]),
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
    expect(toolsCalled).toContain('list_kudos');
    expect(toolsCalled).toContain('list_my_timesheet_drafts');
    expect(toolsCalled).toContain('list_pending_leave_wfh_requests');
    expect(toolsCalled).toContain('list_pending_timesheet_reviews');
    expect(toolsCalled).toContain('list_announcements');
    expect(
      calls.some((c) => c.name.includes('list_announcements') && 'time_sensitive' in (c.args || {}))
    ).toBe(false);
    expect(
      calls.some(
        (c) => c.name.includes('list_pending_timesheet_reviews') && 'approved_by' in (c.args || {})
      )
    ).toBe(false);

    const hub = result.signals.filter((s) => s.source === 'hub');
    expect(hub.some((s) => s.fingerprint === 'hub:kudos:k-1')).toBe(true);
    expect(hub.some((s) => s.fingerprint === 'hub:timesheet_draft:td-1')).toBe(true);
    expect(hub.some((s) => s.fingerprint.includes('leave') && s.title.match(/Ada/))).toBe(true);
    expect(hub.some((s) => s.fingerprint === 'hub:timesheet:ts-9')).toBe(true);
    expect(hub.some((s) => s.fingerprint === 'hub:announcement:a-1')).toBe(true);
    expect(hub.find((s) => s.fingerprint === 'hub:timesheet_draft:td-1')?.orbitHint).toBe('today');
    expect(hub.find((s) => s.fingerprint === 'hub:kudos:k-1')?.orbitHint).toBe('week');
    expect(result.sourcesChecked).toContain('hub');
  });

  it('collects Hub when the connector is connected under a non-default id', async () => {
    const { mcp, calls } = mockHubMcp(
      {
        list_kudos: () =>
          hubEnvelope([{ id: 'k-2', message: 'Nice work', sender_name: 'Sam' }]),
        list_announcements: () => envelopeResult(''),
        list_my_timesheet_drafts: () => envelopeResult(''),
        list_pending_leave_wfh_requests: () => envelopeResult(''),
        list_pending_timesheet_reviews: () => envelopeResult(''),
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

  it('places Hub action items on today, not watching', () => {
    const signal: RawMatterSignal = {
      fingerprint: 'hub:timesheet_draft:td-1',
      source: 'hub',
      title: 'Timesheet DRAFT (2026-08-10)',
      summary: 'Unsubmitted draft',
      rawExcerpt: 'DRAFT',
      severityHint: 'warning',
      orbitHint: 'today',
      categoryHint: 'admin',
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
