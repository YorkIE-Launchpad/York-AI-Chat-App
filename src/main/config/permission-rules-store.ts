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
import { MCP_FIRST_PARTY_READ_TOOLS } from '../../shared/mcp-write-policy';
import { isMcpWriteAccessDenied } from './mcp-write-access-store';

// Mirrors the renderer defaults in src/renderer/store/index.ts
const DEFAULT_RULES: PermissionRule[] = [
  { tool: 'read', action: 'allow' },
  { tool: 'glob', action: 'allow' },
  { tool: 'grep', action: 'allow' },
  { tool: 'ls', action: 'allow' },
  { tool: 'find', action: 'allow' },
  { tool: 'wiki_search', action: 'allow' },
  { tool: 'wiki_read', action: 'allow' },
  { tool: 'wiki_list', action: 'allow' },
  { tool: 'write', action: 'ask' },
  { tool: 'edit', action: 'ask' },
  { tool: 'bash', action: 'ask' },
];

/** Mutating wiki tools stay on the ask path until an explicit rule exists. */
const WIKI_MUTATION_TOOLS = new Set([
  'wiki_write',
  'wiki_create',
  'wiki_update',
  'wiki_delete',
  'wiki_edit',
  'wiki_upsert',
  'wiki_remove',
]);

/** First-party wiki reads (`wiki_search` / `wiki_read` / `wiki_list` and future `wiki_*`). */
export function isAutoAllowedWikiTool(toolName: string): boolean {
  const lowered = toolName.toLowerCase();
  if (!lowered.startsWith('wiki_')) return false;
  return !WIKI_MUTATION_TOOLS.has(lowered);
}

const VALID_ACTIONS: ReadonlySet<PermissionRule['action']> = new Set(['allow', 'deny', 'ask']);

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
 *   0. MCP write kill-switch / per-connector writeEnabled (hard deny; beats always-allow)
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
 *      first-party wiki tools (`wiki_*` except mutations like `wiki_write`),
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

  // Global / per-connector write deny beats session always-allow.
  if (isMcpWriteAccessDenied(toolName)) {
    return 'deny';
  }

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
  // first-party meeting / wiki tools, and webfetch run without a permission prompt.
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
  if (MCP_FIRST_PARTY_READ_TOOLS.has(lowered)) return 'allow';
  if (lowered === 'meeting_search') return 'allow';
  if (lowered === 'meeting_read') return 'allow';
  if (isAutoAllowedWikiTool(toolName)) return 'allow';
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
