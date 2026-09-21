import { describe, expect, it } from 'vitest';
import {
  createSharedDocCode,
  parseSharedDocCode,
  parseSharedDocManifest,
  sharedDocContentKey,
  sharedDocManifestKey,
} from '../src/shared/shared-docs/share-code';

describe('shared doc share codes', () => {
  it('creates a short code and rejects JWTs', () => {
    const code = createSharedDocCode();
    expect(code.length).toBeLessThanOrEqual(16);
    expect(parseSharedDocCode(code)).toBe(code);
    expect(parseSharedDocCode(`york-doc:${code}`)).toBe(code);
    expect(parseSharedDocCode('header.payload.signature')).toBeNull();
  });

  it('parses a manifest and builds deterministic Hub keys', () => {
    const manifest = parseSharedDocManifest(
      JSON.stringify({
        id: 'abc12345',
        title: 'Hii',
        kind: 'html',
        contentType: 'text/html',
        fileName: 'content.html',
        s3Key: 'guild-collaboration/york-shared-docs/abc12345/content.html',
        ownerSub: 'sub',
        ownerEmail: 'a@york.ie',
        permission: 'view',
        updatedAt: '2026-01-01T00:00:00.000Z',
      })
    );
    expect(manifest?.title).toBe('Hii');
    expect(sharedDocManifestKey('abc12345')).toBe(
      'guild-collaboration/york-shared-docs/abc12345/manifest.json'
    );
    expect(sharedDocContentKey('abc12345', 'html')).toBe(
      'guild-collaboration/york-shared-docs/abc12345/content.html'
    );
  });
});
