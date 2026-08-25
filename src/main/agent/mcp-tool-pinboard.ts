/**
 * Always-flat high-value MCP tools kept visible even when the catalog is in
 * mcp_search_tools / mcp_call_tool meta mode.
 */
import type { ToolDefinition } from '@mariozechner/pi-coding-agent';
import type { MCPManager, MCPTool } from '../mcp/mcp-manager';

/** Normalized server keys (alnum only) that may contribute pinboard tools. */
export const MCP_PINBOARD_SERVER_KEYS = new Set([
  'hub',
  'yorkiehub',
  'googlecalendar',
  'slack',
  'gmail',
  'googledrive',
  'launchpad',
  'rdlaunchpad',
  'confluence',
  'jira',
]);

/** Preferred originalNames (lowercase) that stay listed in meta mode. */
export const MCP_PINBOARD_ORIGINAL_NAMES = new Set([
  // Hub
  'list_employees',
  'search_organization',
  'get_leave_wfh_calendar',
  'generate_timesheet_summary',
  'list_projects',
  'get_project',
  'list_clients',
  'get_client',
  // Calendar
  'list_calendars',
  'list_events',
  'search_events',
  'get_event',
  'create_event',
  'update_event',
  'query_freebusy',
  'delete_event',
  'respond_to_event',
  // Slack
  'search_messages',
  'get_thread',
  'get_channel_history',
  'get_user',
  'post_message',
  // Gmail
  'search_emails',
  'get_email',
  'list_labels',
  'send_email',
  'create_draft',
  'update_draft',
  'send_draft',
  // LaunchPad start / poll / lifecycle
  'start_scope_implement',
  'start_preview',
  'lock_release',
  'seed_release',
  'seed_release_from_prior',
  'set_release_scope',
  'get_scope_implement_active',
  'get_scope_implement_run',
  'get_preview_status',
  'get_release_lock_status',
  'list_features',
  'list_releases',
  'get_release',
  // Drive
  'search_files',
  'get_document_content',
  'get_spreadsheet_values',
  // Confluence / Jira (common original names)
  'getconfluencepage',
  'searchconfluenceusingcql',
  'createconfluencepage',
  'updateconfluencepage',
  'getconfluencespaces',
  'getpagesinconfluencespace',
  'getjiraissue',
  'searchjiraissuesusingjql',
]);

const SERVER_PRIORITY = [
  'yorkiehub',
  'hub',
  'googlecalendar',
  'slack',
  'gmail',
  'rdlaunchpad',
  'launchpad',
  'googledrive',
  'confluence',
  'jira',
];

export const MCP_PINBOARD_MAX_ANTHROPIC = 24;
export const MCP_PINBOARD_MAX_OPENAI = 40;

export function normalizeMcpServerKey(serverName: string): string {
  return (serverName || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export function mcpToolOriginalName(tool: Pick<MCPTool, 'name' | 'originalName'>): string {
  const fromField = (tool.originalName || '').trim();
  if (fromField) return fromField;
  const parts = tool.name.split('__');
  return parts.length > 2 ? parts.slice(2).join('__') : tool.name;
}

export function isPinboardMcpTool(tool: Pick<MCPTool, 'name' | 'originalName' | 'serverName'>): boolean {
  const serverKey = normalizeMcpServerKey(tool.serverName);
  if (!MCP_PINBOARD_SERVER_KEYS.has(serverKey)) return false;
  const original = mcpToolOriginalName(tool).toLowerCase();
  return MCP_PINBOARD_ORIGINAL_NAMES.has(original);
}

function serverPriority(serverName: string): number {
  const key = normalizeMcpServerKey(serverName);
  const index = SERVER_PRIORITY.indexOf(key);
  return index === -1 ? SERVER_PRIORITY.length : index;
}

export function pickPinboardMcpTools(
  mcpManager: MCPManager | null,
  mcpToolDefs: ToolDefinition[],
  maxCount: number
): ToolDefinition[] {
  if (!mcpManager || maxCount <= 0 || mcpToolDefs.length === 0) return [];
  const catalog = mcpManager.getTools().filter(isPinboardMcpTool);
  if (catalog.length === 0) return [];

  const defByName = new Map(mcpToolDefs.map((tool) => [tool.name, tool]));
  const ranked = [...catalog].sort((a, b) => {
    const byServer = serverPriority(a.serverName) - serverPriority(b.serverName);
    if (byServer !== 0) return byServer;
    return a.name.localeCompare(b.name);
  });

  const picked: ToolDefinition[] = [];
  const seen = new Set<string>();
  for (const tool of ranked) {
    if (picked.length >= maxCount) break;
    if (seen.has(tool.name)) continue;
    const def = defByName.get(tool.name);
    if (!def) continue;
    seen.add(tool.name);
    picked.push(def);
  }
  return picked;
}
