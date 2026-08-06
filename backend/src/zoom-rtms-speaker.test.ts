import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  extractSpeakerFromMetadata,
  metadataKeysPresent,
  RtmsSpeakerRoster,
} from './zoom-rtms-speaker.js';

describe('extractSpeakerFromMetadata', () => {
  it('reads userName from transcript metadata', () => {
    const result = extractSpeakerFromMetadata({ userName: 'Ada', userId: 1 });
    assert.equal(result.user_name, 'Ada');
    assert.equal(result.user_id, 1);
  });

  it('reads nested user.name aliases', () => {
    const result = extractSpeakerFromMetadata({
      user: { name: 'Grace', id: 42 },
    });
    assert.equal(result.user_name, 'Grace');
    assert.equal(result.user_id, 42);
  });

  it('ignores empty userName but keeps userId', () => {
    const result = extractSpeakerFromMetadata({ userName: '  ', userId: 7 });
    assert.equal(result.user_name, undefined);
    assert.equal(result.user_id, 7);
  });

  it('lists metadata keys for diagnostics', () => {
    assert.deepEqual(metadataKeysPresent({ userId: 1, userName: '' }), ['userId', 'userName']);
  });
});

describe('RtmsSpeakerRoster', () => {
  it('prefers metadata name over roster', () => {
    const roster = new RtmsSpeakerRoster();
    roster.set(7, 'Grace');
    const resolved = roster.resolveForTranscript({ userName: 'Ada', userId: 7 });
    assert.equal(resolved.user_name, 'Ada');
    assert.equal(resolved.user_id, 7);
  });

  it('resolves empty userName via roster userId', () => {
    const roster = new RtmsSpeakerRoster();
    roster.set(7, 'Grace');
    const resolved = roster.resolveForTranscript({ userName: '', userId: 7 });
    assert.equal(resolved.user_name, 'Grace');
    assert.equal(resolved.user_id, 7);
  });

  it('falls back to active speaker for matching userId', () => {
    const roster = new RtmsSpeakerRoster();
    roster.setActiveSpeaker(9, 'Lin');
    const resolved = roster.resolveForTranscript({ userName: null, userId: 9 });
    assert.equal(resolved.user_name, 'Lin');
    assert.equal(resolved.user_id, 9);
  });

  it('uses last active speaker when metadata name and userId are empty', () => {
    const roster = new RtmsSpeakerRoster();
    roster.setActiveSpeaker(3, 'Ada');
    const resolved = roster.resolveForTranscript({ userName: '', userId: null });
    assert.equal(resolved.user_name, 'Ada');
    assert.equal(String(resolved.user_id), '3');
  });

  it('uses last active speaker when userId is unknown', () => {
    const roster = new RtmsSpeakerRoster();
    roster.setActiveSpeaker(1, 'Other');
    const resolved = roster.resolveForTranscript({ userName: '', userId: 99 });
    assert.equal(resolved.user_name, 'Other');
    assert.equal(resolved.user_id, 99);
    assert.equal(roster.size, 1);
    assert.equal(roster.hasActiveSpeaker, true);
  });

  it('returns no name when roster and active speaker are empty', () => {
    const roster = new RtmsSpeakerRoster();
    const resolved = roster.resolveForTranscript({ userName: '', userId: 99 });
    assert.equal(resolved.user_name, undefined);
    assert.equal(resolved.user_id, 99);
  });

  it('set returns false when name unchanged', () => {
    const roster = new RtmsSpeakerRoster();
    assert.equal(roster.set(1, 'Ada'), true);
    assert.equal(roster.set(1, 'Ada'), false);
    assert.equal(roster.set(1, 'Bob'), true);
  });
});
