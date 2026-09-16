import { describe, expect, it, vi } from 'vitest';
import type { ContentBlock } from '../../renderer/types';
import { runGptImageGeneration } from '../../main/images/image-generation-service';
import { GPT_IMAGE_25_FLARE } from '../../shared/image-generation';

describe('runGptImageGeneration', () => {
  it('calls images.generate when no input images', async () => {
    const generate = vi.fn().mockResolvedValue({
      data: [{ b64_json: 'abc123' }],
      usage: { input_tokens: 10, output_tokens: 20 },
    });
    const edit = vi.fn();

    const result = await runGptImageGeneration({
      modelId: GPT_IMAGE_25_FLARE,
      prompt: 'A red apple',
      sessionId: 'sess-1',
      client: { generate, edit },
    });

    expect(generate).toHaveBeenCalledOnce();
    expect(edit).not.toHaveBeenCalled();
    expect(result.base64).toBe('abc123');
    expect(result.mediaType).toBe('image/png');
  });

  it('calls images.edit when input images are present', async () => {
    const generate = vi.fn();
    const edit = vi.fn().mockResolvedValue({
      data: [{ b64_json: 'edited' }],
    });
    const content: ContentBlock[] = [
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: Buffer.from('png').toString('base64'),
        },
      },
      { type: 'text', text: 'Make it blue' },
    ];

    const result = await runGptImageGeneration({
      modelId: GPT_IMAGE_25_FLARE,
      prompt: 'Make it blue',
      content,
      sessionId: 'sess-2',
      client: { generate, edit },
    });

    expect(edit).toHaveBeenCalledOnce();
    expect(generate).not.toHaveBeenCalled();
    expect(result.base64).toBe('edited');
  });

  it('rejects unsupported model ids', async () => {
    await expect(
      runGptImageGeneration({
        modelId: 'gpt-5.4',
        prompt: 'test',
        sessionId: 'sess-3',
        client: {
          generate: vi.fn(),
          edit: vi.fn(),
        },
      })
    ).rejects.toThrow(/Unsupported image model/);
  });
});
