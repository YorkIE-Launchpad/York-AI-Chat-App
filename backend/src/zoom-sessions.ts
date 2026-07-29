import { createHmac, randomUUID, timingSafeEqual } from 'crypto';

export interface ZoomRtmsSegment {
  id: string;
  text: string;
  speaker: string | null;
  speakerUserId: string | null;
  startedAt: number;
  endedAt: number;
  meetingUuid?: string | null;
}

export interface ZoomSessionRecord {
  yorkMeetingId: string;
  userSub: string;
  zoomMeetingUuid: string | null;
  zoomMeetingId: string | null;
  zoomUserId: string | null;
  segments: ZoomRtmsSegment[];
  createdAt: number;
  updatedAt: number;
}

/** In-memory session registry (single-process backend). */
const sessionsByYorkId = new Map<string, ZoomSessionRecord>();
const yorkIdByZoomUuid = new Map<string, string>();

export function mapRtmsTranscriptPacket(content: {
  user_id?: number | string;
  user_name?: string;
  start_time?: number;
  end_time?: number;
  timestamp?: number;
  data?: string | Buffer;
}): ZoomRtmsSegment | null {
  const raw =
    typeof content.data === 'string'
      ? content.data
      : Buffer.isBuffer(content.data)
        ? content.data.toString('utf8')
        : '';
  const text = raw.trim();
  if (!text) return null;
  const startedAt =
    typeof content.start_time === 'number'
      ? content.start_time
      : typeof content.timestamp === 'number'
        ? content.timestamp
        : Date.now();
  const endedAt = typeof content.end_time === 'number' ? content.end_time : startedAt;
  return {
    id: randomUUID(),
    text,
    speaker:
      typeof content.user_name === 'string' && content.user_name.trim()
        ? content.user_name.trim()
        : null,
    speakerUserId: content.user_id != null ? String(content.user_id) : null,
    startedAt,
    endedAt,
  };
}

export function registerZoomSession(input: {
  yorkMeetingId: string;
  userSub: string;
  zoomMeetingUuid?: string | null;
  zoomMeetingId?: string | null;
  zoomUserId?: string | null;
}): ZoomSessionRecord {
  const existing = sessionsByYorkId.get(input.yorkMeetingId);
  const now = Date.now();
  const record: ZoomSessionRecord = {
    yorkMeetingId: input.yorkMeetingId,
    userSub: input.userSub,
    zoomMeetingUuid: input.zoomMeetingUuid ?? existing?.zoomMeetingUuid ?? null,
    zoomMeetingId: input.zoomMeetingId ?? existing?.zoomMeetingId ?? null,
    zoomUserId: input.zoomUserId ?? existing?.zoomUserId ?? null,
    segments: existing?.segments ?? [],
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  sessionsByYorkId.set(record.yorkMeetingId, record);
  if (record.zoomMeetingUuid) {
    yorkIdByZoomUuid.set(record.zoomMeetingUuid, record.yorkMeetingId);
  }
  return record;
}

export function unlinkZoomSession(yorkMeetingId: string, userSub: string): boolean {
  const record = sessionsByYorkId.get(yorkMeetingId);
  if (!record || record.userSub !== userSub) return false;
  if (record.zoomMeetingUuid) {
    yorkIdByZoomUuid.delete(record.zoomMeetingUuid);
  }
  sessionsByYorkId.delete(yorkMeetingId);
  return true;
}

export function getZoomSession(yorkMeetingId: string, userSub: string): ZoomSessionRecord | null {
  const record = sessionsByYorkId.get(yorkMeetingId);
  if (!record || record.userSub !== userSub) return null;
  return record;
}

export function bindZoomUuidToSession(zoomMeetingUuid: string, yorkMeetingId: string): void {
  const record = sessionsByYorkId.get(yorkMeetingId);
  if (!record) return;
  record.zoomMeetingUuid = zoomMeetingUuid;
  record.updatedAt = Date.now();
  yorkIdByZoomUuid.set(zoomMeetingUuid, yorkMeetingId);
}

/**
 * Resolve which York session should receive RTMS packets for a Zoom meeting UUID.
 * Falls back to the most recently updated unbound session when UUID was unknown at register time.
 */
export function resolveSessionForZoomUuid(zoomMeetingUuid: string): ZoomSessionRecord | null {
  const yorkId = yorkIdByZoomUuid.get(zoomMeetingUuid);
  if (yorkId) {
    return sessionsByYorkId.get(yorkId) || null;
  }
  let latest: ZoomSessionRecord | null = null;
  for (const record of sessionsByYorkId.values()) {
    if (record.zoomMeetingUuid) continue;
    if (!latest || record.updatedAt > latest.updatedAt) {
      latest = record;
    }
  }
  if (latest) {
    bindZoomUuidToSession(zoomMeetingUuid, latest.yorkMeetingId);
  }
  return latest;
}

export function appendSegmentToZoomUuid(
  zoomMeetingUuid: string,
  segment: ZoomRtmsSegment
): ZoomSessionRecord | null {
  const session = resolveSessionForZoomUuid(zoomMeetingUuid);
  if (!session) return null;
  segment.meetingUuid = zoomMeetingUuid;
  session.segments.push(segment);
  session.updatedAt = Date.now();
  return session;
}

export function listSegmentsAfter(
  yorkMeetingId: string,
  userSub: string,
  after: number
): { segments: ZoomRtmsSegment[]; nextCursor: number } {
  const session = getZoomSession(yorkMeetingId, userSub);
  if (!session) {
    return { segments: [], nextCursor: after };
  }
  const start = Math.max(0, after);
  const segments = session.segments.slice(start);
  return { segments, nextCursor: start + segments.length };
}

/** Zoom webhook signature: v0:{timestamp}:{body} HMAC-SHA256 hex. */
export function verifyZoomWebhookSignature(input: {
  body: string;
  timestamp: string;
  signature: string;
  secretToken: string;
}): boolean {
  const { body, timestamp, signature, secretToken } = input;
  if (!secretToken || !timestamp || !signature) return false;
  const message = `v0:${timestamp}:${body}`;
  const expected = `v0=${createHmac('sha256', secretToken).update(message).digest('hex')}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function clearZoomSessionsForTests(): void {
  sessionsByYorkId.clear();
  yorkIdByZoomUuid.clear();
}
