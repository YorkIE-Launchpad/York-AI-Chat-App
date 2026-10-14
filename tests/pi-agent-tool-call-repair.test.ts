import { describe, expect, it } from 'vitest';
import { runAgentLoop } from '@mariozechner/pi-agent-core';
import { createAssistantMessageEventStream, Type } from '@mariozechner/pi-ai';

type ToolCallSpec = { name: string; arguments: Record<string, unknown> };

const model = {
  id: 'fake',
  name: 'fake',
  api: 'openai-completions',
  provider: 'fake',
  baseUrl: '',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8000,
  maxTokens: 1000,
};

function assistant(content: unknown[], stopReason: string) {
  return {
    role: 'assistant',
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

/** Scripted model: first reply is the given tool call, second reply is plain text. */
function scriptedStream(firstCall: ToolCallSpec) {
  let turn = 0;
  return () => {
    const stream = createAssistantMessageEventStream();
    const msg =
      turn++ === 0
        ? assistant([{ type: 'toolCall', id: 'call_1', ...firstCall }], 'toolUse')
        : assistant([{ type: 'text', text: 'done' }], 'stop');
    queueMicrotask(() => stream.push({ type: 'done', reason: msg.stopReason, message: msg }));
    return stream;
  };
}

async function runWith(firstCall: ToolCallSpec) {
  const executed: Array<Record<string, unknown>> = [];
  const tool = {
    name: 'mcp_call_tool',
    label: 'mcp_call_tool',
    description: 'call an MCP tool',
    parameters: Type.Object({ name: Type.String() }, { additionalProperties: true }),
    execute: async (_id: string, params: Record<string, unknown>) => {
      executed.push(params);
      return { content: [{ type: 'text', text: 'ok' }], details: {} };
    },
  };
  const messages = await runAgentLoop(
    [{ role: 'user', content: [{ type: 'text', text: 'go' }], timestamp: Date.now() }],
    { systemPrompt: '', messages: [], tools: [tool] } as never,
    { model, convertToLlm: (m: unknown[]) => m } as never,
    async () => {},
    undefined,
    scriptedStream(firstCall) as never
  );
  const toolResult = messages.find((m) => (m as { role: string }).role === 'toolResult') as {
    isError: boolean;
    toolName: string;
    content: Array<{ text: string }>;
  };
  return { executed, toolResult };
}

describe('pi-agent-core tool-call repair (patch)', () => {
  it('repairs case / whitespace / functions. prefix', async () => {
    const { executed, toolResult } = await runWith({
      name: ' functions.MCP_Call_Tool ',
      arguments: { name: 'x' },
    });
    expect(executed).toEqual([{ name: 'x' }]);
    expect(toolResult.isError).toBe(false);
    expect(toolResult.toolName).toBe('mcp_call_tool');
  });

  it('unwraps an empty-name call carrying { name, arguments }', async () => {
    const { executed, toolResult } = await runWith({
      name: '',
      arguments: { name: 'mcp_call_tool', arguments: { name: 'hub_list' } },
    });
    expect(executed).toEqual([{ name: 'hub_list' }]);
    expect(toolResult.isError).toBe(false);
  });

  it('returns a retry instruction listing tools when unrepairable', async () => {
    const { executed, toolResult } = await runWith({ name: '', arguments: {} });
    expect(executed).toEqual([]);
    expect(toolResult.isError).toBe(true);
    expect(toolResult.content[0].text).toContain('the tool name was empty');
    expect(toolResult.content[0].text).toContain('Retry now');
    expect(toolResult.content[0].text).toContain('mcp_call_tool');
  });
});
