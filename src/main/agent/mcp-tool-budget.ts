/**
 * @module main/agent/mcp-tool-budget
 *
 * OpenAI-compatible APIs reject requests with more than 128 tools.
 * When the flattened MCP tool set would exceed that budget, expose a small
 * pair of meta-tools so the model can still discover and call any MCP tool.
 */
import { Type, type TSchema } from '@sinclair/typebox';
import type { ToolDefinition } from '@mariozechner/pi-coding-agent';
import type { MCPManager, MCPTool } from '../mcp/mcp-manager';
import { log } from '../utils/logger';
import { normalizeMcpToolResultForModel } from './tool-result-utils';

export const OPENAI_MAX_TOOLS = 128;
export const MCP_SEARCH_TOOLS_NAME = 'mcp_search_tools';
export const MCP_CALL_TOOL_NAME = 'mcp_call_tool';
export const MCP_META_TOOL_BEHAVIOR = `<tool_behavior>
MCP tool access (budget mode):
- Connected MCP servers expose too many tools to list directly for this model API.
- Discover tools with mcp_search_tools (optional query/server/limit), then invoke with mcp_call_tool using the exact tool name returned.
- Prefer webfetch for reading http/https page content; use Chrome MCP only for interactive browser work.
</tool_behavior>`;

const DEFAULT_SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 50;

export type McpToolExposureMode = 'flat' | 'meta';

export interface SelectCustomToolsResult {
  customTools: ToolDefinition[];
  mode: McpToolExposureMode;
  toolsSignature: string;
}

export function needsOpenAIToolBudget(api: string | undefined | null): boolean {
  return api === 'openai-completions' || api === 'openai-responses';
}

export function buildMcpToolsSignature(mode: McpToolExposureMode, mcpToolNames: string[]): string {
  const sorted = [...mcpToolNames].sort();
  return `${mode}:${sorted.join(',')}`;
}

function scoreToolMatch(tool: MCPTool, query: string): number {
  const q = query.toLowerCase();
  const name = tool.name.toLowerCase();
  const original = (tool.originalName || '').toLowerCase();
  const server = tool.serverName.toLowerCase();
  const description = (tool.description || '').toLowerCase();

  let score = 0;
  if (name === q || original === q) score += 100;
  if (name.includes(q) || original.includes(q)) score += 40;
  if (server.includes(q)) score += 20;
  if (description.includes(q)) score += 10;

  const tokens = q.split(/[\s_/.-]+/).filter((t) => t.length > 1);
  for (const token of tokens) {
    if (name.includes(token) || original.includes(token)) score += 8;
    if (server.includes(token)) score += 4;
    if (description.includes(token)) score += 2;
  }
  return score;
}

export function searchMcpTools(
  tools: MCPTool[],
  options: { query?: string; server?: string; limit?: number } = {}
): Array<{
  name: string;
  server: string;
  description: string;
  inputSchema: MCPTool['inputSchema'];
}> {
  const limit = Math.min(Math.max(1, options.limit ?? DEFAULT_SEARCH_LIMIT), MAX_SEARCH_LIMIT);
  const serverFilter = options.server?.trim().toLowerCase();
  const query = options.query?.trim() ?? '';

  let filtered = tools;
  if (serverFilter) {
    filtered = filtered.filter((tool) => tool.serverName.toLowerCase().includes(serverFilter));
  }

  if (query) {
    filtered = filtered
      .map((tool) => ({ tool, score: scoreToolMatch(tool, query) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
      .map((entry) => entry.tool);
  } else {
    filtered = [...filtered].sort((a, b) => a.name.localeCompare(b.name));
  }

  return filtered.slice(0, limit).map((tool) => ({
    name: tool.name,
    server: tool.serverName,
    description: tool.description || `MCP tool from ${tool.serverName}`,
    inputSchema: tool.inputSchema,
  }));
}

function summarizeDroppedByServer(mcpTools: MCPTool[]): string {
  const counts = new Map<string, number>();
  for (const tool of mcpTools) {
    counts.set(tool.serverName, (counts.get(tool.serverName) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([server, count]) => `${server}=${count}`)
    .join(', ');
}

function resolveAllowedMcpTools(
  mcpManager: MCPManager,
  allowedToolNames?: ReadonlySet<string> | null
): MCPTool[] {
  const all = mcpManager.getTools();
  if (!allowedToolNames || allowedToolNames.size === 0) {
    return all;
  }
  return all.filter((tool) => allowedToolNames.has(tool.name));
}

export function buildMcpMetaTools(
  mcpManager: MCPManager,
  allowedToolNames?: ReadonlySet<string> | null
): ToolDefinition[] {
  const searchTool: ToolDefinition<TSchema, unknown> = {
    name: MCP_SEARCH_TOOLS_NAME,
    label: 'Search MCP tools',
    description:
      'Search connected MCP tools by keyword and/or server name. Returns matching tool names, descriptions, and input schemas. Call this before mcp_call_tool when you need an MCP capability.',
    parameters: Type.Object({
      query: Type.Optional(
        Type.String({
          description:
            'Optional search text matched against tool name, description, and server (case-insensitive).',
        })
      ),
      server: Type.Optional(
        Type.String({
          description: 'Optional MCP server name filter (substring match, case-insensitive).',
        })
      ),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: MAX_SEARCH_LIMIT,
          description: `Max results to return (default ${DEFAULT_SEARCH_LIMIT}, max ${MAX_SEARCH_LIMIT}).`,
        })
      ),
    }),
    async execute(_toolCallId, params) {
      const { query, server, limit } = (params || {}) as {
        query?: string;
        server?: string;
        limit?: number;
      };
      const available = resolveAllowedMcpTools(mcpManager, allowedToolNames);
      const matches = searchMcpTools(available, { query, server, limit });
      const payload = {
        totalAvailable: available.length,
        returned: matches.length,
        tools: matches,
      };
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
        details: undefined,
      };
    },
  };

  const callTool: ToolDefinition<TSchema, unknown> = {
    name: MCP_CALL_TOOL_NAME,
    label: 'Call MCP tool',
    description:
      'Invoke a connected MCP tool by its exact model-facing name (as returned by mcp_search_tools). Pass arguments matching that tool input schema.',
    parameters: Type.Object({
      tool_name: Type.String({
        description: 'Exact MCP tool name, e.g. mcp__Launchpad__list_features.',
      }),
      arguments: Type.Optional(
        Type.Record(Type.String(), Type.Any(), {
          description: 'Arguments object for the MCP tool. Omit or pass {} when none are required.',
        })
      ),
    }),
    async execute(_toolCallId, params) {
      const { tool_name, arguments: toolArgs } = (params || {}) as {
        tool_name?: string;
        arguments?: Record<string, unknown>;
      };
      const toolName = typeof tool_name === 'string' ? tool_name.trim() : '';
      if (!toolName) {
        return {
          content: [{ type: 'text' as const, text: 'Error: tool_name is required.' }],
          details: undefined,
        };
      }
      const allowed = resolveAllowedMcpTools(mcpManager, allowedToolNames);
      if (!allowed.some((tool) => tool.name === toolName)) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error: MCP tool not found: ${toolName}. Use mcp_search_tools to find available tools.`,
            },
          ],
          details: undefined,
        };
      }
      try {
        const result = await mcpManager.callTool(
          toolName,
          toolArgs && typeof toolArgs === 'object' ? toolArgs : {}
        );
        const normalizedResult = normalizeMcpToolResultForModel(result);
        return {
          content: [{ type: 'text' as const, text: normalizedResult.text }],
          details:
            normalizedResult.images.length > 0
              ? { openCoworkImages: normalizedResult.images }
              : undefined,
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: `Error calling ${toolName}: ${message}` }],
          details: undefined,
        };
      }
    },
  };

  return [searchTool, callTool];
}

export function selectCustomToolsForModel(input: {
  api: string | undefined | null;
  builtInToolCount: number;
  mcpManager: MCPManager | null;
  mcpTools: ToolDefinition[];
  extensionTools: ToolDefinition[];
  /** When set, meta-tool search/call are restricted to these MCP tool names. */
  allowedToolNames?: ReadonlySet<string> | null;
}): SelectCustomToolsResult {
  const { api, builtInToolCount, mcpManager, mcpTools, extensionTools, allowedToolNames } = input;
  const mcpNames = mcpTools.map((t) => t.name);
  const totalIfFlat = builtInToolCount + mcpTools.length + extensionTools.length;

  const useMeta =
    needsOpenAIToolBudget(api) &&
    Boolean(mcpManager) &&
    mcpTools.length > 0 &&
    totalIfFlat > OPENAI_MAX_TOOLS;

  if (!useMeta || !mcpManager) {
    return {
      customTools: [...mcpTools, ...extensionTools],
      mode: 'flat',
      toolsSignature: buildMcpToolsSignature('flat', mcpNames),
    };
  }

  const metaTools = buildMcpMetaTools(mcpManager, allowedToolNames ?? new Set(mcpNames));
  const totalWithMeta = builtInToolCount + metaTools.length + extensionTools.length;
  const droppedSource =
    allowedToolNames && allowedToolNames.size > 0
      ? mcpManager.getTools().filter((tool) => allowedToolNames.has(tool.name))
      : mcpManager.getTools();
  log(
    `[McpToolBudget] OpenAI tool budget exceeded (${totalIfFlat} > ${OPENAI_MAX_TOOLS}). ` +
      `Switching to meta tools (${totalWithMeta} total). Dropped flat MCP tools by server: ` +
      summarizeDroppedByServer(droppedSource)
  );

  return {
    customTools: [...metaTools, ...extensionTools],
    mode: 'meta',
    toolsSignature: buildMcpToolsSignature('meta', mcpNames),
  };
}
