/**
 * Resolve mcp_run child wall-clock timeout. Remote Atlassian (Jira/Confluence)
 * goals default higher because Rovo MCP + free-child discovery often exceeds 120s.
 */
import { DEFAULT_CHILD_TIMEOUT_MS, MAX_CHILD_TIMEOUT_MS } from './child-agent-session';

export const ATLASSIAN_MCP_RUN_TIMEOUT_MS = 240_000;

const ATLASSIAN_HINT =
  /\b(jira|confluence|atlassian|rovo)\b|getconfluence|searchconfluence|getjira|searchjira/i;

export function mentionsAtlassianMcp(goal?: string, server?: string): boolean {
  const haystack = [goal, server]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .join(' ');
  if (!haystack) return false;
  return ATLASSIAN_HINT.test(haystack);
}

/**
 * Explicit timeout_seconds always wins (clamped). Otherwise Atlassian-aware
 * goals default to 240s; everything else uses the general child default (120s).
 */
export function resolveMcpRunTimeoutMs(options: {
  goal?: string;
  server?: string;
  timeoutSeconds?: number;
}): number {
  if (typeof options.timeoutSeconds === 'number' && Number.isFinite(options.timeoutSeconds)) {
    const ms = options.timeoutSeconds * 1000;
    return Math.min(Math.max(ms, 10_000), MAX_CHILD_TIMEOUT_MS);
  }
  if (mentionsAtlassianMcp(options.goal, options.server)) {
    return Math.min(ATLASSIAN_MCP_RUN_TIMEOUT_MS, MAX_CHILD_TIMEOUT_MS);
  }
  return Math.min(DEFAULT_CHILD_TIMEOUT_MS, MAX_CHILD_TIMEOUT_MS);
}
