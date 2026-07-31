import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { sha512Base64, fileDigest, buildLatestMacYml } = require('../scripts/update-feed.js') as {
  sha512Base64: (filePath: string) => string;
  fileDigest: (filePath: string) => { sha512: string; size: number };
  buildLatestMacYml: (opts: {
    version: string;
    files: Array<{ url: string; sha512: string; size: number }>;
    releaseDate?: string;
  }) => string;
};

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('update-feed helpers', () => {
  it('computes sha512 base64 matching Node crypto', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-feed-'));
    tempDirs.push(dir);
    const filePath = path.join(dir, 'app.zip');
    const payload = Buffer.from('york-workos-update-payload');
    fs.writeFileSync(filePath, payload);

    const expected = crypto.createHash('sha512').update(payload).digest('base64');
    expect(sha512Base64(filePath)).toBe(expected);

    const digest = fileDigest(filePath);
    expect(digest.sha512).toBe(expected);
    expect(digest.size).toBe(payload.length);
  });

  it('builds latest-mac.yml in electron-updater shape', () => {
    const yml = buildLatestMacYml({
      version: '2.3.0',
      files: [
        {
          url: 'York-WorkOS-mac-arm64.zip',
          sha512: 'abc123base64',
          size: 42,
        },
      ],
      releaseDate: '2026-07-31T12:00:00.000Z',
    });

    expect(yml).toContain('version: 2.3.0');
    expect(yml).toContain('files:');
    expect(yml).toContain('  - url: York-WorkOS-mac-arm64.zip');
    expect(yml).toContain('    sha512: abc123base64');
    expect(yml).toContain('    size: 42');
    expect(yml).toContain('path: York-WorkOS-mac-arm64.zip');
    expect(yml).toContain('sha512: abc123base64');
    expect(yml).toContain("releaseDate: '2026-07-31T12:00:00.000Z'");
  });

  it('uses the first file as path/sha512 primary', () => {
    const yml = buildLatestMacYml({
      version: '2.3.0',
      files: [
        { url: 'York-WorkOS-mac-arm64.zip', sha512: 'arm', size: 1 },
        { url: 'York-WorkOS-mac-x64.zip', sha512: 'x64', size: 2 },
      ],
      releaseDate: '2026-07-31T12:00:00.000Z',
    });

    expect(yml).toContain('path: York-WorkOS-mac-arm64.zip');
    expect(yml).toContain('sha512: arm');
    expect(yml).toContain('  - url: York-WorkOS-mac-x64.zip');
  });

  it('rejects empty files / missing version', () => {
    expect(() => buildLatestMacYml({ version: '', files: [] })).toThrow(/version/i);
    expect(() =>
      buildLatestMacYml({
        version: '1.0.0',
        files: [],
      })
    ).toThrow(/file/i);
  });
});
