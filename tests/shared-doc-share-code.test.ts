import { describe, expect, it } from 'vitest';
import {
  createSharedDocId,
  parseSharedDocCode,
  parseSharedDocManifest,
  sharedDocCodeFromManifestKey,
  sharedDocFolder,
  sharedDocIdFromWorkspacePath,
} from '../src/shared/shared-docs/share-code';

describe('shared doc share codes', () => {
  it('encodes the Hub manifest key into a short code and back', () => {
    const docId = createSharedDocId();
    expect(docId).toMatch(/^[A-Za-z0-9]{10}$/);

    const manifestKey = `${sharedDocFolder(docId)}/m-1790000000123-k3j9zq.json`;
    const code = sharedDocCodeFromManifestKey(docId, manifestKey);
    expect(code.length).toBeLessThanOrEqual(28);
    expect(code).not.toContain('.');
    expect(parseSharedDocCode(code)).toEqual({ docId, manifestKey });
    expect(parseSharedDocCode(`york-doc:${code}`)).toEqual({ docId, manifestKey });
  });

  it('falls back to a verbatim key code for unexpected Hub key shapes', () => {
    const docId = 'abcdEFGH12';
    const manifestKey = `${sharedDocFolder(docId)}/manifest_renamed-17900.json`;
    const code = sharedDocCodeFromManifestKey(docId, manifestKey);
    expect(code.startsWith('k_')).toBe(true);
    expect(parseSharedDocCode(code)).toEqual({ docId, manifestKey });
  });

  it('rejects legacy tokens, UUIDs and keys outside the shared-docs folder', () => {
    expect(parseSharedDocCode('header.payload.signature')).toBeNull();
    expect(parseSharedDocCode('6c18e746-56d6-4068-9dc2-9421c87bdaf5')).toBeNull();
    const outside = `k_${Buffer.from('hub-requests/secret.pdf').toString('base64url')}`;
    expect(parseSharedDocCode(outside)).toBeNull();
    const traversal = `k_${Buffer.from('guild-collaboration/york-shared-docs/../x.json').toString('base64url')}`;
    expect(parseSharedDocCode(traversal)).toBeNull();
  });

  it('parses a manifest and reads doc ids from workspace paths', () => {
    const manifest = parseSharedDocManifest(
      JSON.stringify({
        id: 'abcdEFGH12',
        title: 'Hii',
        kind: 'html',
        contentType: 'text/html',
        fileName: 'content.html',
        s3Key: 'guild-collaboration/york-shared-docs/abcdEFGH12/content-1790000000000-abc123.html',
        ownerSub: 'sub',
        ownerEmail: 'a@york.ie',
        permission: 'view',
        updatedAt: '2026-01-01T00:00:00.000Z',
      })
    );
    expect(manifest?.title).toBe('Hii');
    expect(
      sharedDocIdFromWorkspacePath(
        '/Users/me/Library/Application Support/york-ie/default_working_dir/shared/6c18e746-56d6-4068-9dc2-9421c87bdaf5/hii.html'
      )
    ).toBe('6c18e746-56d6-4068-9dc2-9421c87bdaf5');
    expect(sharedDocIdFromWorkspacePath('/tmp/notes.md')).toBeNull();
  });
});
