import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  canPromptWithLease,
  clearLeaseIfHolderOffline,
  commitCollabMessage,
  isLeaseHeldByOther,
  isLeaseHolder,
  listOrderedMessages,
  messageToCollabPortable,
  readTurnLease,
  refreshLease,
  releaseLeaseIfHolder,
  seedCollabMeta,
  stripAttachmentBinaries,
  tryAcquireLease,
} from '../src/shared/collab/shared-session-doc';
import type { Message } from '../src/renderer/types';

function sampleMessage(id: string, text: string): Message {
  return {
    id,
    sessionId: 's1',
    role: 'user',
    content: [{ type: 'text', text }],
    timestamp: Date.now(),
  };
}

describe('shared-session-doc', () => {
  it('seeds meta and commits messages in order with dedupe', () => {
    const doc = new Y.Doc();
    seedCollabMeta(
      doc,
      {
        title: 'Shared',
        createdBySub: 'sub-a',
        createdAt: 1,
      },
      { sub: 'sub-a', displayName: 'Ada' }
    );

    const m1 = messageToCollabPortable(sampleMessage('m1', 'hi'));
    const m2 = messageToCollabPortable(sampleMessage('m2', 'there'));
    expect(commitCollabMessage(doc, m1)).toBe(true);
    expect(commitCollabMessage(doc, m2)).toBe(true);
    expect(commitCollabMessage(doc, m1)).toBe(false);
    expect(listOrderedMessages(doc).map((m) => m.id)).toEqual(['m1', 'm2']);
  });

  it('strips image and attachment binaries', () => {
    const stripped = stripAttachmentBinaries([
      {
        type: 'file_attachment',
        filename: 'a.pdf',
        relativePath: '.tmp/a.pdf',
        size: 10,
        mimeType: 'application/pdf',
        inlineDataBase64: 'AAAA',
      },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'xxxx' },
      },
    ]);
    expect(stripped[0]).toMatchObject({ type: 'file_attachment', filename: 'a.pdf' });
    expect((stripped[0] as { inlineDataBase64?: string }).inlineDataBase64).toBeUndefined();
    expect(stripped[1]).toEqual({ type: 'text', text: '[image omitted from shared sync]' });
  });

  it('enforces turn lease acquire / refresh / release', () => {
    const doc = new Y.Doc();
    const now = 1_000_000;
    const a = tryAcquireLease(doc, { sub: 'a', displayName: 'Ada' }, { now, ttlMs: 1000 });
    expect(a.ok).toBe(true);
    expect(isLeaseHolder(doc, 'a', now)).toBe(true);

    const b = tryAcquireLease(doc, { sub: 'b', displayName: 'Bob' }, { now: now + 100, ttlMs: 1000 });
    expect(b.ok).toBe(false);

    expect(refreshLease(doc, 'a', { now: now + 200, ttlMs: 1000 })).toBe(true);
    expect(readTurnLease(doc, now + 200)?.expiresAt).toBe(now + 200 + 1000);

    // Expired — Bob can take over
    const b2 = tryAcquireLease(doc, { sub: 'b', displayName: 'Bob' }, { now: now + 5000, ttlMs: 1000 });
    expect(b2.ok).toBe(true);
    expect(releaseLeaseIfHolder(doc, 'b', now + 5000)).toBe(true);
    expect(readTurnLease(doc, now + 5000)).toBeNull();
  });

  it('allows prompt when lease is free or held by self', () => {
    const doc = new Y.Doc();
    const now = 1_000_000;
    expect(canPromptWithLease(doc, 'a', now)).toBe(true);
    expect(isLeaseHeldByOther(doc, 'a', now)).toBe(false);

    tryAcquireLease(doc, { sub: 'a', displayName: 'Ada' }, { now, ttlMs: 1000 });
    expect(canPromptWithLease(doc, 'a', now)).toBe(true);
    expect(canPromptWithLease(doc, 'b', now)).toBe(false);
    expect(isLeaseHeldByOther(doc, 'b', now)).toBe(true);
  });

  it('clears stale lease when holder is offline', () => {
    const doc = new Y.Doc();
    const now = 1_000_000;
    tryAcquireLease(doc, { sub: 'a', displayName: 'Ada' }, { now, ttlMs: 60_000 });
    expect(readTurnLease(doc, now)?.holderSub).toBe('a');

    // Holder still online — keep lease
    expect(clearLeaseIfHolderOffline(doc, new Set(['a', 'b']), now)).toBe(false);
    expect(readTurnLease(doc, now)?.holderSub).toBe('a');

    // Holder gone — clear so joiner can take over
    expect(clearLeaseIfHolderOffline(doc, new Set(['b']), now)).toBe(true);
    expect(readTurnLease(doc, now)).toBeNull();
    expect(canPromptWithLease(doc, 'b', now)).toBe(true);
    const take = tryAcquireLease(doc, { sub: 'b', displayName: 'Bob' }, { now, ttlMs: 1000 });
    expect(take.ok).toBe(true);
  });
});
