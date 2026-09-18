import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hubHttpRequest, installJitlessSafeFetch, jitlessFetch, __resetJitlessFetchInstallForTests } from '../../main/http/jitless-fetch';

describe('jitless-fetch', () => {
  let server: Server | null = null;
  let baseUrl = '';

  afterEach(async () => {
    if (!server) return;
    await new Promise<void>((resolve) => {
      server!.close(() => resolve());
    });
    server = null;
  });

  it('hubHttpRequest returns JSON from loopback server', async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => {
      server!.listen(0, '127.0.0.1', () => {
        const addr = server!.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });

    const res = await hubHttpRequest(`${baseUrl}/test`);
    expect(res.ok).toBe(true);
    const json = await res.json<{ ok: boolean }>();
    expect(json.ok).toBe(true);
  });

  it('jitlessFetch supports POST JSON and AbortSignal.timeout', async () => {
    server = createServer((req, res) => {
      if (req.method === 'POST') {
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ created: true }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => {
      server!.listen(0, '127.0.0.1', () => {
        const addr = server!.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });

    const response = await jitlessFetch(`${baseUrl}/items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'test' }),
      signal: AbortSignal.timeout(5000),
    });
    expect(response.status).toBe(201);
    expect(response.ok).toBe(true);
    await expect(response.json()).resolves.toEqual({ created: true });
  });

  it('jitlessFetch waits longer than the Node globalAgent 5s socket timeout', async () => {
    server = createServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('slow-ok');
      }, 8_000);
    });
    await new Promise<void>((resolve) => {
      server!.listen(0, '127.0.0.1', () => {
        const addr = server!.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });

    const started = Date.now();
    const response = await jitlessFetch(`${baseUrl}/slow`);
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('slow-ok');
    expect(Date.now() - started).toBeGreaterThanOrEqual(7_500);
  }, 15_000);

  it('hubHttpRequest honors an explicit timeoutMs', async () => {
    server = createServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('too-late');
      }, 3_000);
    });
    await new Promise<void>((resolve) => {
      server!.listen(0, '127.0.0.1', () => {
        const addr = server!.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });

    await expect(hubHttpRequest(`${baseUrl}/deadline`, { timeoutMs: 500 })).rejects.toThrow(
      /timed out/i
    );
  });

  it('jitlessFetch returns native Response with Headers.entries and bytes()', async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'X-Test-Header': 'yes',
      });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => {
      server!.listen(0, '127.0.0.1', () => {
        const addr = server!.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });

    const response = await jitlessFetch(`${baseUrl}/models`);
    expect(typeof response.headers.entries).toBe('function');
    expect(Object.fromEntries(response.headers.entries())).toMatchObject({
      'content-type': 'application/json',
      'x-test-header': 'yes',
    });
    expect(response.body).toBeTruthy();
    if (typeof response.bytes === 'function') {
      const bytes = await response.bytes();
      expect(bytes.length).toBeGreaterThan(0);
    }
  });

  it('installJitlessSafeFetch patches global fetch when WebAssembly is missing', () => {
    const originalWasm = globalThis.WebAssembly;
    const originalFetch = globalThis.fetch;
    __resetJitlessFetchInstallForTests();
    vi.stubGlobal('WebAssembly', undefined);
    try {
      installJitlessSafeFetch();
      expect(globalThis.fetch).not.toBe(originalFetch);
    } finally {
      vi.stubGlobal('WebAssembly', originalWasm);
      globalThis.fetch = originalFetch;
      __resetJitlessFetchInstallForTests();
    }
  });
});
