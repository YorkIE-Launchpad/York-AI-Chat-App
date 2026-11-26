/**
 * Resolve a slim WelcomeProfile from AuthUser + Hub /me + optional Hub MCP.
 */

import { authConfig } from '../../shared/auth-config';
import type { WelcomeProfile } from '../../shared/welcome-actions';
import { hubHttpRequest } from '../auth/hub-http';
import { getCurrentSession } from '../auth/session';
import { isHubMcpServer } from '../mcp/mcp-config-store';
import type { MCPManager } from '../mcp/mcp-manager';
import { logWarn } from '../utils/logger';
import {
  extractHubProfileFields,
  mergeHubProfileFields,
  type ExtractedHubProfileFields,
} from './extract-hub-profile';

const HUB_PROFILE_PATHS = ['/api/auth/me', '/api/users/me', '/api/employees/me'] as const;

function hasOrgFields(fields: ExtractedHubProfileFields): boolean {
  return Boolean(fields.title && (fields.functionName || fields.department || fields.squad));
}

async function fetchHubMeFields(accessToken: string): Promise<ExtractedHubProfileFields> {
  const token = accessToken.trim();
  if (!token) return {};

  let merged: ExtractedHubProfileFields = {};
  for (const path of HUB_PROFILE_PATHS) {
    try {
      const res = await hubHttpRequest(`${authConfig.hubApiUrl}${path}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
        timeoutMs: 12_000,
      });
      if (!res.ok) continue;
      const body = await res.json<unknown>();
      merged = mergeHubProfileFields(merged, extractHubProfileFields(body));
      // Keep reading until designation and org placement are both present.
      // A partial body used to stop the loop before squad.function was seen.
      if (hasOrgFields(merged)) break;
    } catch {
      // try next endpoint
    }
  }
  return merged;
}

function findHubProfileToolName(mcpManager: MCPManager): string | null {
  const tools = mcpManager.getTools();
  for (const tool of tools) {
    const original = (tool.originalName || '').toLowerCase();
    const name = tool.name.toLowerCase();
    const isProfile =
      original === 'get_employee_profile' ||
      name.endsWith('__get_employee_profile') ||
      name.includes('get_employee_profile');
    if (!isProfile) continue;
    const server = mcpManager.getServerStatus().find((s) => s.id === tool.serverId);
    if (server && isHubMcpServer({ name: server.name, type: 'streamable-http' })) {
      return tool.name;
    }
    // Fall back: any connected tool named get_employee_profile
    if (tool.serverName && /hub/i.test(tool.serverName)) {
      return tool.name;
    }
  }
  // Last resort: any get_employee_profile tool
  const any = tools.find(
    (t) =>
      (t.originalName || '').toLowerCase() === 'get_employee_profile' ||
      t.name.toLowerCase().includes('get_employee_profile')
  );
  return any?.name ?? null;
}

function parseMcpToolResult(result: unknown): unknown {
  if (result == null) return null;
  if (typeof result === 'string') {
    try {
      return JSON.parse(result) as unknown;
    } catch {
      return { text: result };
    }
  }
  if (typeof result !== 'object') return result;
  const record = result as Record<string, unknown>;
  // MCP CallToolResult shape: { content: [{ type: 'text', text: '...' }] }
  if (Array.isArray(record.content)) {
    const texts = record.content
      .filter((c): c is { type?: string; text?: string } => c != null && typeof c === 'object')
      .map((c) => (typeof c.text === 'string' ? c.text : ''))
      .filter(Boolean);
    if (texts.length === 1) {
      try {
        return JSON.parse(texts[0]) as unknown;
      } catch {
        return { text: texts[0] };
      }
    }
    if (texts.length > 1) {
      return { text: texts.join('\n') };
    }
  }
  return result;
}

async function fetchHubMcpProfileFields(
  mcpManager: MCPManager | null | undefined,
  email: string
): Promise<ExtractedHubProfileFields> {
  if (!mcpManager || !email.trim()) return {};
  try {
    const statuses = mcpManager.getServerStatus();
    const hubConnected = statuses.some(
      (s) => s.connected && isHubMcpServer({ name: s.name, type: 'streamable-http' })
    );
    if (!hubConnected) return {};

    const toolName = findHubProfileToolName(mcpManager);
    if (!toolName) return {};

    const raw = await mcpManager.callTool(toolName, { email: email.trim() });
    const body = parseMcpToolResult(raw);
    return extractHubProfileFields(body);
  } catch (error) {
    logWarn('[WelcomeProfile] Hub MCP get_employee_profile failed:', error);
    return {};
  }
}

/**
 * Resolve welcome profile for the signed-in user.
 */
export async function resolveWelcomeProfile(options?: {
  mcpManager?: MCPManager | null;
}): Promise<WelcomeProfile | null> {
  const session = getCurrentSession();
  if (!session?.user?.email) return null;

  const user = session.user;
  let fields: ExtractedHubProfileFields = {};

  const accessToken = session.accessToken?.trim() || '';
  const idToken = session.idToken?.trim() || '';
  if (accessToken) {
    fields = mergeHubProfileFields(fields, await fetchHubMeFields(accessToken));
  }
  if (!hasOrgFields(fields) && idToken && idToken !== accessToken) {
    fields = mergeHubProfileFields(fields, await fetchHubMeFields(idToken));
  }

  fields = mergeHubProfileFields(
    fields,
    await fetchHubMcpProfileFields(options?.mcpManager, user.email)
  );

  return {
    email: user.email,
    name: fields.name || user.name || user.email,
    title: fields.title ?? null,
    functionName: fields.functionName ?? null,
    squad: fields.squad ?? null,
    department: fields.department ?? null,
    introduction: fields.introduction ?? null,
  };
}
