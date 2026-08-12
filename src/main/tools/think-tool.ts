/**
 * Anthropic-style `think` scratchpad tool for mid-loop reasoning.
 * Does not fetch data or mutate state — only logs structured thought into the transcript.
 */
import { Type } from '@sinclair/typebox';
import type { AgentRuntimeCustomTool } from '../extensions/agent-runtime-extension';

export const THINK_TOOL_NAME = 'think';

export function createThinkTool(): AgentRuntimeCustomTool {
  return {
    name: THINK_TOOL_NAME,
    label: 'Think',
    description:
      'Scratchpad for structured mid-loop reasoning. Does not obtain new information or change any system. Use after dense tool results or before branching in a long tool chain. Prefer Goal → Evidence → Decision → Next action. Then call the next real tool.',
    parameters: Type.Object({
      thought: Type.String({
        description:
          'Structured scratchpad (Goal / Evidence / Decision / Next). No hedging about task difficulty.',
      }),
    }),
    async execute(_toolCallId, params) {
      const thought =
        typeof (params as { thought?: unknown })?.thought === 'string'
          ? (params as { thought: string }).thought.trim()
          : '';
      return {
        content: [
          {
            type: 'text' as const,
            text: thought ? 'Thought logged.' : 'Thought logged (empty).',
          },
        ],
        details: thought ? { thought } : undefined,
      };
    },
  };
}

/** Append think tool and bump tools signature when Thinking mode is on. */
export function withThinkToolIfEnabled(
  enableThinking: boolean,
  tools: AgentRuntimeCustomTool[],
  toolsSignature: string
): { customTools: AgentRuntimeCustomTool[]; toolsSignature: string } {
  if (!enableThinking) {
    return { customTools: tools, toolsSignature };
  }
  const withoutDup = tools.filter((t) => t.name !== THINK_TOOL_NAME);
  return {
    customTools: [...withoutDup, createThinkTool()],
    toolsSignature: `${toolsSignature}|${THINK_TOOL_NAME}`,
  };
}
