import { createHmac } from 'node:crypto';
import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import {
  appendSegmentToZoomUuid,
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
