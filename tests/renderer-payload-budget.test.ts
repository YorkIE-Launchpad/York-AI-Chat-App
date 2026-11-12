import { describe, expect, it } from 'vitest';
import type { Message } from '../src/renderer/types';
import {
  RENDERER_PAYLOAD_LIMITS,
  boundMessagesForRenderer,
  slimServerEventForRenderer,
} from '../src/shared/renderer-payload-budget';

function toolImageMessage(id: string, data: string): Message {
  return {
    id,
    sessionId: 's1',
    role: 'assistant',
    content: [
      {
        type: 'tool_result',
        toolUseId: id,
        content: 'captured',
        images: [{ data, mimeType: 'image/png' }],
      },
    ],
    timestamp: 1,
  };
}

describe('renderer payload budget', () => {
  it('drops oversized tool screenshots and keeps only the newest few', () => {
    const huge = 'A'.repeat(RENDERER_PAYLOAD_LIMITS.toolImageChars + 10);
    const small = 'B'.repeat(100);
    const messages = [
      toolImageMessage('old-huge', huge),
      ...Array.from({ length: RENDERER_PAYLOAD_LIMITS.keptToolImages + 2 }, (_, index) =>
        toolImageMessage(`shot-${index}`, small + index)
      ),
    ];

    const bounded = boundMessagesForRenderer(messages);
    const kept = bounded.flatMap((message) =>
      message.content.flatMap((block) =>
        block.type === 'tool_result' && block.images ? block.images.map((image) => image.data) : []
      )
    );

    expect(kept).toHaveLength(RENDERER_PAYLOAD_LIMITS.keptToolImages);
    expect(kept.some((data) => data === huge)).toBe(false);
    expect(bounded[0]?.content[0]).toMatchObject({
      type: 'tool_result',
      content: expect.stringContaining('screenshot omitted from chat view'),
    });
  });

  it('truncates a giant tool result string before it reaches the helper', () => {
    const message = toolImageMessage('text', 'x');
    message.content = [
      {
        type: 'tool_result',
        toolUseId: 'text',
        content: 'Q'.repeat(RENDERER_PAYLOAD_LIMITS.toolResultChars + 5_000),
      },
    ];

    const [bounded] = boundMessagesForRenderer([message]);
    const block = bounded?.content[0];
    expect(block?.type).toBe('tool_result');
    if (block?.type !== 'tool_result') return;
    expect(block.content.length).toBeLessThanOrEqual(RENDERER_PAYLOAD_LIMITS.toolResultChars);
    expect(block.content).toContain('truncated for chat view');
  });

  it('does not rewrite a normal stream event', () => {
    const event = {
      type: 'stream.partial' as const,
      payload: { sessionId: 's1', delta: 'hello' },
    };
    expect(slimServerEventForRenderer(event)).toBe(event);
  });

  it('caps a single partial delta before IPC', () => {
    const event = {
      type: 'stream.partial' as const,
      payload: {
        sessionId: 's1',
        delta: 'z'.repeat(RENDERER_PAYLOAD_LIMITS.partialDeltaChars + 100),
      },
    };
    const slimmed = slimServerEventForRenderer(event);
    if (slimmed.type !== 'stream.partial') throw new Error('expected partial');
    expect(slimmed.payload.delta.length).toBe(RENDERER_PAYLOAD_LIMITS.partialDeltaChars);
  });
});
