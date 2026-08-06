import { createHmac } from 'node:crypto';
import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import {
  appendSegmentToZoomUuid,
  backfillSpeakerNames,
  clearZoomSessionsForTests,
  getOrphanSegmentCountForTests,
  listSegmentsAfter,
  mapRtmsTranscriptPacket,
  registerZoomSession,
  verifyZoomWebhookSignature,
} from './zoom-sessions.js';

describe('zoom-sessions', () => {
  beforeEach(() => {
    clearZoomSessionsForTests();
  });

  it('maps RTMS transcript packets', () => {
    const segment = mapRtmsTranscriptPacket({
      user_id: 1,
      user_name: 'Ada',
      data: 'hello',
      start_time: 10,
      end_time: 20,
    });
    assert.ok(segment);
    assert.equal(segment.speaker, 'Ada');
    assert.equal(segment.text, 'hello');
  });

  it('maps speaker from userName camelCase metadata', () => {
    const segment = mapRtmsTranscriptPacket({
      userId: 42,
      userName: 'Grace',
      data: 'hello camel',
      timestamp: 100,
    });
    assert.ok(segment);
    assert.equal(segment.speaker, 'Grace');
    assert.equal(segment.speakerUserId, '42');
  });

  it('lists segments after cursor', () => {
    registerZoomSession({ yorkMeetingId: 'y1', userSub: 'u1', zoomMeetingUuid: 'z1' });
    appendSegmentToZoomUuid('z1', {
      id: 'a',
      text: 'hi',
      speaker: 'Ada',
      speakerUserId: '1',
      startedAt: 1,
      endedAt: 2,
    });
    const page = listSegmentsAfter('y1', 'u1', 0);
    assert.equal(page.segments.length, 1);
    assert.equal(page.nextCursor, 1);
    assert.deepEqual(page.speakerUpdates, []);
  });

  it('buffers orphan segments and flushes them on register', () => {
    appendSegmentToZoomUuid('orphan-uuid', {
      id: 'o1',
      text: 'early',
      speaker: 'Ada',
      speakerUserId: '1',
      startedAt: Date.now(),
      endedAt: Date.now(),
    });
    assert.equal(getOrphanSegmentCountForTests('orphan-uuid'), 1);

    registerZoomSession({
      yorkMeetingId: 'late-york',
      userSub: 'u1',
      zoomMeetingUuid: 'orphan-uuid',
    });
    assert.equal(getOrphanSegmentCountForTests('orphan-uuid'), 0);

    const page = listSegmentsAfter('late-york', 'u1', 0);
    assert.equal(page.segments.length, 1);
    assert.equal(page.segments[0]?.text, 'early');
    assert.equal(page.segments[0]?.speaker, 'Ada');
  });

  it('backfills null speakers when roster later learns a name', () => {
    registerZoomSession({ yorkMeetingId: 'y2', userSub: 'u1', zoomMeetingUuid: 'z2' });
    appendSegmentToZoomUuid('z2', {
      id: 's1',
      text: 'first',
      speaker: null,
      speakerUserId: '7',
      startedAt: 1,
      endedAt: 2,
    });
    appendSegmentToZoomUuid('z2', {
      id: 's2',
      text: 'second',
      speaker: null,
      speakerUserId: '7',
      startedAt: 3,
      endedAt: 4,
    });
    appendSegmentToZoomUuid('z2', {
      id: 's3',
      text: 'other',
      speaker: null,
      speakerUserId: '8',
      startedAt: 5,
      endedAt: 6,
    });

    const updated = backfillSpeakerNames('z2', 7, 'Grace');
    assert.equal(updated, 2);

    const page = listSegmentsAfter('y2', 'u1', 0);
    assert.equal(page.segments[0]?.speaker, 'Grace');
    assert.equal(page.segments[1]?.speaker, 'Grace');
    assert.equal(page.segments[2]?.speaker, null);
    assert.equal(page.speakerUpdates.length, 2);
    assert.equal(page.speakerUpdates[0]?.speaker, 'Grace');
  });

  it('delivers speakerUpdates after client cursor advanced past unlabeled segments', () => {
    registerZoomSession({ yorkMeetingId: 'y-late', userSub: 'u1', zoomMeetingUuid: 'z-late' });
    appendSegmentToZoomUuid('z-late', {
      id: 'early-1',
      text: 'hello',
      speaker: null,
      speakerUserId: '11',
      startedAt: 1,
      endedAt: 2,
    });
    appendSegmentToZoomUuid('z-late', {
      id: 'early-2',
      text: 'world',
      speaker: null,
      speakerUserId: '11',
      startedAt: 3,
      endedAt: 4,
    });

    // Desktop polls and advances cursor past both segments.
    const first = listSegmentsAfter('y-late', 'u1', 0);
    assert.equal(first.segments.length, 2);
    assert.equal(first.nextCursor, 2);
    assert.equal(first.speakerUpdates.length, 0);

    // Roster learns the name after segments were already delivered.
    assert.equal(backfillSpeakerNames('z-late', 11, 'Grace'), 2);

    // No new segments, but speakerUpdates must still surface the labels.
    const second = listSegmentsAfter('y-late', 'u1', first.nextCursor);
    assert.equal(second.segments.length, 0);
    assert.equal(second.nextCursor, 2);
    assert.equal(second.speakerUpdates.length, 2);
    assert.deepEqual(
      second.speakerUpdates
        .map((u) => ({ id: u.id, speaker: u.speaker }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      [
        { id: 'early-1', speaker: 'Grace' },
        { id: 'early-2', speaker: 'Grace' },
      ]
    );

    // Updates drain; subsequent poll is empty.
    const third = listSegmentsAfter('y-late', 'u1', second.nextCursor);
    assert.equal(third.speakerUpdates.length, 0);
  });

  it('backfills orphan segments before register', () => {
    appendSegmentToZoomUuid('orphan-bf', {
      id: 'o1',
      text: 'early',
      speaker: null,
      speakerUserId: '3',
      startedAt: Date.now(),
      endedAt: Date.now(),
    });
    assert.equal(backfillSpeakerNames('orphan-bf', '3', 'Lin'), 1);

    registerZoomSession({
      yorkMeetingId: 'york-bf',
      userSub: 'u1',
      zoomMeetingUuid: 'orphan-bf',
    });
    const page = listSegmentsAfter('york-bf', 'u1', 0);
    assert.equal(page.segments[0]?.speaker, 'Lin');
  });

  it('verifies webhook signatures', () => {
    const body = '{"ok":true}';
    const timestamp = '1';
    const secret = 'secret';
    const signature = `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex')}`;
    assert.equal(
      verifyZoomWebhookSignature({ body, timestamp, signature, secretToken: secret }),
      true
    );
  });
});
