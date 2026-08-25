/**
 * @module main/tools/web-search-extension
 *
 * First-party `websearch` tool so the agent can find URLs without Chrome MCP.
 * Follow with `webfetch` to read page content.
 */
import { Type } from '@sinclair/typebox';
import type {
  AgentRuntimeExtension,
  BeforeSessionRunResult,
  AgentRuntimeCustomTool,
} from '../extensions/agent-runtime-extension';
import { searchWeb } from './web-search';

function createWebSearchTool(): AgentRuntimeCustomTool {
  return {
    name: 'websearch',
    label: 'WebSearch',
    description:
      'Search the public web and return titles, snippets, and URLs. ' +
      'Use this for current events, unknown facts, and finding sources. ' +
      'After search, call webfetch on the best http/https URLs. ' +
      'Do not use Chrome MCP for ordinary research (Chrome is for interactive login/click flows only).',
    parameters: Type.Object({
      query: Type.String({
        description: 'Search query string.',
      }),
    }),
    async execute(_toolCallId: string, params: unknown) {
      const { query } = (params || {}) as { query?: string };
      try {
        const text = await searchWeb(query ?? '');
        return {
          content: [{ type: 'text' as const, text }],
          details: undefined,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text' as const, text: `Error: ${message}` }],
          details: undefined,
        };
      }
    },
  };
}

export class WebSearchExtension implements AgentRuntimeExtension {
  readonly name = 'websearch';

  async beforeSessionRun(): Promise<BeforeSessionRunResult> {
    return {
      customTools: [createWebSearchTool()],
    };
  }
}
