import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import express from 'express';
import { createYorkLlmRouter } from './york-llm-router.js';
import { YorkLlmQueue } from './york-llm-queue.js';

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('Failed to bind test server'));
        return;
      }
      resolve(addr.port);
    });
    server.on('error', reject);
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (check()) return;
    await sleep(10);
  }
  assert.fail(`timed out waiting for ${label}`);
}

describe('York LLM router', () => {
  const prevKey = process.env.YORK_LLM_API_KEY;
  const queue = new YorkLlmQueue(() => 1);
  const pendingUpstream: http.ServerResponse[] = [];
  let upstreamHits = 0;
  let lastUpstream: { headers: http.IncomingHttpHeaders; body: string; url: string } | null = null;
  let upstream: http.Server;
  let proxy: http.Server;
  let proxyPort = 0;

  before(async () => {
    process.env.YORK_LLM_API_KEY = 'llama-secret';
    upstream = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        upstreamHits += 1;
        lastUpstream = {
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8'),
          url: req.url || '',
        };
        if (req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"data":[]}');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: {"choices":[]}\n\n');
        pendingUpstream.push(res);
      });
    });
    const upstreamPort = await listen(upstream);

    const app = express();
    app.use(
      '/york-llm',
      createYorkLlmRouter(
        {
          provider: 'york-llm',
          upstreamOrigin: `http://127.0.0.1:${upstreamPort}`,
          mountPath: '/york-llm',
          apiKeyOptional: true,
        },
        queue
      )
    );
    proxy = http.createServer(app);
    proxyPort = await listen(proxy);
  });

  after(async () => {
    if (prevKey === undefined) delete process.env.YORK_LLM_API_KEY;
    else process.env.YORK_LLM_API_KEY = prevKey;
    await closeServer(proxy);
    await closeServer(upstream);
  });

  function startCompletion(): { req: http.ClientRequest; firstChunk: Promise<void> } {
    const body = JSON.stringify({ model: 'm', stream: true, messages: [] });
    let req!: http.ClientRequest;
    const firstChunk = new Promise<void>((resolve, reject) => {
      req = http.request(
        {
          hostname: '127.0.0.1',
          port: proxyPort,
          path: '/york-llm/v1/chat/completions',
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
            authorization: 'Bearer client-cognito-jwt',
          },
        },
        (res) => res.once('data', () => resolve())
      );
      req.on('error', (err) => {
        if ((err as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(err);
      });
      req.end(body);
    });
    return { req, firstChunk };
  }

  it('holds the next completion until a slot frees, and frees slots when clients leave', async () => {
    const first = startCompletion();
    await first.firstChunk;
    assert.equal(upstreamHits, 1);
    assert.equal(lastUpstream?.url, '/v1/chat/completions');
    assert.equal(lastUpstream?.headers.authorization, 'Bearer llama-secret');
    assert.match(lastUpstream?.body || '', /"stream":true/);

    const second = startCompletion();
    await waitFor(() => queue.snapshot().waitingCount === 1, 'second request to queue');
    assert.equal(upstreamHits, 1);

    // A queued client that gives up must not take a slot later.
    const third = startCompletion();
    await waitFor(() => queue.snapshot().waitingCount === 2, 'third request to queue');
    third.req.destroy();
    await waitFor(() => queue.snapshot().waitingCount === 1, 'third request to leave queue');

    // The streaming client disconnecting mid-response releases its slot.
    first.req.destroy();
    await second.firstChunk;
    assert.equal(upstreamHits, 2);
    assert.deepEqual(queue.snapshot(), { maxConcurrent: 1, activeCount: 1, waitingCount: 0 });

    second.req.destroy();
    await waitFor(() => queue.snapshot().activeCount === 0, 'slot release');
    for (const res of pendingUpstream) res.end();
  });

  it('does not queue model listing', async () => {
    const held = await queue.acquire();
    const status = await new Promise<number>((resolve, reject) => {
      http
        .get({ hostname: '127.0.0.1', port: proxyPort, path: '/york-llm/v1/models' }, (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode || 0));
        })
        .on('error', reject);
    });
    held();
    assert.equal(status, 200);
    assert.equal(lastUpstream?.url, '/v1/models');
  });

  it('reports queue state', async () => {
    const body = await new Promise<string>((resolve, reject) => {
      http
        .get({ hostname: '127.0.0.1', port: proxyPort, path: '/york-llm/_queue' }, (res) => {
          let text = '';
          res.on('data', (chunk) => (text += chunk));
          res.on('end', () => resolve(text));
        })
        .on('error', reject);
    });
    assert.deepEqual(JSON.parse(body), { maxConcurrent: 1, activeCount: 0, waitingCount: 0 });
  });
});
