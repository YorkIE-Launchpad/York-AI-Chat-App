import { describe, expect, it } from 'vitest';
import {
  collectMatterSignals,
  isSlackOpaqueId,
  parseSlackSearchBody,
  type RawMatterSignal,
} from '../src/main/matter/matter-collector';
import { heuristicRank, capRankedItemsBySource, selectSignalsForRanker } from '../src/main/matter/matter-ranker';
import type { MCPManager } from '../src/main/mcp/mcp-manager';
import { DEFAULT_SLACK_MCP_SERVER_ID } from '../src/shared/mcp-defaults';
import type { MatterSourcesConfig } from '../src/shared/matter';

const SLACK_OFF_OTHERS: MatterSourcesConfig = {
  calendar: false,
  slack: false,
  gmail: false,
  jira: false,
  hub: false,
  meeting: false,
  launchpad: false,
};

const SLACK_ONLY: MatterSourcesConfig = {
  ...SLACK_OFF_OTHERS,
  slack: true,
};

const DM_LINE =
  'D0123ABC|Jay Smith [1700000000.000100] Ada: looping you in on the deck\nLink: https://app.slack.com/archives/D0123ABC/p1700000000000100';
const CHANNEL_LINE =
  'C0123XYZ|#eng [1700000001.000200] Sam: standup notes from this morning\nLink: https://app.slack.com/archives/C0123XYZ/p1700000001000200';

function envelopeResult(body: string) {
  return {
    content: [{ type: 'text', text: JSON.stringify({ body }) }],
  };
}

function mockSlackMcp(options?: {
  connected?: boolean;
  onCall?: (args: Record<string, unknown>) => unknown;
}): { mcp: MCPManager; calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  const connected = options?.connected !== false;
  const mcp = {
    getServerStatus: () => [
      {
        id: DEFAULT_SLACK_MCP_SERVER_ID,
        name: 'Slack',
        connected,
        status: connected ? 'connected' : 'disabled',
        toolCount: 1,
      },
    ],
    getTools: () => [
      {
        name: 'mcp__Slack__search_messages',
        originalName: 'search_messages',
        serverId: DEFAULT_SLACK_MCP_SERVER_ID,
        serverName: 'Slack',
      },
      {
        name: 'mcp__Slack__get_user',
        originalName: 'get_user',
        serverId: DEFAULT_SLACK_MCP_SERVER_ID,
        serverName: 'Slack',
      },
    ],
    callTool: async (_name: string, args: Record<string, unknown>) => {
      calls.push(args);
      if (options?.onCall) return options.onCall(args);
      return envelopeResult('');
    },
  } as unknown as MCPManager;
  return { mcp, calls };
}

describe('isSlackOpaqueId', () => {
  it('flags Slack user and channel IDs', () => {
    expect(isSlackOpaqueId('U01JJCQ9SUW')).toBe(true);
    expect(isSlackOpaqueId('C0123ABCDE')).toBe(true);
    expect(isSlackOpaqueId('Jay Smith')).toBe(false);
    expect(isSlackOpaqueId('eng')).toBe(false);
  });
});

describe('parseSlackSearchBody', () => {
  it('parses DM display names with spaces', () => {
    const parsed = parseSlackSearchBody('Jay Smith [1700000000.000100] Ada: hello there');
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      channel: 'Jay Smith',
      channelLabel: 'Jay Smith',
      ts: '1700000000.000100',
      user: 'Ada',
      text: 'hello there',
    });
  });

  it('parses channelId|#name tokens', () => {
    const parsed = parseSlackSearchBody(
      'C0123XYZ|#eng [1700000001.000200] Sam: standup notes\nLink: https://app.slack.com/archives/C0123XYZ/p1'
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      channel: 'C0123XYZ',
      channelLabel: 'eng',
      ts: '1700000001.000200',
      user: 'Sam',
      text: 'standup notes',
      link: 'https://app.slack.com/archives/C0123XYZ/p1',
    });
  });

  it('unwraps a JSON envelope body when collect path already extracted it', () => {
    const parsed = parseSlackSearchBody(DM_LINE);
    expect(parsed[0]?.channel).toBe('D0123ABC');
    expect(parsed[0]?.channelLabel).toBe('Jay Smith');
    expect(parsed[0]?.text).toBe('looping you in on the deck');
  });
});

describe('collectMatterSignals Slack unreads', () => {
  it('searches unread DMs then channels and keeps messages without action language', async () => {
    const { mcp, calls } = mockSlackMcp({
      onCall: (args) => {
        const query = String(args.query || '');
        if (query.includes('-is:dm')) return envelopeResult(CHANNEL_LINE);
        if (query.includes('is:dm')) return envelopeResult(DM_LINE);
        return envelopeResult('');
      },
    });

    const result = await collectMatterSignals({
      mcpManager: mcp,
      meetingService: null,
      profile: null,
      sources: SLACK_ONLY,
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      query: 'is:unread is:dm',
      limit: 20,
      sort: 'timestamp',
    });
    expect(calls[1]).toMatchObject({
      query: 'is:unread -is:dm',
      limit: 20,
      sort: 'timestamp',
    });

    expect(result.sourcesChecked).toContain('slack');
    expect(result.signals.map((s) => s.fingerprint)).toEqual([
      'slack:msg:D0123ABC:1700000000.000100',
      'slack:msg:C0123XYZ:1700000001.000200',
    ]);
    expect(result.signals[0]?.title).toMatch(/DM/);
    expect(result.signals[0]?.dueAt).toBeUndefined();
    expect(result.signals[0]?.occurredAt).toBeUndefined();
    expect(result.signals[0]?.expiresAt).toBeUndefined();
    expect(result.signals[0]?.summary).toMatch(/looping you in/i);
  });

  it('never puts Slack user IDs in titles and decodes :clipboard:', async () => {
    const idLine =
      'D0123ABC|U01JJCQ9SUW [1700000000.000100] U01SENDER9: :clipboard: Daily Briefing — Sunday\nLink: https://app.slack.com/archives/D0123ABC/p1';
    const { mcp } = mockSlackMcp({
      onCall: (args) => {
        if (typeof args.user_id === 'string') return envelopeResult('');
        const query = String(args.query || '');
        if (query.includes('is:dm') && !query.includes('-is:dm')) return envelopeResult(idLine);
        return envelopeResult('');
      },
    });
    const result = await collectMatterSignals({
      mcpManager: mcp,
      meetingService: null,
      profile: null,
      sources: SLACK_ONLY,
    });
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0]?.title).not.toMatch(/U01JJCQ9SUW/i);
    expect(result.signals[0]?.title).not.toMatch(/U01SENDER9/i);
    expect(result.signals[0]?.title).toMatch(/Daily Briefing/);
    expect(result.signals[0]?.title).toContain('📋');
    expect(result.signals[0]?.title).toMatch(/DM/);
  });

  it('resolves leftover Slack user IDs via get_user', async () => {
    const idLine =
      'D0123ABC|U01JJCQ9SUW [1700000000.000100] kalrav: hello\nLink: https://app.slack.com/archives/D0123ABC/p1';
    const { mcp } = mockSlackMcp({
      onCall: (args) => {
        if (args.user_id === 'U01JJCQ9SUW') {
          return envelopeResult(JSON.stringify({ real_name: 'Ada Chen' }));
        }
        const query = String(args.query || '');
        if (query.includes('is:dm') && !query.includes('-is:dm')) return envelopeResult(idLine);
        return envelopeResult('');
      },
    });
    const result = await collectMatterSignals({
      mcpManager: mcp,
      meetingService: null,
      profile: null,
      sources: SLACK_ONLY,
    });
    expect(result.signals[0]?.title).toMatch(/DM with Ada Chen/);
    expect(result.signals[0]?.title).not.toMatch(/U01JJCQ9SUW/i);
  });

  it('keeps human channel names like #eng', async () => {
    const { mcp } = mockSlackMcp({
      onCall: (args) => {
        const query = String(args.query || '');
        if (query.includes('-is:dm')) return envelopeResult(CHANNEL_LINE);
        return envelopeResult('');
      },
    });
    const result = await collectMatterSignals({
      mcpManager: mcp,
      meetingService: null,
      profile: null,
      sources: SLACK_ONLY,
    });
    expect(result.signals[0]?.title).toMatch(/#eng/);
  });

  it('skips Slack when the source is disabled', async () => {
    const { mcp, calls } = mockSlackMcp();
    const result = await collectMatterSignals({
      mcpManager: mcp,
      meetingService: null,
      profile: null,
      sources: SLACK_OFF_OTHERS,
    });
    expect(calls).toHaveLength(0);
    expect(result.sourcesSkipped).toContain('slack');
    expect(result.signals.filter((s) => s.source === 'slack')).toHaveLength(0);
  });
});

describe('Matter ranker source balancing', () => {
  it('selectSignalsForRanker reserves pool slots for non-Slack sources', () => {
    const slack = Array.from({ length: 30 }, (_, i) => ({
      fingerprint: `slack:${i}`,
      source: 'slack' as const,
      title: `Slack ${i}`,
      summary: 'unread',
      rawExcerpt: '',
      severityHint: 'signal' as const,
      orbitHint: 'today' as const,
      categoryHint: 'comms' as const,
      muteKeys: [],
    }));
    const jira = Array.from({ length: 5 }, (_, i) => ({
      fingerprint: `jira:${i}`,
      source: 'jira' as const,
      title: `Jira ${i}`,
      summary: 'blocked',
      rawExcerpt: '',
      severityHint: 'critical' as const,
      orbitHint: 'now' as const,
      categoryHint: 'delivery' as const,
      muteKeys: [],
    }));
    const pool = selectSignalsForRanker([...slack, ...jira], 40);
    expect(pool.filter((s) => s.source === 'jira')).toHaveLength(5);
    expect(pool.filter((s) => s.source === 'slack').length).toBeLessThanOrEqual(12);
    expect(pool.length).toBe(17);
  });

  it('selectSignalsForRanker reserves Hub when calendar fills the pool', () => {
    const calendar = Array.from({ length: 50 }, (_, i) => ({
      fingerprint: `cal:${i}`,
      source: 'calendar' as const,
      title: `Cal ${i}`,
      summary: 'event',
      rawExcerpt: '',
      severityHint: 'signal' as const,
      orbitHint: 'today' as const,
      categoryHint: 'time' as const,
      muteKeys: [],
    }));
    const hub = Array.from({ length: 3 }, (_, i) => ({
      fingerprint: `hub:${i}`,
      source: 'hub' as const,
      title: `Hub ${i}`,
      summary: 'inbox',
      rawExcerpt: '',
      severityHint: 'warning' as const,
      orbitHint: 'today' as const,
      categoryHint: 'people' as const,
      muteKeys: [],
    }));
    const pool = selectSignalsForRanker([...calendar, ...hub], 40);
    expect(pool.filter((s) => s.source === 'hub')).toHaveLength(3);
  });

  it('capRankedItemsBySource limits Slack on the radar while keeping higher-priority sources', () => {
    const items = [
      ...Array.from({ length: 12 }, (_, i) => ({
        source: 'slack' as const,
        rankScore: 50 - i,
        fingerprint: `slack:${i}`,
      })),
      { source: 'jira' as const, rankScore: 45, fingerprint: 'jira:1' },
      { source: 'calendar' as const, rankScore: 44, fingerprint: 'cal:1' },
    ];
    const capped = capRankedItemsBySource(items, 10);
    expect(capped.filter((i) => i.source === 'slack').length).toBeLessThanOrEqual(8);
    expect(capped.some((i) => i.source === 'jira')).toBe(true);
    expect(capped.some((i) => i.source === 'calendar')).toBe(true);
    expect(capped.length).toBe(10);
  });

  it('heuristicRank keeps Jira visible when many Slack unreads are present', () => {
    const slackSignals: RawMatterSignal[] = Array.from({ length: 15 }, (_, i) => ({
      fingerprint: `slack:msg:C:${i}`,
      source: 'slack',
      title: `Slack unread ${i}`,
      summary: 'ping',
      rawExcerpt: 'ping',
      severityHint: 'signal',
      orbitHint: 'today',
      categoryHint: 'comms',
      muteKeys: ['source:slack'],
    }));
    const jiraSignal: RawMatterSignal = {
      fingerprint: 'jira:PROJ-1',
      source: 'jira',
      title: 'Release blocked on QA',
      summary: 'QA failing on checkout',
      rawExcerpt: 'blocked',
      severityHint: 'critical',
      orbitHint: 'now',
      categoryHint: 'delivery',
      muteKeys: [],
    };
    const ranked = heuristicRank([...slackSignals, jiraSignal], null, 10);
    expect(ranked.items.some((i) => i.source === 'jira')).toBe(true);
    expect(ranked.items.filter((i) => i.source === 'slack').length).toBeLessThanOrEqual(8);
  });
});

describe('heuristicRank Slack unreads', () => {
  it('keeps a Slack unread with no action verbs and does not expire on message ts', () => {
    const signal: RawMatterSignal = {
      fingerprint: 'slack:msg:D1:1.2',
      source: 'slack',
      title: 'Ada in DM with Jay Smith: looping you in on the deck',
      summary: 'looping you in on the deck',
      rawExcerpt: 'looping you in on the deck',
      severityHint: 'signal',
      orbitHint: 'today',
      categoryHint: 'comms',
      muteKeys: ['source:slack'],
    };
    const ranked = heuristicRank([signal], null, 10);
    expect(ranked.items).toHaveLength(1);
    expect(ranked.items[0]?.fingerprint).toBe(signal.fingerprint);
    expect(ranked.items[0]?.source).toBe('slack');
    expect(ranked.items[0]?.expiresAt).toBeNull();
    expect(ranked.items[0]?.dueAt).toBeNull();
  });
});
