/**
 * Low-level MCP helpers shared by meeting prep and Matter calendar enrichment.
 */

import type { MCPManager } from '../../mcp/mcp-manager';
import { logWarn } from '../../utils/logger';
import { DEFAULT_HUB_MCP_NAME, DEFAULT_HUB_MCP_SERVER_ID } from '../../../shared/mcp-defaults';

export function toolResultText(result: unknown): string {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  if (typeof result === 'object') {
    const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
    if (Array.isArray(content)) {
      return content
        .map((c) => (typeof c?.text === 'string' ? c.text : ''))
        .filter(Boolean)
        .join('\n');
    }
  }
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

export function findToolName(
  mcpManager: MCPManager,
  serverId: string,
  candidates: string[]
): string | null {
  try {
    const tools = mcpManager.getTools().filter((t) => t.serverId === serverId);
    for (const hint of candidates) {
      const lower = hint.toLowerCase();
      const match = tools.find((t) => {
        const original = (t.originalName || '').toLowerCase();
        const name = t.name.toLowerCase();
        return original === lower || original.includes(lower) || name.includes(lower);
      });
      if (match) return match.name;
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function isServerConnected(mcpManager: MCPManager, serverId: string): boolean {
  try {
    return mcpManager.getServerStatus().some((s) => s.id === serverId && s.connected);
  } catch {
    return false;
  }
}

export function resolveHubServerId(mcpManager: MCPManager): string | null {
  try {
    const connected = mcpManager.getServerStatus().filter((s) => s.connected);
    const exact = connected.find((s) => s.id === DEFAULT_HUB_MCP_SERVER_ID);
    if (exact) return exact.id;
    const named = connected.find((s) => {
      const n = (s.name || '').toLowerCase();
      return (
        n.includes('hub') || n === DEFAULT_HUB_MCP_NAME.toLowerCase() || n.includes('york ie hub')
      );
    });
    if (named) return named.id;
  } catch {
    /* ignore */
  }
  return null;
}

export async function safeCallTool(
  mcpManager: MCPManager,
  toolName: string,
  args: Record<string, unknown>
): Promise<string | null> {
  try {
    const result = await mcpManager.callTool(toolName, args);
    const text = toolResultText(result);
    return text || null;
  } catch (error) {
    logWarn(`[Matter] Prep tool ${toolName} failed:`, error);
    return null;
  }
}

export function parseJsonLoose(text: string): unknown | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

/** Connector envelopes carry the human-readable payload in `body`. */
export function envelopeBody(text: string): string {
  const parsed = parseJsonLoose(text);
  if (parsed && typeof parsed === 'object' && parsed !== null && 'body' in parsed) {
    const body = (parsed as { body?: unknown }).body;
    if (typeof body === 'string') return body;
  }
  return text;
}

export function extractUrl(text: string): string | undefined {
  const match = text.match(/https?:\/\/[^\s"'<>]+/i);
  return match?.[0]?.replace(/[),.;]+$/, '');
}

export function htmlToPlainSnippet(fetched: string, max = 280): string {
  const bodyMatch = fetched.match(/\n\n([\s\S]*)$/);
  const body = bodyMatch?.[1] || fetched;
  const text = body
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&\w+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '(no readable text)';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Run async jobs with bounded concurrency; results keep input order. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}
