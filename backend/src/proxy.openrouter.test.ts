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

describe('proxyToProvider OpenRouter BYOK', () => {
  let upstream: http.Server;
  let proxy: http.Server;
  let upstreamPort = 0;
  let proxyPort = 0;
  let lastUpstreamHeaders: http.IncomingHttpHeaders = {};

  before(async () => {
    upstream = http.createServer((req, res) => {
      lastUpstreamHeaders = { ...req.headers };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    upstreamPort = await listen(upstream);

    const app = express();
    const target: ProviderTarget = {
      provider: 'openrouter',
      upstreamOrigin: `http://127.0.0.1:${upstreamPort}`,
      mountPath: '/openrouter',
    };
    app.use('/openrouter', (req, res) => {
      void proxyToProvider(req, res, target);
    });
    proxy = http.createServer(app);
    proxyPort = await listen(proxy);
  });

  after(async () => {
    await closeServer(proxy);
    await closeServer(upstream);
  });

  it('rejects OpenRouter requests without user key', async () => {
    const body = JSON.stringify({ model: 'openrouter/free', messages: [] });
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: proxyPort,
          path: '/openrouter/v1/chat/completions',
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
            authorization: 'Bearer cognito-jwt',
          },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode || 0));
          res.on('error', reject);
        }
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });
    assert.equal(status, 401);
  });

  it('uses X-York-OpenRouter-Key as upstream Bearer and strips the header', async () => {
    const body = JSON.stringify({ model: 'openrouter/free', messages: [] });
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: proxyPort,
          path: '/openrouter/v1/chat/completions',
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
            authorization: 'Bearer cognito-jwt',
            'x-york-openrouter-key': 'sk-or-user-key',
          },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode || 0));
          res.on('error', reject);
        }
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });

    assert.equal(status, 200);
    assert.equal(lastUpstreamHeaders.authorization, 'Bearer sk-or-user-key');
    assert.equal(lastUpstreamHeaders['x-york-openrouter-key'], undefined);
  });
});
