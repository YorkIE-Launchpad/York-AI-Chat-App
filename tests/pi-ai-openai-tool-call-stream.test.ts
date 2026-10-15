import { afterEach, describe, expect, it, vi } from 'vitest';
import { streamOpenAICompletions } from '@mariozechner/pi-ai';

const model = {
  id: 'Qwen3.8-Flash-Next',
  name: 'York LLM',
  api: 'openai-completions',
  provider: 'york-llm',
  baseUrl: 'http://llm.test/v1',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8000,
  maxTokens: 1000,
};

function sseResponse(deltas: Array<Record<string, unknown>>): Response {
  const lines = deltas.map(
    (delta, i) =>
      `data: ${JSON.stringify({
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        created: 0,
        model: model.id,
        choices: [
          { index: 0, delta, finish_reason: i === deltas.length - 1 ? 'tool_calls' : null },
        ],
      })}\n\n`
  );
  const body = lines.join('') + 'data: [DONE]\n\n';
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

const call = (index: number, extra: Record<string, unknown>) => ({
  tool_calls: [{ index, ...extra }],
});

async function collect(deltas: Array<Record<string, unknown>>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => sseResponse(deltas))
  );
  const stream = streamOpenAICompletions(
    model as never,
    {
      messages: [{ role: 'user', content: 'go', timestamp: 0 }],
      tools: [{ name: 'get_weather', description: '', parameters: { type: 'object' } }],
    } as never,
    { apiKey: 'k' }
  );
  for await (const event of stream) {
    if (event.type === 'done') return event.message;
    if (event.type === 'error') throw new Error(event.error.errorMessage);
  }
  throw new Error('stream ended without done');
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('pi-ai openai-completions tool-call streaming (patch)', () => {
  it('routes deltas by index when content chunks interleave mid-call', async () => {
    const message = await collect([
      call(0, { id: 'call_a', type: 'function', function: { name: 'get_weather', arguments: '' } }),
      call(0, { function: { arguments: '{"city":"' } }),
      call(0, { function: { arguments: 'Paris"' } }),
      { content: '\n' },
      call(0, { function: { arguments: '}' } }),
      call(1, { id: 'call_b', type: 'function', function: { name: 'get_weather', arguments: '' } }),
      call(1, { function: { arguments: '{"city":"' } }),
      { content: '\n' },
      call(1, { function: { arguments: 'London"}' } }),
    ]);

    const toolCalls = message.content.filter((b: { type: string }) => b.type === 'toolCall');
    expect(toolCalls).toEqual([
      { type: 'toolCall', id: 'call_a', name: 'get_weather', arguments: { city: 'Paris' } },
      { type: 'toolCall', id: 'call_b', name: 'get_weather', arguments: { city: 'London' } },
    ]);
  });

  it('starts a new call for a new index even without an id', async () => {
    const message = await collect([
      call(0, { id: 'call_a', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }),
      call(1, { function: { name: 'get_weather', arguments: '{"city":"Rome"}' } }),
    ]);

    const toolCalls = message.content.filter((b: { type: string }) => b.type === 'toolCall');
    expect(toolCalls.map((b: { arguments: unknown }) => b.arguments)).toEqual([
      { city: 'Paris' },
      { city: 'Rome' },
    ]);
  });

  it('ignores empty tool-call deltas that carry nothing', async () => {
    const message = await collect([{ content: 'hi' }, call(0, { function: { arguments: '' } })]);

    expect(message.content.filter((b: { type: string }) => b.type === 'toolCall')).toEqual([]);
  });
});
