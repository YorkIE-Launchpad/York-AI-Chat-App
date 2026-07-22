import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import express from 'express';
import { proxyToProvider, type ProviderTarget } from './proxy.js';

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
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

describe('proxyToProvider streaming passthrough', () => {
  const prevKey = process.env.ANTHROPIC_API_KEY;
  let upstream: http.Server;
  let proxy: http.Server;
  let upstreamPort = 0;
  let proxyPort = 0;
  let lastUpstreamHeaders: http.IncomingHttpHeaders = {};
  let upstreamFinishedAt = 0;

  before(async () => {
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';

    upstream = http.createServer((req, res) => {
      lastUpstreamHeaders = { ...req.headers };
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
      });

      const events = [
        'event: message_start\ndata: {"type":"message_start"}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ];

      let index = 0;
      const writeNext = (): void => {
        if (index < events.length) {
          res.write(events[index++]);
          setTimeout(writeNext, 50);
          return;
        }
        upstreamFinishedAt = Date.now();
        res.end();
      };
      writeNext();
    });
    upstreamPort = await listen(upstream);

    const app = express();
    const target: ProviderTarget = {
      provider: 'anthropic',
      upstreamOrigin: `http://127.0.0.1:${upstreamPort}`,
      mountPath: '/anthropic',
    };
    app.use('/anthropic', (req, res) => {
      void proxyToProvider(req, res, target);
    });
    proxy = http.createServer(app);
    proxyPort = await listen(proxy);
  });

  after(async () => {
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevKey;
    await closeServer(proxy);
    await closeServer(upstream);
  });

  it('forwards delayed SSE chunks before upstream finishes', async () => {
    const chunkTimes: number[] = [];
    const body = JSON.stringify({
      model: 'claude-test',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    });

    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: proxyPort,
          path: '/anthropic/v1/messages',
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
            'anthropic-beta': 'fine-grained-tool-streaming-2025-05-14',
            'x-api-key': 'client-cognito-jwt',
          },
        },
        (res) => {
          assert.equal(res.statusCode, 200);
          assert.match(String(res.headers['content-type'] || ''), /text\/event-stream/);
          assert.equal(res.headers['x-accel-buffering'], 'no');
          assert.match(String(res.headers['cache-control'] || ''), /no-cache/);

          res.on('data', () => {
            chunkTimes.push(Date.now());
          });
          res.on('end', () => resolve());
          res.on('error', reject);
        }
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });

    assert.ok(chunkTimes.length >= 2, `expected multiple chunks, got ${chunkTimes.length}`);
    assert.ok(upstreamFinishedAt > 0, 'upstream should finish');

    // At least one chunk must arrive before the upstream closes.
    const earlyChunks = chunkTimes.filter((t) => t < upstreamFinishedAt);
    assert.ok(
      earlyChunks.length >= 1,
      `expected chunks before upstream end; chunkTimes=${chunkTimes.join(',')}, upstreamFinishedAt=${upstreamFinishedAt}`
    );

    // Chunks should span multiple delayed writes (~50ms apart), not one dump.
    const span = chunkTimes[chunkTimes.length - 1]! - chunkTimes[0]!;
    assert.ok(span >= 80, `expected streaming span >= 80ms, got ${span}ms`);
  });

  it('forwards anthropic-beta and forces accept-encoding identity', async () => {
    const body = JSON.stringify({ model: 'claude-test', stream: true, messages: [] });

    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: proxyPort,
          path: '/anthropic/v1/messages',
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
            'anthropic-beta':
              'fine-grained-tool-streaming-2025-05-14,interleaved-thinking-2025-05-14',
            'accept-encoding': 'gzip, deflate, br',
            'x-api-key': 'client-cognito-jwt',
          },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve());
          res.on('error', reject);
        }
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });

    assert.equal(
      lastUpstreamHeaders['anthropic-beta'],
      'fine-grained-tool-streaming-2025-05-14,interleaved-thinking-2025-05-14'
    );
    assert.equal(lastUpstreamHeaders['accept-encoding'], 'identity');
    assert.equal(lastUpstreamHeaders['x-api-key'], 'test-anthropic-key');
    assert.equal(lastUpstreamHeaders['authorization'], undefined);
  });
});
