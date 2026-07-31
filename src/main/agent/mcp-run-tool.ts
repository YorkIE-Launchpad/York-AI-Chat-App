/**
 * Parent-facing mcp_run tool — offloads MCP search→call to a free OpenRouter child.
 */
import { Type } from '@sinclair/typebox';
import type { ToolDefinition } from '@mariozechner/pi-coding-agent';
import type { MCPManager } from '../mcp/mcp-manager';
import type { ServerEvent } from '../../renderer/types';
import type { SessionDivisionFields } from '../../shared/workspace-division';
import { MCP_RUN_TOOL_NAME } from './mcp-tool-budget';
import {
  buildMcpRunChildSystemPrompt,
  childAgentConcurrency,
  runChildAgentSession,
  type ChildPermissionHandler,
} from './child-agent-session';
import { resolveMcpRunTimeoutMs } from './mcp-run-timeout';

export interface BuildMcpRunToolOptions {
  mcpManager: MCPManager;
  allowedToolNames?: ReadonlySet<string> | null;
  sendEvent?: (event: ServerEvent) => void;
  parentSessionId?: string;
  requestPermission?: ChildPermissionHandler | null;
  getParentAbortSignal?: () => AbortSignal | null;
  /** Parent session workspace division — General is OpenRouter-only. */
  division?: Partial<SessionDivisionFields> | null;
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
    division,
  } = options;

  return {
    name: MCP_RUN_TOOL_NAME,
    label: 'Run MCP task',
    description:
      'Offload an MCP data/task goal to a free child agent. The child discovers tools with mcp_search_tools and invokes them with mcp_call_tool, then returns only distilled facts. Prefer this over guessing MCP tool names. For Jira/Confluence/Atlassian, pass server (e.g. "Confluence") and timeout_seconds: 240 (up to 300 for large pages); keep goals narrow (single page/issue).',
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
          description:
            'Maximum child execution time in seconds. Default: 120 (240 for Jira/Confluence/Atlassian), max: 300.',
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

      const timeoutMs = resolveMcpRunTimeoutMs({
        goal: goalText,
        server,
        timeoutSeconds: timeout_seconds,
      });

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
        division,
      });

      return {
        content: [{ type: 'text' as const, text: result.text }],
        details: undefined,
      };
    },
  } as ToolDefinition;
}
