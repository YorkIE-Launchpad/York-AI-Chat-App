import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, afterEach } from 'node:test';
import { signDocInvite, verifyDocInvite } from './doc-invite.js';
import { getDocAccess } from './doc-access.js';
import {
  createSharedDoc,
  getSharedDoc,
  patchSharedDocVersion,
  resetShareDocDbSingleton,
  upsertAcl,
} from './doc-store.js';

describe('shared doc invites', () => {
  it('signs and verifies doc invite', () => {
    const token = signDocInvite('doc-1', 'edit', { nowSec: 1_700_000_000, ttlSec: 3600 });
    const result = verifyDocInvite(token, 'doc-1', { nowSec: 1_700_000_100 });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.payload.docId, 'doc-1');
      assert.equal(result.payload.permission, 'edit');
    }
  });
});

describe('shared doc store', () => {
  let dbPath: string;
  let tempDir: string;

  afterEach(() => {
    resetShareDocDbSingleton();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates doc and bumps version with optimistic lock', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'share-docs-'));
    dbPath = join(tempDir, 'test.sqlite');

    const doc = createSharedDoc(
      {
        ownerSub: 'owner-sub',
        ownerEmail: 'owner@york.ie',
        title: 'Plan',
        kind: 'markdown',
        s3Key: 'guild-collaboration/york-shared-docs/a/file.md',
        contentType: 'text/markdown',
      },
      dbPath
    );
    assert.equal(doc.version, 1);

    upsertAcl(doc.id, 'peer@york.ie', 'view', dbPath);
    const loaded = getSharedDoc(doc.id, dbPath)!;
    const viewAccess = getDocAccess(loaded, { sub: 'peer-sub', email: 'peer@york.ie' });
    assert.equal(viewAccess, 'view');

    const conflict = patchSharedDocVersion(
      doc.id,
      { s3Key: 'k2', updatedBy: 'owner-sub', expectedVersion: 2 },
      dbPath
    );
    assert.equal(conflict.ok, false);
    if (!conflict.ok) assert.equal(conflict.error, 'version_conflict');

    const ok = patchSharedDocVersion(
      doc.id,
      { s3Key: 'k2', updatedBy: 'owner-sub', expectedVersion: 1 },
      dbPath
    );
    assert.equal(ok.ok, true);
    if (ok.ok) assert.equal(ok.doc.version, 2);
  });
});
