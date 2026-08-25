import { Type } from '@sinclair/typebox';
import type {
  AgentRuntimeExtension,
  BeforeSessionRunResult,
  BeforeSessionRunContext,
  AgentRuntimeCustomTool,
} from '../extensions/agent-runtime-extension';
import { MCPManager } from '../mcp/mcp-manager';
import type { ServerEvent } from '../../renderer/types';
import {
  DEFAULT_CHILD_TIMEOUT_MS,
  MAX_CHILD_TIMEOUT_MS,
  MAX_CHILD_TASK_LENGTH,
  childAgentConcurrency,
  runChildAgentSession,
} from './child-agent-session';
import type { SessionDivisionFields } from '../../shared/workspace-division';

interface SubagentParams {
  task: string;
  result_format?: string;
  allowed_tools?: string[];
  timeout_seconds?: number;
  /** Default 'inherit' (parent quality model). Pass 'free' for cheap bulk fan-out. */
  model?: 'free' | 'inherit';
}

type SendEvent = (event: ServerEvent) => void;
type PermissionHandler = (toolName: string, toolInput: unknown) => Promise<'allow' | 'deny'>;

function createSpawnSubagentTool(
  mcpManager: MCPManager | null,
  sendEvent: SendEvent,
  parentSessionId: string,
  requestPermission: PermissionHandler | null,
  getParentAbortSignal: () => AbortSignal | null,
  concurrencyState: { active: number },
  division?: Partial<SessionDivisionFields> | null
): AgentRuntimeCustomTool {
  return {
    name: 'spawn_subagent',
    label: 'spawn_subagent',
    description:
      'Spawn a child agent only when you need isolated context or true parallel sub-tasks. ' +
      'Prefer completing MCP and routine work yourself with available tools (including mcp_search_tools / mcp_call_tool) — ' +
      'child agents add latency. The child inherits your tools but not conversation history and cannot spawn further subagents. ' +
      'Default model is the parent quality model. Pass model="free" only for cheap bulk fan-out.',
    parameters: Type.Object({
      task: Type.String({
        description:
          'A clear, self-contained description of what the child agent should accomplish. ' +
          'Include all necessary context since the child has no access to your conversation.',
      }),
      result_format: Type.Optional(
        Type.String({
          description:
            'Description of the desired output format. If omitted, the child returns free-form text.',
        })
      ),
      allowed_tools: Type.Optional(
        Type.Array(Type.String(), {
          description:
            'Restrict MCP tools available to the child. Standard coding tools (read, write, edit, bash) are always available. If omitted, the child inherits all parent MCP tools.',
        })
      ),
      timeout_seconds: Type.Optional(
        Type.Number({
          description: 'Maximum execution time in seconds. Default: 120, max: 300.',
          minimum: 10,
          maximum: 300,
        })
      ),
      model: Type.Optional(
        Type.Union([Type.Literal('free'), Type.Literal('inherit')], {
          description:
            'Child model routing. Default "inherit" (parent quality model). Use "free" for OpenRouter free / eco bulk work.',
        })
      ),
    }),
    async execute(_toolCallId: string, params: unknown) {
      const { task, result_format, allowed_tools, timeout_seconds, model } = (params ||
        {}) as SubagentParams;

      if (!task || typeof task !== 'string' || task.trim().length === 0) {
        return {
          content: [{ type: 'text' as const, text: 'Error: task parameter is required.' }],
          details: undefined as unknown,
        };
      }

      if (task.length > MAX_CHILD_TASK_LENGTH) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error: task exceeds maximum length (${MAX_CHILD_TASK_LENGTH} chars). Shorten the task description.`,
            },
          ],
          details: undefined as unknown,
        };
      }

      const timeoutMs = Math.min(
        (timeout_seconds || DEFAULT_CHILD_TIMEOUT_MS / 1000) * 1000,
        MAX_CHILD_TIMEOUT_MS
      );

      const result = await runChildAgentSession({
        task,
        resultFormat: result_format,
        timeoutMs,
        modelMode: model === 'free' ? 'free' : 'inherit',
        includeCodingTools: true,
        mcpToolsMode: 'flat',
        allowedTools: allowed_tools,
        mcpManager,
        sendEvent,
        parentSessionId,
        requestPermission,
        getParentAbortSignal,
        concurrencyState,
        emitProgress: true,
        division,
        usageFeature: 'subagent',
      });

      return {
        content: [{ type: 'text' as const, text: result.text }],
        details: undefined as unknown,
      };
    },
  };
}

export class SubagentExtension implements AgentRuntimeExtension {
  readonly name = 'subagent';
  private concurrencyState = childAgentConcurrency;

  constructor(
    private readonly getMcpManager: () => MCPManager | null,
    private readonly sendEvent: SendEvent,
    private readonly requestPermission: PermissionHandler | null = null,
    private readonly getParentAbortSignal: () => AbortSignal | null = () => null
  ) {}

  async beforeSessionRun(context: BeforeSessionRunContext): Promise<BeforeSessionRunResult> {
    return {
      customTools: [
        createSpawnSubagentTool(
          this.getMcpManager(),
          this.sendEvent,
          context.session.id,
          this.requestPermission,
          this.getParentAbortSignal,
          this.concurrencyState,
          context.session
        ),
      ],
    };
  }
}
