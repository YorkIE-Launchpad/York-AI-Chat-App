import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { signDocInvite, verifyDocInvite } from './doc-invite.js';
import { accessForCaller, docFromInvitePayload } from './doc-access.js';

describe('shared doc invites', () => {
  it('signs and verifies fat doc invite', () => {
    const token = signDocInvite(
      {
        docId: 'doc-1',
        s3Key: 'guild-collaboration/york-shared-docs/doc-1/plan.md',
        title: 'Plan',
        kind: 'markdown',
        contentType: 'text/markdown',
        ownerSub: 'owner-sub',
        ownerEmail: 'owner@york.ie',
      },
      'edit',
      { nowSec: 1_700_000_000, ttlSec: 3600 }
    );
    const result = verifyDocInvite(token, 'doc-1', { nowSec: 1_700_000_100 });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.payload.docId, 'doc-1');
      assert.equal(result.payload.permission, 'edit');
      assert.equal(result.payload.s3Key, 'guild-collaboration/york-shared-docs/doc-1/plan.md');
    }
  });

  it('maps invite payload to caller access', () => {
    const token = signDocInvite(
      {
        docId: 'doc-2',
        s3Key: 'k',
        title: 'T',
        kind: 'html',
        contentType: 'text/html',
        ownerSub: 'owner-sub',
        ownerEmail: 'owner@york.ie',
      },
      'view',
      { nowSec: 1_700_000_000, ttlSec: 3600 }
    );
    const verified = verifyDocInvite(token, undefined, { nowSec: 1_700_000_100 });
    assert.equal(verified.ok, true);
    if (!verified.ok) return;

    const ownerAccess = accessForCaller(verified.payload, {
      sub: 'owner-sub',
      email: 'owner@york.ie',
    });
    assert.equal(ownerAccess, 'owner');

    const peerAccess = accessForCaller(verified.payload, {
      sub: 'peer-sub',
      email: 'peer@york.ie',
    });
    assert.equal(peerAccess, 'view');

    const doc = docFromInvitePayload(verified.payload, peerAccess);
    assert.equal(doc.id, 'doc-2');
    assert.equal(doc.permission, 'view');
  });
});
