import { createHmac } from 'node:crypto';
import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import {
  appendSegmentToZoomUuid,
  clearZoomSessionsForTests,
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
