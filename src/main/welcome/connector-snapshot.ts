/**
 * Build connector snapshot for welcome-action generation from store + runtime status.
 */

import type { WelcomeConnectorSnapshot } from '../../shared/welcome-actions';
import { mcpConfigStore } from '../mcp/mcp-config-store';
import type { MCPManager } from '../mcp/mcp-manager';

export function buildWelcomeConnectorSnapshot(
  mcpManager?: MCPManager | null
): WelcomeConnectorSnapshot[] {
  const servers = mcpConfigStore.getServers();
  const statusById = new Map((mcpManager?.getServerStatus() ?? []).map((s) => [s.id, s] as const));

  return servers.map((server) => {
    const status = statusById.get(server.id);
    return {
      id: server.id,
      name: server.name,
      enabled: Boolean(server.enabled),
      status: status?.status ?? (server.enabled ? 'failed' : 'disabled'),
      toolCount: status?.toolCount ?? 0,
    };
  });
}
