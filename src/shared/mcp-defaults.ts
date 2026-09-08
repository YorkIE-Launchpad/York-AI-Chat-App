/**
 * Built-in MCP connector catalog — shared by main (seeding) and renderer (ContextPanel).
 */

export const DEFAULT_CHROME_MCP_SERVER_ID = 'mcp-chrome-default';
export const DEFAULT_LAUNCHPAD_MCP_SERVER_ID = 'mcp-launchpad-default';
export const DEFAULT_GTM_LAUNCHPAD_MCP_SERVER_ID = 'mcp-gtm-launchpad-default';
export const DEFAULT_RND_PULSE_MCP_SERVER_ID = 'mcp-rd-pulse-default';
export const DEFAULT_HUB_MCP_SERVER_ID = 'mcp-hub-default';
export const DEFAULT_GTM_PULSE_MCP_SERVER_ID = 'mcp-gtm-pulse-default';
export const DEFAULT_SLACK_MCP_SERVER_ID = 'mcp-slack-default';
export const DEFAULT_GMAIL_MCP_SERVER_ID = 'mcp-gmail-default';
export const DEFAULT_GOOGLE_DRIVE_MCP_SERVER_ID = 'mcp-google-drive-default';
export const DEFAULT_JIRA_MCP_SERVER_ID = 'mcp-jira-default';
export const DEFAULT_CONFLUENCE_MCP_SERVER_ID = 'mcp-confluence-default';
export const DEFAULT_GOOGLE_CALENDAR_MCP_SERVER_ID = 'mcp-google-calendar-default';

export const DEFAULT_CHROME_MCP_NAME = 'Chrome';
export const DEFAULT_LAUNCHPAD_MCP_NAME = 'R&D Launchpad';
export const DEFAULT_GTM_LAUNCHPAD_MCP_NAME = 'GTM Launchpad';
export const DEFAULT_RND_PULSE_MCP_NAME = 'R&D Pulse';
export const DEFAULT_HUB_MCP_NAME = 'York IE HUB';
export const DEFAULT_GTM_PULSE_MCP_NAME = 'GTM Pulse';
export const DEFAULT_SLACK_MCP_NAME = 'Slack';
export const DEFAULT_GMAIL_MCP_NAME = 'Gmail';
export const DEFAULT_GOOGLE_DRIVE_MCP_NAME = 'Google Drive';
export const DEFAULT_JIRA_MCP_NAME = 'Jira';
export const DEFAULT_CONFLUENCE_MCP_NAME = 'Confluence';
export const DEFAULT_GOOGLE_CALENDAR_MCP_NAME = 'Google Calendar';

/** Combined UI label for the shared Atlassian Rovo MCP (Jira + Confluence). */
export const DEFAULT_ATLASSIAN_MCP_DISPLAY_NAME = 'Jira & Confluence';

/** Official Atlassian Rovo MCP endpoint (Jira + Confluence tools). */
export const DEFAULT_ATLASSIAN_MCP_URL = 'https://mcp.atlassian.com/v1/mcp/authv2';

export function isAtlassianCatalogServerId(id: string): boolean {
  return id === DEFAULT_JIRA_MCP_SERVER_ID || id === DEFAULT_CONFLUENCE_MCP_SERVER_ID;
}

export function isAtlassianCombinedDisplayName(name: string): boolean {
  return name === DEFAULT_ATLASSIAN_MCP_DISPLAY_NAME;
}

type AtlassianMergeableStatus = {
  id: string;
  name: string;
  connected: boolean;
  status?: 'connecting' | 'connected' | 'failed' | 'disabled';
  toolCount: number;
};

function mergeAtlassianConnectionStatus(
  a?: AtlassianMergeableStatus['status'],
  b?: AtlassianMergeableStatus['status']
): AtlassianMergeableStatus['status'] {
  const statuses = [a, b].filter(Boolean) as NonNullable<AtlassianMergeableStatus['status']>[];
  if (statuses.includes('connecting')) return 'connecting';
  if (statuses.includes('connected')) return 'connected';
  if (statuses.includes('failed')) return 'failed';
  return 'disabled';
}

/**
 * Collapse separate Jira + Confluence catalog rows into one shared Atlassian row
 * for UI lists (they share one Rovo MCP OAuth session).
 */
export function mergeAtlassianMcpServerStatuses<T extends AtlassianMergeableStatus>(
  servers: T[]
): T[] {
  const jira = servers.find(
    (s) => s.id === DEFAULT_JIRA_MCP_SERVER_ID || s.name === DEFAULT_JIRA_MCP_NAME
  );
  const confluence = servers.find(
    (s) => s.id === DEFAULT_CONFLUENCE_MCP_SERVER_ID || s.name === DEFAULT_CONFLUENCE_MCP_NAME
  );
  if (!jira && !confluence) {
    return servers;
  }

  const insertAt = Math.min(
    jira ? servers.indexOf(jira) : Number.POSITIVE_INFINITY,
    confluence ? servers.indexOf(confluence) : Number.POSITIVE_INFINITY
  );

  const combined = {
    ...(jira ?? confluence)!,
    id: jira?.id ?? confluence!.id,
    name: DEFAULT_ATLASSIAN_MCP_DISPLAY_NAME,
    connected: Boolean(jira?.connected || confluence?.connected),
    status: mergeAtlassianConnectionStatus(jira?.status, confluence?.status),
    toolCount: (jira?.toolCount ?? 0) + (confluence?.toolCount ?? 0),
  } as T;

  const withoutPair = servers.filter((s) => s !== jira && s !== confluence);
  const result = [...withoutPair];
  const safeIndex = Number.isFinite(insertAt) ? Math.min(insertAt, result.length) : result.length;
  result.splice(safeIndex, 0, combined);
  return result;
}

export interface DefaultMcpConnectorDef {
  id: string;
  name: string;
}

/** Fixed display order for built-in connectors in the ContextPanel. */
export const DEFAULT_MCP_CONNECTORS: readonly DefaultMcpConnectorDef[] = [
  { id: DEFAULT_HUB_MCP_SERVER_ID, name: DEFAULT_HUB_MCP_NAME },
  { id: DEFAULT_LAUNCHPAD_MCP_SERVER_ID, name: DEFAULT_LAUNCHPAD_MCP_NAME },
  { id: DEFAULT_GTM_LAUNCHPAD_MCP_SERVER_ID, name: DEFAULT_GTM_LAUNCHPAD_MCP_NAME },
  { id: DEFAULT_RND_PULSE_MCP_SERVER_ID, name: DEFAULT_RND_PULSE_MCP_NAME },
  { id: DEFAULT_GTM_PULSE_MCP_SERVER_ID, name: DEFAULT_GTM_PULSE_MCP_NAME },
  { id: DEFAULT_SLACK_MCP_SERVER_ID, name: DEFAULT_SLACK_MCP_NAME },
  { id: DEFAULT_GMAIL_MCP_SERVER_ID, name: DEFAULT_GMAIL_MCP_NAME },
  { id: DEFAULT_GOOGLE_DRIVE_MCP_SERVER_ID, name: DEFAULT_GOOGLE_DRIVE_MCP_NAME },
  { id: DEFAULT_JIRA_MCP_SERVER_ID, name: DEFAULT_JIRA_MCP_NAME },
  { id: DEFAULT_CONFLUENCE_MCP_SERVER_ID, name: DEFAULT_CONFLUENCE_MCP_NAME },
  { id: DEFAULT_GOOGLE_CALENDAR_MCP_SERVER_ID, name: DEFAULT_GOOGLE_CALENDAR_MCP_NAME },
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
