/**
 * @module main/config/mcp-write-access-store
 *
 * Main-process cache for the global MCP write kill-switch, plus helpers that
 * resolve per-server `writeEnabled` and decide whether a tool call should be
 * hard-denied.
 *
 * Server configs are supplied via `setMcpWriteAccessServerSource` so unit tests
 * do not need Electron / mcp-config-store.
 */
import {
  MCP_WRITE_DISABLED_MESSAGE,
  isMcpPrefixedTool,
  parseMcpToolName,
  sanitizeMcpToolSegment,
  shouldDenyMcpWriteAccess,
} from '../../shared/mcp-write-policy';

export { MCP_WRITE_DISABLED_MESSAGE };

export type McpWriteAccessServerInfo = {
  name: string;
  writeEnabled?: boolean;
};

let mcpWriteAccessEnabled = true;
let getServers: () => McpWriteAccessServerInfo[] = () => [];

export function setMcpWriteAccessEnabled(enabled: boolean): void {
  mcpWriteAccessEnabled = enabled !== false;
}

export function getMcpWriteAccessEnabled(): boolean {
  return mcpWriteAccessEnabled;
}

/** Wire the MCP server config source (typically mcpConfigStore.getServers). */
export function setMcpWriteAccessServerSource(fn: () => McpWriteAccessServerInfo[]): void {
  getServers = typeof fn === 'function' ? fn : () => [];
}

/** Look up the connector config whose sanitized name matches the tool's server key. */
export function findMcpServerForTool(toolName: string): McpWriteAccessServerInfo | undefined {
  const parsed = parseMcpToolName(toolName);
  if (!parsed) return undefined;
  const targetKey = parsed.serverKey.toLowerCase();
  return getServers().find(
    (server) => sanitizeMcpToolSegment(server.name, 'server').toLowerCase() === targetKey
  );
}

/**
 * True when this MCP tool call must be hard-denied by write policy.
 * Non-MCP tools and MCP read tools return false.
 */
export function isMcpWriteAccessDenied(toolName: string): boolean {
  if (!isMcpPrefixedTool(toolName)) return false;
  const server = findMcpServerForTool(toolName);
  return shouldDenyMcpWriteAccess(toolName, mcpWriteAccessEnabled, server?.writeEnabled);
}
