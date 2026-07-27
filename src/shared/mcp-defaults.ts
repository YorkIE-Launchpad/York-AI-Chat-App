/**
 * Built-in MCP connector catalog — shared by main (seeding) and renderer (ContextPanel).
 */

export const DEFAULT_CHROME_MCP_SERVER_ID = 'mcp-chrome-default';
export const DEFAULT_LAUNCHPAD_MCP_SERVER_ID = 'mcp-launchpad-default';
export const DEFAULT_RND_PULSE_MCP_SERVER_ID = 'mcp-rd-pulse-default';
export const DEFAULT_HUB_MCP_SERVER_ID = 'mcp-hub-default';
export const DEFAULT_GTM_PULSE_MCP_SERVER_ID = 'mcp-gtm-pulse-default';
export const DEFAULT_SLACK_MCP_SERVER_ID = 'mcp-slack-default';
export const DEFAULT_GMAIL_MCP_SERVER_ID = 'mcp-gmail-default';
export const DEFAULT_GOOGLE_DRIVE_MCP_SERVER_ID = 'mcp-google-drive-default';

export const DEFAULT_CHROME_MCP_NAME = 'Chrome';
export const DEFAULT_LAUNCHPAD_MCP_NAME = 'R&D Launchpad';
export const DEFAULT_RND_PULSE_MCP_NAME = 'R&D Pulse';
export const DEFAULT_HUB_MCP_NAME = 'York IE HUB';
export const DEFAULT_GTM_PULSE_MCP_NAME = 'GTM Pulse';
export const DEFAULT_SLACK_MCP_NAME = 'Slack';
export const DEFAULT_GMAIL_MCP_NAME = 'Gmail';
export const DEFAULT_GOOGLE_DRIVE_MCP_NAME = 'Google Drive';

export interface DefaultMcpConnectorDef {
  id: string;
  name: string;
}

/** Fixed display order for built-in connectors in the ContextPanel. */
export const DEFAULT_MCP_CONNECTORS: readonly DefaultMcpConnectorDef[] = [
  { id: DEFAULT_HUB_MCP_SERVER_ID, name: DEFAULT_HUB_MCP_NAME },
  { id: DEFAULT_LAUNCHPAD_MCP_SERVER_ID, name: DEFAULT_LAUNCHPAD_MCP_NAME },
  { id: DEFAULT_RND_PULSE_MCP_SERVER_ID, name: DEFAULT_RND_PULSE_MCP_NAME },
  { id: DEFAULT_GTM_PULSE_MCP_SERVER_ID, name: DEFAULT_GTM_PULSE_MCP_NAME },
  { id: DEFAULT_SLACK_MCP_SERVER_ID, name: DEFAULT_SLACK_MCP_NAME },
  { id: DEFAULT_GMAIL_MCP_SERVER_ID, name: DEFAULT_GMAIL_MCP_NAME },
  { id: DEFAULT_GOOGLE_DRIVE_MCP_SERVER_ID, name: DEFAULT_GOOGLE_DRIVE_MCP_NAME },
  { id: DEFAULT_CHROME_MCP_SERVER_ID, name: DEFAULT_CHROME_MCP_NAME },
] as const;

const DEFAULT_MCP_ID_SET = new Set(DEFAULT_MCP_CONNECTORS.map((c) => c.id));

export function isDefaultMcpServerId(id: string): boolean {
  return DEFAULT_MCP_ID_SET.has(id);
}

export type McpServerStatusInfo = {
  id: string;
  name: string;
  connected: boolean;
  status?: 'connecting' | 'connected' | 'failed' | 'disabled';
  toolCount: number;
};

/**
 * Merge live server statuses with the built-in catalog so every default
 * connector always appears (disabled fallback if missing), followed by
 * any custom (non-default) servers.
 */
export function mergeDefaultMcpServerStatuses(
  liveStatuses: McpServerStatusInfo[]
): McpServerStatusInfo[] {
  const byId = new Map<string, McpServerStatusInfo>();
  const byName = new Map<string, McpServerStatusInfo>();

  for (const status of liveStatuses) {
    byId.set(status.id, status);
    byName.set(status.name.toLowerCase(), status);
  }

  const claimedIds = new Set<string>();
  const defaults: McpServerStatusInfo[] = DEFAULT_MCP_CONNECTORS.map((def) => {
    const byExactId = byId.get(def.id);
    if (byExactId) {
      claimedIds.add(byExactId.id);
      return { ...byExactId, name: byExactId.name || def.name };
    }

    // Migrated built-in may keep display name but use a different id
    const byDisplayName = byName.get(def.name.toLowerCase());
    if (byDisplayName) {
      claimedIds.add(byDisplayName.id);
      return byDisplayName;
    }

    return {
      id: def.id,
      name: def.name,
      connected: false,
      status: 'disabled' as const,
      toolCount: 0,
    };
  });

  const defaultNames = new Set(DEFAULT_MCP_CONNECTORS.map((c) => c.name.toLowerCase()));
  const custom = liveStatuses.filter(
    (s) =>
      !claimedIds.has(s.id) &&
      !isDefaultMcpServerId(s.id) &&
      !defaultNames.has(s.name.toLowerCase())
  );

  return [...defaults, ...custom];
}

/**
 * Sort MCP server configs to match DEFAULT_MCP_CONNECTORS order, then custom servers.
 * Matches by catalog id or display name (for migrated built-ins).
 */
export function sortMcpServersByDefaultOrder<T extends { id: string; name: string }>(
  servers: T[]
): T[] {
  const orderById = new Map(DEFAULT_MCP_CONNECTORS.map((c, i) => [c.id, i]));
  const orderByName = new Map(DEFAULT_MCP_CONNECTORS.map((c, i) => [c.name.toLowerCase(), i]));

  function rank(server: T): number {
    const byId = orderById.get(server.id);
    if (byId !== undefined) return byId;
    const byName = orderByName.get(server.name.toLowerCase());
    if (byName !== undefined) return byName;
    return DEFAULT_MCP_CONNECTORS.length;
  }

  return [...servers].sort((a, b) => {
    const diff = rank(a) - rank(b);
    if (diff !== 0) return diff;
    return a.name.localeCompare(b.name);
  });
}
