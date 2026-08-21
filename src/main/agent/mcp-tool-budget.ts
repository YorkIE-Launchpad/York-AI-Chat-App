/**
 * @module main/agent/mcp-tool-budget
 *
 * OpenAI-compatible APIs reject requests with more than 128 tools.
 * Anthropic accepts large tool sets but each schema burns context tokens.
 * When the flattened set exceeds the relevant budget, expose
 * mcp_search_tools + mcp_call_tool so the parent (and children) discover and
 * invoke MCP tools without listing every flat tool.
 */
import { Type, type TSchema } from '@sinclair/typebox';
import type { ToolDefinition } from '@mariozechner/pi-coding-agent';
import type { MCPManager, MCPTool } from '../mcp/mcp-manager';
import { applyProjectScopedMcpResultFilter } from '../../shared/project-mcp-scope';
import { prepareCompanyProjectScopedMcpArgs as prepareProjectScopedMcpArgs } from '../../shared/company-project-mcp-scope';
import type { OnProjectScopeViolation } from '../../shared/project-mcp-scope';
import type { SessionDivisionFields } from '../../shared/workspace-division';
import { log } from '../utils/logger';
import { normalizeMcpToolResultForModel } from './tool-result-utils';
import {
  augmentMcpToolDescription,
  compressToolResultTextForModel,
  leanMcpToolArgs,
} from './mcp-tool-payload';
import { emitProjectScopeBlock } from './project-scope-violation';
import {
  MCP_WRITE_DISABLED_MESSAGE,
  isMcpWriteAccessDenied,
} from '../config/mcp-write-access-store';
import type { OnLaunchPadProgressRecord } from './launchpad-turn-progress';
export const OPENAI_MAX_TOOLS = 128;
/**
 * Anthropic has no hard tool-count cap, but full MCP schemas routinely cost
 * tens of thousands of tokens. Switch to meta tools once the flat set exceeds
 * this threshold (built-ins + MCP + extensions).
 */
export const ANTHROPIC_MCP_META_THRESHOLD = 32;
export const MCP_SEARCH_TOOLS_NAME = 'mcp_search_tools';
export const MCP_CALL_TOOL_NAME = 'mcp_call_tool';
export const MCP_RUN_TOOL_NAME = 'mcp_run';
export const MCP_META_TOOL_BEHAVIOR = `<tool_behavior>
MCP tool access (budget mode):
- Connected MCP servers expose too many tools to list directly for this model API.
- Use mcp_search_tools to find tools by keyword and/or server, then mcp_call_tool with the exact tool name and arguments.
- After mcp_search_tools returns matches, you MUST immediately call mcp_call_tool in the same turn with the exact name and arguments. Do not end the turn with only a plan or thinking after discovery.
- Prefer a tight query and/or server filter, and a small limit, so search results stay short.
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

export type McpSearchParamSummary = {
  name: string;
  required: boolean;
};

export type McpSearchToolHit = {
  name: string;
  server: string;
  description: string;
  parameters: McpSearchParamSummary[];
  inputSchema?: MCPTool['inputSchema'];
};

export function needsOpenAIToolBudget(api: string | undefined | null): boolean {
  return api === 'openai-completions' || api === 'openai-responses';
}

export function needsAnthropicToolBudget(api: string | undefined | null): boolean {
  return api === 'anthropic-messages';
}

/**
 * Max flat tools before switching to mcp_search_tools + mcp_call_tool.
 * OpenAI: hard 128 API limit. Anthropic: softer context-token threshold.
 */
export function toolBudgetLimitForApi(api: string | undefined | null): number | null {
  if (needsOpenAIToolBudget(api)) return OPENAI_MAX_TOOLS;
  if (needsAnthropicToolBudget(api)) return ANTHROPIC_MCP_META_THRESHOLD;
  return null;
}

export function buildMcpToolsSignature(mode: McpToolExposureMode, mcpToolNames: string[]): string {
  // Meta mode only exposes search+call; underlying MCP catalog changes must not
  // recreate the pi session (that dumps cold-start history and busts prompt cache).
  if (mode === 'meta') {
    return 'meta';
  }
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

function summarizeInputParams(
  inputSchema: MCPTool['inputSchema'] | undefined
): McpSearchParamSummary[] {
  const schema = inputSchema as
    | { properties?: Record<string, unknown>; required?: string[] }
    | undefined;
  const properties = schema?.properties ?? {};
  const required = new Set(schema?.required ?? []);
  return Object.keys(properties)
    .sort()
    .map((name) => ({ name, required: required.has(name) }));
}

export function searchMcpTools(
  tools: MCPTool[],
  options: {
    query?: string;
    server?: string;
    limit?: number;
    /** When true, include full JSON Schema per tool. Default: lean params only. */
    includeSchema?: boolean;
  } = {}
): McpSearchToolHit[] {
  const limit = Math.min(Math.max(1, options.limit ?? DEFAULT_SEARCH_LIMIT), MAX_SEARCH_LIMIT);
  const serverFilter = options.server?.trim().toLowerCase();
  const query = options.query?.trim() ?? '';
  const includeSchema = Boolean(options.includeSchema);

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

  return filtered.slice(0, limit).map((tool) => {
    const hit: McpSearchToolHit = {
      name: tool.name,
      server: tool.serverName,
      description: augmentMcpToolDescription(
        tool.name,
        tool.description || `MCP tool from ${tool.serverName}`
      ),
      parameters: summarizeInputParams(tool.inputSchema),
    };
    if (includeSchema) {
      hit.inputSchema = tool.inputSchema;
    }
    return hit;
  });
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

/**
 * Meta tools: search + call (parent and children when over the OpenAI tool budget).
 */
export function buildMcpMetaTools(
  mcpManager: MCPManager,
  allowedToolNames?: ReadonlySet<string> | null,
  division?: Partial<SessionDivisionFields> | null,
  onProjectScopeViolation?: OnProjectScopeViolation | null,
  sessionId?: string | null,
  onLaunchPadProgress?: OnLaunchPadProgressRecord | null
): ToolDefinition[] {
  const searchTool: ToolDefinition<TSchema, unknown> = {
    name: MCP_SEARCH_TOOLS_NAME,
    label: 'Search MCP tools',
    description:
      'Search connected MCP tools by keyword and/or server name. Returns matching tool names, descriptions, and parameter summaries. Pass include_schema=true only when you need full JSON Schema before calling. Call this before mcp_call_tool when you need an MCP capability. After results return, immediately call mcp_call_tool in the same turn — do not stop after searching. Prefer a tight query/server and a small limit.',
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
      include_schema: Type.Optional(
        Type.Boolean({
          description:
            'When true, include full inputSchema for each match. Default false (parameter names + required only).',
        })
      ),
    }),
    async execute(_toolCallId, params) {
      const { query, server, limit, include_schema } = (params || {}) as {
        query?: string;
        server?: string;
        limit?: number;
        include_schema?: boolean;
      };
      const available = resolveAllowedMcpTools(mcpManager, allowedToolNames);
      const matches = searchMcpTools(available, {
        query,
        server,
        limit,
        includeSchema: include_schema,
      });
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
        description: 'Exact MCP tool name, e.g. mcp__R_D_Launchpad__list_features.',
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
      if (isMcpWriteAccessDenied(toolName)) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error: ${MCP_WRITE_DISABLED_MESSAGE}`,
            },
          ],
          details: undefined,
        };
      }
      try {
        const matched = allowed.find((tool) => tool.name === toolName);
        const leanArgs = leanMcpToolArgs(
          toolArgs && typeof toolArgs === 'object' ? toolArgs : {},
          matched?.inputSchema
        );
        const prepared = prepareProjectScopedMcpArgs(toolName, leanArgs, division);
        if (prepared.kind === 'block') {
          emitProjectScopeBlock(onProjectScopeViolation, prepared, toolName, division, sessionId);
          onLaunchPadProgress?.({
            toolName,
            args: leanArgs,
            resultText: prepared.message,
            isError: true,
          });
          return {
            content: [{ type: 'text' as const, text: prepared.message }],
            details: undefined,
          };
        }
        const result = await mcpManager.callTool(toolName, prepared.args);
        const normalizedResult = normalizeMcpToolResultForModel(result, {
          compress: !prepared.filterResult,
        });
        const text = prepared.filterResult
          ? compressToolResultTextForModel(
              applyProjectScopedMcpResultFilter(toolName, normalizedResult.text, division)
            )
          : normalizedResult.text;
        onLaunchPadProgress?.({
          toolName,
          args: prepared.args,
          resultText: text,
          isError: false,
        });
        return {
          content: [{ type: 'text' as const, text }],
          details:
            normalizedResult.images.length > 0
              ? { openCoworkImages: normalizedResult.images }
              : undefined,
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        onLaunchPadProgress?.({
          toolName,
          args: toolArgs && typeof toolArgs === 'object' ? toolArgs : {},
          resultText: `Error calling ${toolName}: ${message}`,
          isError: true,
        });
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
  /** When set, meta-tool search/call/run are restricted to these MCP tool names. */
  allowedToolNames?: ReadonlySet<string> | null;
  /**
   * Optional override tools for meta mode. When omitted (or useSearchCallMeta is true),
   * meta mode uses mcp_search_tools + mcp_call_tool.
   */
  parentMetaTools?: ToolDefinition[];
  /**
   * When true, meta mode uses mcp_search_tools + mcp_call_tool instead of parentMetaTools.
   * Parent and child sessions both prefer this path for lower latency.
   */
  useSearchCallMeta?: boolean;
  /** Parent session workspace division — hard-scopes Hub project MCP calls. */
  division?: Partial<SessionDivisionFields> | null;
  /** Fired when a Hub project tool is blocked for out-of-scope project access. */
  onProjectScopeViolation?: OnProjectScopeViolation | null;
  sessionId?: string | null;
  /** Records LaunchPad start/poll MCP calls for incomplete-turn wait/continue. */
  onLaunchPadProgress?: OnLaunchPadProgressRecord | null;
}): SelectCustomToolsResult {
  const {
    api,
    builtInToolCount,
    mcpManager,
    mcpTools,
    extensionTools,
    allowedToolNames,
    parentMetaTools,
    useSearchCallMeta,
    division,
    onProjectScopeViolation,
    sessionId,
    onLaunchPadProgress,
  } = input;
  const mcpNames = mcpTools.map((t) => t.name);
  const totalIfFlat = builtInToolCount + mcpTools.length + extensionTools.length;
  const budgetLimit = toolBudgetLimitForApi(api);

  const useMeta =
    budgetLimit != null &&
    Boolean(mcpManager) &&
    mcpTools.length > 0 &&
    totalIfFlat > budgetLimit;

  if (!useMeta || !mcpManager) {
    return {
      customTools: [...mcpTools, ...extensionTools],
      mode: 'flat',
      toolsSignature: buildMcpToolsSignature('flat', mcpNames),
    };
  }

  const allowSet = allowedToolNames ?? new Set(mcpNames);
  let metaTools: ToolDefinition[];
  if (useSearchCallMeta || !parentMetaTools || parentMetaTools.length === 0) {
    metaTools = buildMcpMetaTools(
      mcpManager,
      allowSet,
      division,
      onProjectScopeViolation,
      sessionId,
      onLaunchPadProgress
    );
  } else {
    metaTools = parentMetaTools;
  }

  const totalWithMeta = builtInToolCount + metaTools.length + extensionTools.length;
  const droppedSource =
    allowedToolNames && allowedToolNames.size > 0
      ? mcpManager.getTools().filter((tool) => allowedToolNames.has(tool.name))
      : mcpManager.getTools();
  const budgetLabel = needsOpenAIToolBudget(api)
    ? 'OpenAI tool budget'
    : 'Anthropic MCP schema budget';
  log(
    `[McpToolBudget] ${budgetLabel} exceeded (${totalIfFlat} > ${budgetLimit}). ` +
      `Switching to meta tools (${totalWithMeta} total: ${metaTools.map((t) => t.name).join(', ')}). ` +
      `Dropped flat MCP tools by server: ${summarizeDroppedByServer(droppedSource)}`
  );

  return {
    customTools: [...metaTools, ...extensionTools],
    mode: 'meta',
    toolsSignature: buildMcpToolsSignature('meta', mcpNames),
  };
}
