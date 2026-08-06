/**
 * MCP connector write-access policy helpers.
 *
 * Classifies model-facing MCP tool names (`mcp__Server__tool`) as read / write /
 * unknown, and computes whether writes are effectively allowed given the global
 * kill-switch and optional per-server override.
 *
 * Enforcement lives in the main process (`decidePermission`, `mcp_call_tool`).
 */

export const MCP_WRITE_DISABLED_MESSAGE =
  'Connector write access is disabled in Settings → Connectors.';

/** Shared Atlassian Rovo discovery tools exposed on both Jira and Confluence servers. */
const ATLASSIAN_SHARED_READ_SUFFIXES = [
  'atlassianuserinfo',
  'getaccessibleatlassianresources',
  'searchatlassian',
  'fetchatlassian',
] as const;

/** First-party connector tools that are safe to auto-allow (reads only). */
export const MCP_FIRST_PARTY_READ_TOOLS: ReadonlySet<string> = new Set([
  // Slack
  'mcp__slack__list_channels',
  'mcp__slack__get_channel_history',
  'mcp__slack__search_messages',
  'mcp__slack__get_thread',
  'mcp__slack__get_user',
  // Gmail
  'mcp__gmail__search_emails',
  'mcp__gmail__get_email',
  'mcp__gmail__list_labels',
  // Google Drive
  'mcp__google_drive__search_files',
  'mcp__google_drive__list_files',
  'mcp__google_drive__get_file_metadata',
  'mcp__google_drive__get_document_content',
  'mcp__google_drive__get_spreadsheet_values',
  // Google Calendar
  'mcp__google_calendar__list_events',
  'mcp__google_calendar__search_events',
  'mcp__google_calendar__get_event',
  // Jira
  ...ATLASSIAN_SHARED_READ_SUFFIXES.map((name) => `mcp__jira__${name}`),
  'mcp__jira__getjiraissue',
  'mcp__jira__getjiraissueremoteissuelinks',
  'mcp__jira__getjiraissuetypemetawithfields',
  'mcp__jira__getjiraprojectissuetypesmetadata',
  'mcp__jira__getissuelinktypes',
  'mcp__jira__gettransitionsforjiraissue',
  'mcp__jira__getvisiblejiraprojects',
  'mcp__jira__lookupjiraaccountid',
  'mcp__jira__searchjiraissuesusingjql',
  // Confluence
  ...ATLASSIAN_SHARED_READ_SUFFIXES.map((name) => `mcp__confluence__${name}`),
  'mcp__confluence__getconfluencepage',
  'mcp__confluence__getconfluencepagedescendants',
  'mcp__confluence__getconfluencepagefootercomments',
  'mcp__confluence__getconfluencepageinlinecomments',
  'mcp__confluence__getconfluencecommentchildren',
  'mcp__confluence__getconfluencespaces',
  'mcp__confluence__getpagesinconfluencespace',
  'mcp__confluence__searchconfluenceusingcql',
]);

/** Server keys (sanitized, lowercase) for first-party connectors with explicit read lists. */
const FIRST_PARTY_SERVER_KEYS: ReadonlySet<string> = new Set([
  'slack',
  'gmail',
  'google_drive',
  'google_calendar',
  'jira',
  'confluence',
]);

/** Known write leaf names that do not match the write-prefix heuristic. */
const KNOWN_WRITE_LEAVES: ReadonlySet<string> = new Set([
  'post_message',
  'send_email',
  'create_draft',
  'update_draft',
  'create_document',
  'update_document_content',
  'create_folder',
  'create_spreadsheet',
  'update_spreadsheet_values',
  'create_event',
  'update_event',
  'delete_event',
  'mcp_auth',
  'lock_release',
  'activate_release',
  'spawn_dev_agent',
  'cursor_agent_followup',
]);

const READ_LEAF_PREFIX =
  /^(get|list|search|fetch|find|read|lookup|resolve|describe|count|summarize|view|show|inspect|status|available|me\b)/i;

const WRITE_LEAF_PREFIX =
  /^(create|update|delete|post|send|edit|add|remove|set|transition|lock|unlock|revoke|cancel|fail|spawn|activate|revert|disconnect|upload|write|append|put|patch|insert|replace|move|rename|assign|approve|reject|publish|unpublish|invite|share|comment|worklog)/i;

export type McpToolAccessClass = 'read' | 'write' | 'unknown';

export interface ParsedMcpToolName {
  serverKey: string;
  leafName: string;
}

/** Sanitize a server/tool segment the same way MCPManager builds model-facing names. */
export function sanitizeMcpToolSegment(segment: string, fallback = 'server'): string {
  const sanitized = segment
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return sanitized || fallback;
}

/** True for flattened MCP tools (`mcp__Server__tool`), not meta tools like `mcp_call_tool`. */
export function isMcpPrefixedTool(toolName: string): boolean {
  return toolName.toLowerCase().startsWith('mcp__');
}

/**
 * Parse `mcp__ServerKey__leaf` (case-insensitive). Returns null for non-MCP names.
 * Leaf may itself contain `__` (dedup suffixes); everything after the first
 * server segment is the leaf.
 */
export function parseMcpToolName(toolName: string): ParsedMcpToolName | null {
  const trimmed = toolName.trim();
  if (!trimmed.toLowerCase().startsWith('mcp__')) return null;
  const remainder = trimmed.slice('mcp__'.length);
  const sep = remainder.indexOf('__');
  if (sep <= 0) return null;
  const serverKey = remainder.slice(0, sep);
  const leafName = remainder.slice(sep + 2);
  if (!serverKey || !leafName) return null;
  return { serverKey, leafName };
}

/**
 * Classify an MCP tool as read, write, or unknown.
 * Non-MCP names return `unknown` (caller should ignore).
 */
export function classifyMcpToolAccess(toolName: string): McpToolAccessClass {
  if (!isMcpPrefixedTool(toolName)) return 'unknown';

  const lowered = toolName.toLowerCase();
  if (MCP_FIRST_PARTY_READ_TOOLS.has(lowered)) return 'read';

  const parsed = parseMcpToolName(lowered);
  if (!parsed) return 'unknown';

  // First-party connectors: anything not on the read allowlist is a write.
  if (FIRST_PARTY_SERVER_KEYS.has(parsed.serverKey)) {
    return 'write';
  }

  const leaf = parsed.leafName;
  if (KNOWN_WRITE_LEAVES.has(leaf)) return 'write';
  if (WRITE_LEAF_PREFIX.test(leaf)) return 'write';
  if (READ_LEAF_PREFIX.test(leaf)) return 'read';

  return 'unknown';
}

/** True when the tool should be treated as a mutating MCP call for write gates. */
export function isMcpWriteTool(toolName: string): boolean {
  if (!isMcpPrefixedTool(toolName)) return false;
  const kind = classifyMcpToolAccess(toolName);
  // Fail closed: unknown MCP tools are treated as writes for the kill-switch.
  return kind === 'write' || kind === 'unknown';
}

/**
 * Effective write permission: global kill-switch AND per-connector override.
 * Omitted / undefined `serverWriteEnabled` means allowed (default on).
 */
export function areMcpWritesEffectivelyAllowed(
  globalEnabled: boolean,
  serverWriteEnabled?: boolean | null
): boolean {
  if (!globalEnabled) return false;
  if (serverWriteEnabled === false) return false;
  return true;
}

/**
 * Whether a specific MCP tool call should be hard-denied by write policy.
 * Non-MCP tools and MCP read tools never deny via this helper.
 */
export function shouldDenyMcpWriteAccess(
  toolName: string,
  globalEnabled: boolean,
  serverWriteEnabled?: boolean | null
): boolean {
  if (!isMcpPrefixedTool(toolName)) return false;
  if (!isMcpWriteTool(toolName)) return false;
  return !areMcpWritesEffectivelyAllowed(globalEnabled, serverWriteEnabled);
}
