import { describe, expect, it } from 'vitest';
import {
  collectMatterSignals,
  parseSlackSearchBody,
  type RawMatterSignal,
} from '../src/main/matter/matter-collector';
import { heuristicRank } from '../src/main/matter/matter-ranker';
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
    ],
    callTool: async (_name: string, args: Record<string, unknown>) => {
      calls.push(args);
      if (options?.onCall) return options.onCall(args);
      return envelopeResult('');
    },
  } as unknown as MCPManager;
  return { mcp, calls };
}

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
      limit: 40,
      sort: 'timestamp',
    });
    expect(calls[1]).toMatchObject({
      query: 'is:unread -is:dm',
      limit: 40,
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
