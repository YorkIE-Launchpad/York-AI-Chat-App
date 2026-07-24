/**
 * Tests for src/main/tools/web-fetch.ts and WebFetchExtension.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchWebPage } from '../../main/tools/web-fetch';
import { WebFetchExtension } from '../../main/tools/web-fetch-extension';

describe('fetchWebPage', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('rejects empty URL', async () => {
    await expect(fetchWebPage('')).rejects.toThrow('URL is required');
    await expect(fetchWebPage('   ')).rejects.toThrow('URL is required');
  });

  it('rejects invalid URL', async () => {
    await expect(fetchWebPage('not-a-url')).rejects.toThrow('Invalid URL');
  });

  it('rejects non-http protocols', async () => {
    await expect(fetchWebPage('ftp://example.com/file')).rejects.toThrow(
      'Only http/https URLs are supported'
    );
    await expect(fetchWebPage('file:///etc/passwd')).rejects.toThrow(
      'Only http/https URLs are supported'
    );
  });

  it('returns status and body for a successful fetch', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => 'text/html; charset=utf-8' },
      text: async () => '<html>hello</html>',
    }) as unknown as typeof fetch;

    const result = await fetchWebPage('https://example.com/page');
    expect(result).toContain('URL: https://example.com/page');
    expect(result).toContain('Status: 200');
    expect(result).toContain('Content-Type: text/html; charset=utf-8');
    expect(result).toContain('<html>hello</html>');
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://example.com/page',
      expect.objectContaining({
        headers: expect.objectContaining({
          'User-Agent': expect.stringContaining('Mozilla/5.0'),
          Accept: expect.stringContaining('text/html'),
        }),
      })
    );
  });

  it('truncates bodies longer than 20000 chars', async () => {
    const longBody = 'x'.repeat(25000);
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => 'text/plain' },
      text: async () => longBody,
    }) as unknown as typeof fetch;

    const result = await fetchWebPage('https://example.com/big');
    expect(result).toContain('[Truncated 5000 chars]');
    expect(result.indexOf('x'.repeat(20000))).toBeGreaterThan(-1);
    expect(result).not.toContain('x'.repeat(20001));
  });

  it('throws on non-ok HTTP status', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      headers: { get: () => 'text/plain' },
      text: async () => 'missing',
    }) as unknown as typeof fetch;

    await expect(fetchWebPage('https://example.com/missing')).rejects.toThrow(
      'Request failed with status 404'
    );
  });
});

describe('WebFetchExtension', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => 'text/plain' },
      text: async () => 'ok body',
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('registers a webfetch custom tool', async () => {
    const extension = new WebFetchExtension();
    const result = await extension.beforeSessionRun();
    expect(result?.customTools).toHaveLength(1);
    expect(result?.customTools?.[0]?.name).toBe('webfetch');
  });

  it('execute returns text content shape', async () => {
    const extension = new WebFetchExtension();
    const result = await extension.beforeSessionRun();
    const tool = result!.customTools![0]!;
    const output = await tool.execute(
      'call-1',
      { url: 'https://example.com' },
      undefined,
      undefined,
      {} as never
    );
    expect(output.content).toEqual([
      expect.objectContaining({
        type: 'text',
        text: expect.stringContaining('ok body'),
      }),
    ]);
  });

  it('execute returns error text on failure', async () => {
    const extension = new WebFetchExtension();
    const result = await extension.beforeSessionRun();
    const tool = result!.customTools![0]!;
    const output = await tool.execute(
      'call-2',
      { url: 'ftp://bad' },
      undefined,
      undefined,
      {} as never
    );
    expect(output.content[0]).toEqual(
      expect.objectContaining({
        type: 'text',
        text: expect.stringContaining('Only http/https URLs are supported'),
      })
    );
  });
});
