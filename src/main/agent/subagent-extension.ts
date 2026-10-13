import { Type } from '@sinclair/typebox';
import type {
  AgentRuntimeExtension,
  BeforeSessionRunResult,
  BeforeSessionRunContext,
  AgentRuntimeCustomTool,
} from '../extensions/agent-runtime-extension';
import { MCPManager } from '../mcp/mcp-manager';
import { configStore } from '../config/config-store';
import { logError } from '../utils/logger';
import { normalizeSubagentConfig } from '../../shared/subagent-config';
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
  agent?: string;
  result_format?: string;
  allowed_tools?: string[];
  timeout_seconds?: number;
  /** Default 'inherit' (parent quality model). Pass 'free' for cheap bulk fan-out. */
  model?: 'free' | 'inherit';
}

type SendEvent = (event: ServerEvent) => void;
type PermissionHandler = (toolName: string, toolInput: unknown) => Promise<'allow' | 'deny'>;

function textResult(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
    details: undefined as unknown,
  };
}

function createSpawnSubagentTool(
  mcpManager: MCPManager | null,
  sendEvent: SendEvent,
  parentSessionId: string,
  requestPermission: PermissionHandler | null,
  getParentAbortSignal: () => AbortSignal | null,
  concurrencyState: { active: number },
  division?: Partial<SessionDivisionFields> | null,
  cwd?: string | null,
  sandboxIsolated = false
): AgentRuntimeCustomTool {
  const config = configStore.getAll();
  let settings: ReturnType<typeof normalizeSubagentConfig> | null = null;
  if (!config.subagentConfigError) {
    try {
      settings = normalizeSubagentConfig(config.subagent);
    } catch {
      settings = null;
    }
  }

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
      agent: Type.Optional(
        Type.String({
          description: `Named role preset. Available: ${settings?.presets.map((preset) => preset.name).join(', ') || 'none'}. Default: ${settings?.defaultAgent || 'general'}.`,
        })
      ),
      result_format: Type.Optional(
        Type.String({
          description:
            'Description of the desired output format. If omitted, the child returns free-form text.',
        })
      ),
      allowed_tools: Type.Optional(
        Type.Array(Type.String(), {
          description:
            'Restrict MCP tools available to the child. Standard coding tools (read, write, edit, bash) stay available unless the role preset restricts them. If omitted, the child inherits all parent MCP tools.',
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
            'Child model routing. Default "inherit" (role preset / Settings > Subagents model, else the parent quality model). Use "free" for OpenRouter free / eco bulk work.',
        })
      ),
    }),
    async execute(_toolCallId: string, params: unknown) {
      const { task, agent, result_format, allowed_tools, timeout_seconds, model } = (params ||
        {}) as SubagentParams;

      if (!task || typeof task !== 'string' || task.trim().length === 0) {
        return textResult('Error: task parameter is required.');
      }

      if (task.length > MAX_CHILD_TASK_LENGTH) {
        return textResult(
          `Error: task exceeds maximum length (${MAX_CHILD_TASK_LENGTH} chars). Shorten the task description.`
        );
      }

      const currentConfig = configStore.getAll();
      if (sandboxIsolated || currentConfig.subagentConfigError) {
        if (currentConfig.subagentConfigError) {
          logError(
            '[SubagentExtension] Invalid subagent configuration:',
            currentConfig.subagentConfigError
          );
        }
        return textResult(
          sandboxIsolated
            ? 'Subagents are unavailable in sandbox sessions until child tools support sandbox isolation.'
            : 'Subagent configuration error. Repair it in Settings > Subagents.'
        );
      }
      const childConfig = normalizeSubagentConfig(currentConfig.subagent);
      const agentName = agent ?? childConfig.defaultAgent;
      const preset = childConfig.presets.find((candidate) => candidate.name === agentName);
      if (agentName && !preset) {
        return textResult(`Error: unknown subagent preset: ${agentName}`);
      }

      const timeoutMs = Math.min(
        (timeout_seconds || DEFAULT_CHILD_TIMEOUT_MS / 1000) * 1000,
        MAX_CHILD_TIMEOUT_MS
      );
      const presetTools = preset?.allowedTools;

      const result = await runChildAgentSession({
        task,
        resultFormat: result_format,
        rolePrompt: preset?.prompt,
        timeoutMs,
        modelMode: model === 'free' ? 'free' : 'inherit',
        modelOverride: preset?.model || childConfig.model || undefined,
        maxConcurrent: childConfig.maxConcurrent,
        includeCodingTools: true,
        includeReadOnlyTools: Boolean(presetTools),
        toolFilter: presetTools ? (name) => presetTools.includes(name) : undefined,
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
        cwd,
        usageFeature: 'subagent',
      });

      return textResult(result.text);
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
          context.session,
          context.session.cwd,
          context.sandboxIsolated ?? false
        ),
      ],
    };
  }
}
