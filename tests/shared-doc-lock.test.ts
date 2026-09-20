import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  isLeaseHeldByOther,
  readTurnLease,
  tryAcquireLease,
} from '../src/shared/collab/shared-session-doc';
import { SHARED_DOC_LOCK_HELD } from '../src/shared/shared-docs/lock-types';

describe('shared doc edit lease', () => {
  it('allows first editor and rejects second holder', () => {
    const doc = new Y.Doc();
    const first = tryAcquireLease(doc, { sub: 'user-a', displayName: 'Alice' });
    expect(first.ok).toBe(true);

    const second = tryAcquireLease(doc, { sub: 'user-b', displayName: 'Bob' });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.reason).toBe('held_by_other');
      expect(second.holder?.holderName).toBe('Alice');
    }

    expect(isLeaseHeldByOther(doc, 'user-b')).toBe(true);
    expect(isLeaseHeldByOther(doc, 'user-a')).toBe(false);
    expect(readTurnLease(doc)?.holderSub).toBe('user-a');
  });

  it('uses stable lock error code for write guards', () => {
    expect(SHARED_DOC_LOCK_HELD).toBe('doc_lock_held');
  });
});
