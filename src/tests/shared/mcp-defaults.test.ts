import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHROME_MCP_SERVER_ID,
  DEFAULT_CONFLUENCE_MCP_SERVER_ID,
  DEFAULT_GMAIL_MCP_SERVER_ID,
  DEFAULT_GOOGLE_CALENDAR_MCP_SERVER_ID,
  DEFAULT_GOOGLE_DRIVE_MCP_SERVER_ID,
  DEFAULT_GTM_PULSE_MCP_SERVER_ID,
  DEFAULT_HUB_MCP_SERVER_ID,
  DEFAULT_JIRA_MCP_SERVER_ID,
  DEFAULT_LAUNCHPAD_MCP_SERVER_ID,
  DEFAULT_MCP_CONNECTORS,
  DEFAULT_RND_PULSE_MCP_NAME,
  DEFAULT_RND_PULSE_MCP_SERVER_ID,
  DEFAULT_SLACK_MCP_NAME,
  DEFAULT_SLACK_MCP_SERVER_ID,
  mergeDefaultMcpServerStatuses,
  sortMcpServersByDefaultOrder,
} from '../../shared/mcp-defaults';

describe('mergeDefaultMcpServerStatuses', () => {
  it('orders built-in connectors: Hub, Launchpad, R&D Pulse, GTM Pulse, Slack, Gmail, Drive, Jira, Confluence, Calendar, Chrome', () => {
    expect(DEFAULT_MCP_CONNECTORS.map((c) => c.id)).toEqual([
      DEFAULT_HUB_MCP_SERVER_ID,
      DEFAULT_LAUNCHPAD_MCP_SERVER_ID,
      DEFAULT_RND_PULSE_MCP_SERVER_ID,
      DEFAULT_GTM_PULSE_MCP_SERVER_ID,
      DEFAULT_SLACK_MCP_SERVER_ID,
      DEFAULT_GMAIL_MCP_SERVER_ID,
      DEFAULT_GOOGLE_DRIVE_MCP_SERVER_ID,
      DEFAULT_JIRA_MCP_SERVER_ID,
      DEFAULT_CONFLUENCE_MCP_SERVER_ID,
      DEFAULT_GOOGLE_CALENDAR_MCP_SERVER_ID,
      DEFAULT_CHROME_MCP_SERVER_ID,
    ]);
    expect(DEFAULT_MCP_CONNECTORS.find((c) => c.id === DEFAULT_RND_PULSE_MCP_SERVER_ID)?.name).toBe(
      DEFAULT_RND_PULSE_MCP_NAME
    );
  });

  it('always returns every default connector even when live list is empty', () => {
    const merged = mergeDefaultMcpServerStatuses([]);
    expect(merged).toHaveLength(DEFAULT_MCP_CONNECTORS.length);
    expect(merged.map((s) => s.id)).toEqual(DEFAULT_MCP_CONNECTORS.map((c) => c.id));
    expect(merged.every((s) => s.status === 'disabled' && !s.connected)).toBe(true);
  });

  it('prefers live status for matching default ids and appends custom servers', () => {
    const merged = mergeDefaultMcpServerStatuses([
      {
        id: DEFAULT_HUB_MCP_SERVER_ID,
        name: 'York IE HUB',
        connected: true,
        status: 'connected',
        toolCount: 12,
      },
      {
        id: 'mcp-custom-notion',
        name: 'Notion',
        connected: false,
        status: 'disabled',
        toolCount: 0,
      },
    ]);

    expect(merged).toHaveLength(DEFAULT_MCP_CONNECTORS.length + 1);
    const hub = merged.find((s) => s.id === DEFAULT_HUB_MCP_SERVER_ID);
    expect(hub).toMatchObject({ connected: true, status: 'connected', toolCount: 12 });
    expect(merged[merged.length - 1]).toMatchObject({
      id: 'mcp-custom-notion',
      name: 'Notion',
    });
    expect(merged.findIndex((s) => s.id === DEFAULT_HUB_MCP_SERVER_ID)).toBe(0);
    expect(merged.findIndex((s) => s.id === DEFAULT_CHROME_MCP_SERVER_ID)).toBe(
      DEFAULT_MCP_CONNECTORS.length - 1
    );
  });

  it('matches migrated defaults by display name when id differs', () => {
    const merged = mergeDefaultMcpServerStatuses([
      {
        id: 'legacy-slack-id',
        name: DEFAULT_SLACK_MCP_NAME,
        connected: true,
        status: 'connected',
        toolCount: 3,
      },
    ]);

    const slack = merged.find((s) => s.name === DEFAULT_SLACK_MCP_NAME);
    expect(slack).toMatchObject({
      id: 'legacy-slack-id',
      connected: true,
      status: 'connected',
      toolCount: 3,
    });
    expect(merged.some((s) => s.id === DEFAULT_SLACK_MCP_SERVER_ID)).toBe(false);
    expect(merged.filter((s) => s.name === DEFAULT_SLACK_MCP_NAME)).toHaveLength(1);
  });
});

describe('sortMcpServersByDefaultOrder', () => {
  it('orders built-ins by catalog and appends custom servers', () => {
    const sorted = sortMcpServersByDefaultOrder([
      { id: DEFAULT_CHROME_MCP_SERVER_ID, name: 'Chrome' },
      { id: 'custom-1', name: 'Notion' },
      { id: DEFAULT_HUB_MCP_SERVER_ID, name: 'York IE HUB' },
      { id: DEFAULT_SLACK_MCP_SERVER_ID, name: 'Slack' },
    ]);

    expect(sorted.map((s) => s.id)).toEqual([
      DEFAULT_HUB_MCP_SERVER_ID,
      DEFAULT_SLACK_MCP_SERVER_ID,
      DEFAULT_CHROME_MCP_SERVER_ID,
      'custom-1',
    ]);
  });
});
