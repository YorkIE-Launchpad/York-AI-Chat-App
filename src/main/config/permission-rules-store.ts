/**
 * @module main/config/permission-rules-store
 *
 * Main-process cache of Settings.permissionRules.
 *
 * The renderer owns the source of truth (Zustand store), but the agent
 * runner needs synchronous access in the main process when wrapping tool
 * `execute()` calls. The renderer mirrors changes via the `settings.update`
 * IPC event; see `src/main/index.ts`.
 *
 * Security note: renderer-originated settings are treated as untrusted at
 * this boundary. All rules are validated and coerced before being cached —
 * unknown / malformed values fall back to `'ask'` so the worst-case is a
 * harmless extra prompt, never an unintended auto-allow.
 */
import type { PermissionRule } from '../../renderer/types';

// Mirrors the renderer defaults in src/renderer/store/index.ts
const DEFAULT_RULES: PermissionRule[] = [
  { tool: 'read', action: 'allow' },
  { tool: 'glob', action: 'allow' },
  { tool: 'grep', action: 'allow' },
  { tool: 'ls', action: 'allow' },
  { tool: 'find', action: 'allow' },
  { tool: 'write', action: 'ask' },
  { tool: 'edit', action: 'ask' },
  { tool: 'bash', action: 'ask' },
];

const VALID_ACTIONS: ReadonlySet<PermissionRule['action']> = new Set(['allow', 'deny', 'ask']);

/** Slack MCP tools that may run without a permission prompt (reads only). */
const SLACK_READ_TOOLS = new Set([
  'mcp__slack__list_channels',
  'mcp__slack__get_channel_history',
  'mcp__slack__search_messages',
  'mcp__slack__get_thread',
  'mcp__slack__get_user',
]);

/** Gmail MCP tools that may run without a permission prompt (reads only). */
const GMAIL_READ_TOOLS = new Set([
  'mcp__gmail__search_emails',
  'mcp__gmail__get_email',
  'mcp__gmail__list_labels',
]);

/** Google Drive MCP tools that may run without a permission prompt (reads only). */
const DRIVE_READ_TOOLS = new Set([
  'mcp__google_drive__search_files',
  'mcp__google_drive__list_files',
  'mcp__google_drive__get_file_metadata',
  'mcp__google_drive__get_document_content',
]);

/** Google Calendar MCP tools that may run without a permission prompt (reads only). */
const CALENDAR_READ_TOOLS = new Set([
  'mcp__google_calendar__list_events',
  'mcp__google_calendar__search_events',
  'mcp__google_calendar__get_event',
]);

/** Shared Atlassian Rovo discovery tools exposed on both Jira and Confluence servers. */
const ATLASSIAN_SHARED_READ_SUFFIXES = [
  'atlassianuserinfo',
  'getaccessibleatlassianresources',
  'searchatlassian',
  'fetchatlassian',
] as const;

/** Jira MCP tools that may run without a permission prompt (reads / search only). */
const JIRA_READ_TOOLS = new Set([
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
]);

/** Confluence MCP tools that may run without a permission prompt (reads / search only). */
const CONFLUENCE_READ_TOOLS = new Set([
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

let rules: PermissionRule[] = [...DEFAULT_RULES];

/** Session-scoped "always allow" decisions, keyed by sessionId → set of lowercase tool names. */
const alwaysAllowBySession = new Map<string, Set<string>>();

/**
 * Sanitize an untrusted rules payload from IPC. Drops entries with empty
 * tool names, coerces invalid `action` values to `'ask'`, and preserves
 * optional string `pattern` fields. Returns null for non-array input.
 */
function sanitizeRules(input: unknown): PermissionRule[] | null {
  if (!Array.isArray(input)) return null;
  const out: PermissionRule[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Partial<PermissionRule>;
    const tool = typeof r.tool === 'string' ? r.tool.trim() : '';
    if (!tool) continue;

    const pattern = typeof r.pattern === 'string' ? r.pattern : undefined;
    const rawAction = typeof r.action === 'string' ? r.action : '';
    const action: PermissionRule['action'] = VALID_ACTIONS.has(
      rawAction as PermissionRule['action']
    )
      ? (rawAction as PermissionRule['action'])
      : 'ask'; // Conservative fallback for unknown / malformed actions

    out.push({ tool, pattern, action });
  }
  return out;
}

export function setPermissionRules(next: unknown): void {
  const sanitized = sanitizeRules(next);
  rules = sanitized && sanitized.length > 0 ? sanitized : [...DEFAULT_RULES];
}

export function getPermissionRules(): PermissionRule[] {
  // Return a shallow copy so external callers can't mutate the internal cache.
  return rules.map((r) => ({ ...r }));
}

/**
 * Decide how a given tool call should be handled.
 *
 * Matching order:
 *   1. Session-scoped "always allow" memory
 *   2. First rule whose `tool` matches (case-insensitive) AND whose
 *      optional `pattern` (glob-ish: `*` = any substring) matches the
 *      stringified input
 *   3. Built-in: allow all Chrome DevTools MCP tools (`mcp__Chrome__*`),
 *      R&D Launchpad MCP tools (`mcp__R_D_Launchpad__*` / legacy `mcp__Launchpad__*`),
 *      York IE HUB MCP tools (`mcp__York_IE_HUB__*` / legacy `mcp__Hub__*`),
 *      GTM Pulse MCP tools (`mcp__GTM_Pulse__*`),
 *      Slack / Gmail / Drive / Calendar / Jira / Confluence read tools (see allowlists below; write tools ask),
 *      OpenAI budget meta-tools (`mcp_run`, and child-only `mcp_search_tools` / `mcp_call_tool`),
 *      first-party meeting tools (`meeting_search`, `meeting_read`),
 *      and the first-party `webfetch` tool
 *   4. Default: 'ask' for unknown tools (conservative)
 *
 * Defence-in-depth: even though `setPermissionRules` sanitizes input, we
 * re-validate the matched rule's action here so a malformed rule that
 * somehow bypasses sanitation still falls back to `'ask'` rather than
 * letting an unknown value propagate into the execution path.
 */
export function decidePermission(
  sessionId: string,
  toolName: string,
  input: Record<string, unknown>
): 'allow' | 'deny' | 'ask' {
  const lowered = toolName.toLowerCase();

  const session = alwaysAllowBySession.get(sessionId);
  if (session?.has(lowered)) return 'allow';

  const inputStr = safeStringify(input);

  for (const rule of rules) {
    if (rule.tool.toLowerCase() !== lowered) continue;
    if (rule.pattern && !matchesPattern(rule.pattern, inputStr)) continue;
    return VALID_ACTIONS.has(rule.action) ? rule.action : 'ask';
  }

  // Built-in default: Chrome / R&D Launchpad / R&D Pulse / York IE HUB / GTM Pulse /
  // Slack / Gmail / Drive / Calendar / Jira / Confluence read tools,
  // first-party meeting tools, and webfetch run without a permission prompt.
  // Slack / Gmail / Drive / Calendar / Jira / Confluence write tools fall through to 'ask'.
  // Explicit rules for a specific tool still win above.
  // Legacy Launchpad/Hub prefixes are kept so older connector names keep working.
  if (lowered.startsWith('mcp__chrome__')) return 'allow';
  if (lowered.startsWith('mcp__r_d_launchpad__')) return 'allow';
  if (lowered.startsWith('mcp__launchpad__')) return 'allow';
  if (lowered.startsWith('mcp__r_d_pulse__')) return 'allow';
  if (lowered.startsWith('mcp__york_ie_hub__')) return 'allow';
  if (lowered.startsWith('mcp__hub__')) return 'allow';
  if (lowered.startsWith('mcp__gtm_pulse__')) return 'allow';
  if (SLACK_READ_TOOLS.has(lowered)) return 'allow';
  if (GMAIL_READ_TOOLS.has(lowered)) return 'allow';
  if (DRIVE_READ_TOOLS.has(lowered)) return 'allow';
  if (JIRA_READ_TOOLS.has(lowered)) return 'allow';
  if (CONFLUENCE_READ_TOOLS.has(lowered)) return 'allow';
  if (CALENDAR_READ_TOOLS.has(lowered)) return 'allow';
  if (lowered === 'meeting_search') return 'allow';
  if (lowered === 'meeting_read') return 'allow';
  if (lowered === 'webfetch') return 'allow';
  if (lowered === 'mcp_run') return 'allow';
  if (lowered === 'mcp_search_tools') return 'allow';
  if (lowered === 'mcp_call_tool') return 'allow';

  return 'ask';
}

export function rememberAlwaysAllow(sessionId: string, toolName: string): void {
  const set = alwaysAllowBySession.get(sessionId) ?? new Set<string>();
  set.add(toolName.toLowerCase());
  alwaysAllowBySession.set(sessionId, set);
}

export function forgetSessionPermissions(sessionId: string): void {
  alwaysAllowBySession.delete(sessionId);
}

function safeStringify(v: unknown): string {
  try {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return s ?? '';
  } catch {
    return '';
  }
}

function matchesPattern(pattern: string, haystack: string): boolean {
  // Escape regex metacharacters except '*', then convert '*' → '.*'
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(escaped, 'i').test(haystack);
}
