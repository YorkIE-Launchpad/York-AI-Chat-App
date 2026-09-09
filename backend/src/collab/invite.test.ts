import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { signCollabInvite, verifyCollabInvite } from './invite.js';

describe('collab invite', () => {
  it('signs and verifies an invite for a room', () => {
    const token = signCollabInvite('room-abc', { nowSec: 1_700_000_000, ttlSec: 3600 });
    const result = verifyCollabInvite(token, 'room-abc', { nowSec: 1_700_000_100 });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.payload.roomId, 'room-abc');
      assert.equal(result.payload.exp, 1_700_000_000 + 3600);
    }
  });

  it('rejects expired invites', () => {
    const token = signCollabInvite('room-abc', { nowSec: 1_700_000_000, ttlSec: 60 });
    const result = verifyCollabInvite(token, 'room-abc', { nowSec: 1_700_000_100 });
    assert.equal(result.ok, false);
  });

  it('rejects roomId mismatch', () => {
    const token = signCollabInvite('room-a');
    const result = verifyCollabInvite(token, 'room-b');
    assert.equal(result.ok, false);
  });

  it('rejects tampered tokens', () => {
    const token = signCollabInvite('room-abc');
    const parts = token.split('.');
    parts[2] = parts[2].replace(/[A-Za-z]/, (c) => (c === 'A' ? 'B' : 'A'));
    const result = verifyCollabInvite(parts.join('.'), 'room-abc');
    assert.equal(result.ok, false);
  });
});
