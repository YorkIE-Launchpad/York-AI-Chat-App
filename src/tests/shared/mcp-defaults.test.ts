import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHROME_MCP_SERVER_ID,
  DEFAULT_HUB_MCP_SERVER_ID,
  DEFAULT_MCP_CONNECTORS,
  DEFAULT_SLACK_MCP_NAME,
  DEFAULT_SLACK_MCP_SERVER_ID,
  mergeDefaultMcpServerStatuses,
} from '../../shared/mcp-defaults';

describe('mergeDefaultMcpServerStatuses', () => {
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
    expect(merged.findIndex((s) => s.id === DEFAULT_CHROME_MCP_SERVER_ID)).toBe(0);
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
