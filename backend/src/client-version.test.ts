import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { NextFunction, Request, Response } from 'express';
import {
  checkClientVersion,
  clientOutdatedMessage,
  compareSemver,
  DEFAULT_MIN_CLIENT_VERSION,
  isValidClientVersion,
  requireMinClientVersion,
  YORK_APP_VERSION_HEADER,
} from './client-version.js';

describe('compareSemver', () => {
  it('orders major.minor.patch', () => {
    assert.equal(compareSemver('3.3.0', '3.3.1'), -1);
    assert.equal(compareSemver('3.3.1', '3.3.1'), 0);
    assert.equal(compareSemver('3.4.0', '3.3.1'), 1);
  });

  it('treats release as newer than prerelease of same core', () => {
    assert.equal(compareSemver('3.3.1-beta.1', '3.3.1'), -1);
    assert.equal(compareSemver('3.3.1', '3.3.1-beta.1'), 1);
  });

  it('ignores leading v', () => {
    assert.equal(compareSemver('v3.3.1', '3.3.1'), 0);
  });
});

describe('isValidClientVersion', () => {
  it('accepts numeric cores', () => {
    assert.equal(isValidClientVersion('3.3.1'), true);
    assert.equal(isValidClientVersion('v3.3.1'), true);
    assert.equal(isValidClientVersion('3.3.1-beta.1'), true);
  });

  it('rejects garbage', () => {
    assert.equal(isValidClientVersion(''), false);
    assert.equal(isValidClientVersion('latest'), false);
    assert.equal(isValidClientVersion('3.x.1'), false);
  });
});

describe('checkClientVersion', () => {
  it('rejects missing / invalid / outdated', () => {
    assert.equal(checkClientVersion(undefined, '3.3.1').ok, false);
    assert.equal(checkClientVersion('', '3.3.1').ok, false);
    assert.equal(checkClientVersion('nope', '3.3.1').ok, false);
    assert.equal(checkClientVersion('3.3.0', '3.3.1').ok, false);
  });

  it('allows equal and newer than min', () => {
    assert.equal(checkClientVersion('3.3.1', '3.3.1').ok, true);
    assert.equal(checkClientVersion('3.4.0', '3.3.1').ok, true);
  });

  it('defaults min version to 3.3.1 when not passed', () => {
    const prev = process.env.MIN_CLIENT_VERSION;
    delete process.env.MIN_CLIENT_VERSION;
    try {
      const result = checkClientVersion('3.3.0');
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.minVersion, DEFAULT_MIN_CLIENT_VERSION);
        assert.equal(result.reason, 'outdated');
      }
    } finally {
      if (prev === undefined) delete process.env.MIN_CLIENT_VERSION;
      else process.env.MIN_CLIENT_VERSION = prev;
    }
  });
});

describe('requireMinClientVersion middleware', () => {
  function mockRes(): Response & {
    statusCode: number;
    body: unknown;
  } {
    const res = {
      statusCode: 200,
      body: undefined as unknown,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: unknown) {
        this.body = payload;
        return this;
      },
    };
    return res as unknown as Response & { statusCode: number; body: unknown };
  }

  it('calls next when version is current', async () => {
    let nextCalled = false;
    const req = {
      headers: { [YORK_APP_VERSION_HEADER]: '3.3.1' },
    } as unknown as Request;
    const res = mockRes();
    const next: NextFunction = () => {
      nextCalled = true;
    };

    await requireMinClientVersion(req, res, next);
    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, 200);
  });

  it('responds 426 client_outdated when version is missing', async () => {
    let nextCalled = false;
    const req = { headers: {} } as unknown as Request;
    const res = mockRes();
    const next: NextFunction = () => {
      nextCalled = true;
    };

    await requireMinClientVersion(req, res, next);
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 426);
    assert.deepEqual(res.body, {
      error: 'client_outdated',
      message: clientOutdatedMessage(DEFAULT_MIN_CLIENT_VERSION, null),
      minVersion: DEFAULT_MIN_CLIENT_VERSION,
      clientVersion: null,
    });
  });

  it('responds 426 when version is outdated', async () => {
    let nextCalled = false;
    const req = {
      headers: { [YORK_APP_VERSION_HEADER]: '3.2.0' },
    } as unknown as Request;
    const res = mockRes();
    const next: NextFunction = () => {
      nextCalled = true;
    };

    await requireMinClientVersion(req, res, next);
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 426);
    const body = res.body as { error: string; clientVersion: string; minVersion: string; message: string };
    assert.equal(body.error, 'client_outdated');
    assert.equal(body.clientVersion, '3.2.0');
    assert.equal(body.minVersion, DEFAULT_MIN_CLIENT_VERSION);
    assert.equal(body.message, clientOutdatedMessage(DEFAULT_MIN_CLIENT_VERSION, '3.2.0'));
    assert.match(body.message, /v3\.2\.0/);
    assert.match(body.message, /v3\.3\.1/);
  });
});
