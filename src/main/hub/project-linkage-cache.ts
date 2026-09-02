/**
 * Session-scoped cache of Hub project linkage metadata for connector MCP scoping.
 */
import type { MCPManager } from '../mcp/mcp-manager';
import {
  extractProjectLinkageFromHubPayload,
  mergeLinkageForSession,
  type ProjectLinkageMetadata,
} from '../../shared/project-linkage-metadata';
import { resolveProjectAllowlist, type SessionDivisionFields } from '../../shared/workspace-division';
import { hubMcpOriginalToolName } from '../../shared/project-mcp-scope';
import { logWarn } from '../utils/logger';

type LinkageCacheEntry = {
  linkage: ProjectLinkageMetadata;
  fetchedAt: number;
};

const linkageByHubProjectId = new Map<string, LinkageCacheEntry>();
const LINKAGE_TTL_MS = 15 * 60 * 1000;

export function clearProjectLinkageCache(): void {
  linkageByHubProjectId.clear();
}

export async function prefetchSessionProjectLinkage(
  mcpManager: MCPManager | null | undefined,
  session: Partial<SessionDivisionFields> | null | undefined
): Promise<void> {
  const allowlist = resolveProjectAllowlist(session);
  if (!mcpManager || !allowlist || allowlist.hubIds.size === 0) return;

  const hubTool = mcpManager
    .getTools()
    .find((tool: { name: string }) => hubMcpOriginalToolName(tool.name) === 'get_project');
  if (!hubTool) return;

  const now = Date.now();
  for (const hubId of allowlist.hubIds) {
    const cached = linkageByHubProjectId.get(hubId);
    if (cached && now - cached.fetchedAt < LINKAGE_TTL_MS) continue;
    try {
      const result = await mcpManager.callTool(hubTool.name, { projectId: hubId });
      const text =
        typeof result === 'string'
          ? result
          : result && typeof result === 'object' && 'content' in result
            ? JSON.stringify(result)
            : String(result);
      let payload: unknown = text;
      try {
        payload = JSON.parse(text);
      } catch {
        // keep raw text walk
      }
      linkageByHubProjectId.set(hubId, {
        linkage: extractProjectLinkageFromHubPayload(payload),
        fetchedAt: now,
      });
    } catch (error) {
      logWarn('[ProjectLinkage] Failed to prefetch Hub get_project for', hubId, error);
    }
  }
}

export function linkageForSession(
  session: Partial<SessionDivisionFields> | null | undefined
): ProjectLinkageMetadata {
  const cache = new Map<string, ProjectLinkageMetadata>();
  const now = Date.now();
  for (const [hubId, entry] of linkageByHubProjectId) {
    if (now - entry.fetchedAt < LINKAGE_TTL_MS) {
      cache.set(hubId, entry.linkage);
    }
  }
  return mergeLinkageForSession(cache, session);
}

/** @internal */
export function _linkageCacheSizeForTests(): number {
  return linkageByHubProjectId.size;
}
