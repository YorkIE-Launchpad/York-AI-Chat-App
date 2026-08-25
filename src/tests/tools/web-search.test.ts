/**
 * Tests for src/main/tools/web-search.ts and WebSearchExtension.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { searchWeb } from '../../main/tools/web-search';
import { WebSearchExtension } from '../../main/tools/web-search-extension';

describe('searchWeb', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('rejects empty query', async () => {
    await expect(searchWeb('')).rejects.toThrow('Query is required');
    await expect(searchWeb('   ')).rejects.toThrow('Query is required');
  });

  it('returns instant-answer results without hitting HTML when enough topics exist', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        Heading: 'York IE',
        AbstractText: 'A company.',
        AbstractURL: 'https://york.ie',
        RelatedTopics: [
          { Text: 'Topic one', FirstURL: 'https://example.com/1' },
          { Text: 'Topic two', FirstURL: 'https://example.com/2' },
          { Text: 'Topic three', FirstURL: 'https://example.com/3' },
        ],
      }),
    }) as unknown as typeof fetch;

    const result = await searchWeb('york ie');
    expect(result).toContain('Query: york ie');
    expect(result).toContain('Heading: York IE');
    expect(result).toContain('https://example.com/1');
    expect(result).toContain('webfetch');
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('falls back to HTML results when instant answer is thin', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ Heading: '', AbstractText: '', RelatedTopics: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          '<a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage">Example Page</a>',
      }) as unknown as typeof fetch;

    const result = await searchWeb('obscure query');
    expect(result).toContain('Example Page');
    expect(result).toContain('https://example.com/page');
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });
});

describe('WebSearchExtension', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('registers a websearch custom tool', async () => {
    const extension = new WebSearchExtension();
    const result = await extension.beforeSessionRun();
    expect(result?.customTools).toHaveLength(1);
    expect(result?.customTools?.[0]?.name).toBe('websearch');
  });

  it('execute returns text content shape', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        Heading: 'Hi',
        AbstractText: 'Hello',
        RelatedTopics: [
          { Text: 'A', FirstURL: 'https://a.example' },
          { Text: 'B', FirstURL: 'https://b.example' },
          { Text: 'C', FirstURL: 'https://c.example' },
        ],
      }),
    }) as unknown as typeof fetch;

    const extension = new WebSearchExtension();
    const result = await extension.beforeSessionRun();
    const tool = result!.customTools![0]!;
    const output = await tool.execute(
      'call-1',
      { query: 'hello' },
      undefined,
      undefined,
      {} as never
    );
    expect(output.content[0]).toMatchObject({ type: 'text' });
    expect((output.content[0] as { text: string }).text).toContain('Query: hello');
  });
});
