/**
 * Parent-facing mcp_run tool — offloads MCP search→call to a free OpenRouter child.
 */
import { Type } from '@sinclair/typebox';
import type { ToolDefinition } from '@mariozechner/pi-coding-agent';
import type { MCPManager } from '../mcp/mcp-manager';
import type { ServerEvent } from '../../renderer/types';
import { MCP_RUN_TOOL_NAME } from './mcp-tool-budget';
import {
  DEFAULT_CHILD_TIMEOUT_MS,
  MAX_CHILD_TIMEOUT_MS,
  buildMcpRunChildSystemPrompt,
  childAgentConcurrency,
  runChildAgentSession,
  type ChildPermissionHandler,
} from './child-agent-session';

export interface BuildMcpRunToolOptions {
  mcpManager: MCPManager;
  allowedToolNames?: ReadonlySet<string> | null;
  sendEvent?: (event: ServerEvent) => void;
  parentSessionId?: string;
  requestPermission?: ChildPermissionHandler | null;
  getParentAbortSignal?: () => AbortSignal | null;
}

/**
 * Parent-facing meta tool: offload MCP discovery+invocation to a free child agent.
 */
export function buildMcpRunTool(options: BuildMcpRunToolOptions): ToolDefinition {
  const {
    mcpManager,
    allowedToolNames,
    sendEvent,
    parentSessionId,
    requestPermission,
    getParentAbortSignal,
  } = options;

  return {
    name: MCP_RUN_TOOL_NAME,
    label: 'Run MCP task',
    description:
      'Offload an MCP data/task goal to a free child agent. The child discovers tools with mcp_search_tools and invokes them with mcp_call_tool, then returns only distilled facts. Prefer this over guessing MCP tool names.',
    parameters: Type.Object({
      goal: Type.String({
        description:
          'Clear, self-contained description of what MCP data or action is needed. Include filters, IDs, and time ranges.',
      }),
      server: Type.Optional(
        Type.String({
          description: 'Optional MCP server name hint for the child (substring match).',
        })
      ),
      result_format: Type.Optional(
        Type.String({
          description:
            'Desired output shape for the distilled result (e.g. bullet list, JSON keys).',
        })
      ),
      timeout_seconds: Type.Optional(
        Type.Number({
          description: 'Maximum child execution time in seconds. Default: 120, max: 300.',
          minimum: 10,
          maximum: 300,
        })
      ),
    }),
    async execute(_toolCallId, params) {
      const { goal, server, result_format, timeout_seconds } = (params || {}) as {
        goal?: string;
        server?: string;
        result_format?: string;
        timeout_seconds?: number;
      };
      const goalText = typeof goal === 'string' ? goal.trim() : '';
      if (!goalText) {
        return {
          content: [{ type: 'text' as const, text: 'Error: goal parameter is required.' }],
          details: undefined,
        };
      }

      const timeoutMs = Math.min(
        (timeout_seconds || DEFAULT_CHILD_TIMEOUT_MS / 1000) * 1000,
        MAX_CHILD_TIMEOUT_MS
      );

      const allowedList =
        allowedToolNames && allowedToolNames.size > 0 ? [...allowedToolNames] : undefined;

      const result = await runChildAgentSession({
        task: goalText,
        resultFormat: result_format,
        systemPrompt: buildMcpRunChildSystemPrompt(goalText, {
          server,
          resultFormat: result_format,
        }),
        timeoutMs,
        modelMode: 'free',
        includeCodingTools: false,
        mcpToolsMode: 'meta-only',
        allowedTools: allowedList,
        mcpManager,
        sendEvent,
        parentSessionId,
        requestPermission: requestPermission ?? null,
        getParentAbortSignal,
        concurrencyState: childAgentConcurrency,
        emitProgress: Boolean(sendEvent && parentSessionId),
      });

      return {
        content: [{ type: 'text' as const, text: result.text }],
        details: undefined,
      };
    },
  } as ToolDefinition;
}
