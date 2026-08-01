/**
 * Filter Atlassian Rovo MCP tools so Jira / Confluence catalog entries only
 * expose their product tools (+ shared discovery helpers).
 */

const SHARED_ATLASSIAN_TOOLS = new Set([
  'atlassianuserinfo',
  'getaccessibleatlassianresources',
  'searchatlassian',
  'fetchatlassian',
]);

export type AtlassianProductFilter = 'jira' | 'confluence';

export function filterAtlassianToolsByProduct<T extends { name?: string }>(
  tools: T[],
  product: AtlassianProductFilter
): T[] {
  const productNeedle = product === 'jira' ? 'jira' : 'confluence';
  return tools.filter((tool) => {
    const name = typeof tool.name === 'string' ? tool.name.trim() : '';
    if (!name) return false;
    const lowered = name.toLowerCase();
    if (SHARED_ATLASSIAN_TOOLS.has(lowered)) return true;
    return lowered.includes(productNeedle);
  });
}

/** Normalize Atlassian MCP URLs so Jira/Confluence siblings share one key. */
export function normalizeAtlassianMcpShareUrl(url: string): string {
  const trimmed = url.trim();
  try {
    const parsed = new URL(trimmed);
    parsed.hash = '';
    const path = parsed.pathname.replace(/\/+$/, '') || '';
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${path}${parsed.search}`;
  } catch {
    return trimmed.replace(/\/+$/, '').toLowerCase();
  }
}

/**
 * Atlassian authv2 AS metadata returns `issuer: https://auth.atlassian.com` while
 * PRM advertises a path-scoped AS URL (`…/VCeD…`). MCP SDK v2 enforces RFC 8414 §3.3
 * and throws IssuerMismatchError unless validation is skipped for this known server bug.
 *
 * @see https://github.com/atlassian/atlassian-mcp-server/issues/205
 */
export function shouldSkipAtlassianOAuthIssuerValidation(url: string): boolean {
  try {
    const host = new URL(url.trim()).hostname.toLowerCase();
    return host === 'mcp.atlassian.com' || host.endsWith('.mcp.atlassian.com');
  } catch {
    return false;
  }
}

export function isAtlassianCatalogServerName(name: string): boolean {
  const lowered = name.trim().toLowerCase();
  return lowered === 'jira' || lowered === 'confluence';
}

/**
 * Built-in Jira/Confluence streamable-http rows that point at the same Rovo MCP URL.
 */
export function isShareableAtlassianRemoteMcpServer(server: {
  name: string;
  type: string;
  url?: string;
}): boolean {
  return (
    server.type === 'streamable-http' &&
    Boolean(server.url?.trim()) &&
    isAtlassianCatalogServerName(server.name)
  );
}
