/**
 * @module main/tools/web-fetch-extension
 *
 * Agent runtime extension that exposes a first-party `webfetch` tool so the
 * agent can read http/https page content in-process without launching Chrome.
 */
import { Type } from '@sinclair/typebox';
import type {
  AgentRuntimeExtension,
  BeforeSessionRunResult,
  AgentRuntimeCustomTool,
} from '../extensions/agent-runtime-extension';
import { fetchWebPage } from './web-fetch';

function createWebFetchTool(): AgentRuntimeCustomTool {
  return {
    name: 'webfetch',
    label: 'webfetch',
    description:
      'Fetch a web page over HTTP/HTTPS and return its text/HTML content for research. ' +
      'Use this for reading page content without opening a browser. Prefer Chrome MCP tools ' +
      '(mcp__Chrome__*) only when interactive navigation, clicking, screenshots, or login flows are needed.',
    parameters: Type.Object({
      url: Type.String({
        description: 'The http or https URL to fetch.',
      }),
    }),
    async execute(_toolCallId: string, params: unknown) {
      const { url } = (params || {}) as { url?: string };
      try {
        const text = await fetchWebPage(url ?? '');
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

export class WebFetchExtension implements AgentRuntimeExtension {
  readonly name = 'webfetch';

  async beforeSessionRun(): Promise<BeforeSessionRunResult> {
    return {
      customTools: [createWebFetchTool()],
    };
  }
}
