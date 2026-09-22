import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';
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

describe('proxyToProvider TypeSafe Jev', () => {
  let upstream: http.Server;
  let proxy: http.Server;
  let upstreamPort = 0;
  let proxyPort = 0;
  let lastUpstreamHeaders: http.IncomingHttpHeaders = {};
  let lastUpstreamPath = '';
  const prevKey = process.env.TYPESAFE_API_KEY;

  before(async () => {
    process.env.TYPESAFE_API_KEY = 'ts-test-secret-key';

    upstream = http.createServer((req, res) => {
      lastUpstreamHeaders = { ...req.headers };
      lastUpstreamPath = req.url || '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ model: 'jev-1.13.0', answers: {}, usage: {} }));
    });
    upstreamPort = await listen(upstream);

    const app = express();
    const target: ProviderTarget = {
      provider: 'typesafe',
      upstreamOrigin: `http://127.0.0.1:${upstreamPort}`,
      mountPath: '/typesafe',
    };
    app.use('/typesafe', (req, res) => {
      void proxyToProvider(req, res, target);
    });
    proxy = http.createServer(app);
    proxyPort = await listen(proxy);
  });

  after(async () => {
    if (prevKey === undefined) {
      delete process.env.TYPESAFE_API_KEY;
    } else {
      process.env.TYPESAFE_API_KEY = prevKey;
    }
    await closeServer(proxy);
    await closeServer(upstream);
  });

  beforeEach(() => {
    lastUpstreamHeaders = {};
    lastUpstreamPath = '';
  });

  it('injects TYPESAFE_API_KEY as Bearer and strips client Cognito auth', async () => {
    const body = JSON.stringify({
      model: 'jev-1.13.0',
      state: 'hello',
      questions: { q: { type: 'noul', instructions: 'Is this a greeting?' } },
    });
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: proxyPort,
          path: '/typesafe/v1/systemone',
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
            authorization: 'Bearer cognito-jwt-should-be-stripped',
            'x-york-app-version': '4.6.8',
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
    assert.equal(lastUpstreamPath, '/v1/systemone');
    assert.equal(lastUpstreamHeaders.authorization, 'Bearer ts-test-secret-key');
    assert.equal(lastUpstreamHeaders['x-york-app-version'], undefined);
  });

  it('returns 503 when TYPESAFE_API_KEY is missing', async () => {
    const saved = process.env.TYPESAFE_API_KEY;
    delete process.env.TYPESAFE_API_KEY;
    try {
      const body = JSON.stringify({ model: 'jev-1.13.0', state: 'x', questions: {} });
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port: proxyPort,
            path: '/typesafe/v1/systemone',
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
      assert.equal(status, 503);
    } finally {
      process.env.TYPESAFE_API_KEY = saved;
    }
  });
});
