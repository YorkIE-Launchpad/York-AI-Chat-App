import { createHmac } from 'crypto';
import type { Request, Response, Router } from 'express';
import { Router as createRouter } from 'express';
import { requireCognito } from './cognito-auth.js';
import {
  extractSpeakerFromMetadata,
  metadataKeysPresent,
  RtmsSpeakerRoster,
} from './zoom-rtms-speaker.js';
import {
  appendSegmentToZoomUuid,
  backfillSpeakerNames,
  listSegmentsAfter,
  mapRtmsTranscriptPacket,
  registerZoomSession,
  unlinkZoomSession,
  verifyZoomWebhookSignature,
} from './zoom-sessions.js';

type CognitoRequest = Request & {
  cognito?: { payload?: Record<string, unknown> };
};

function userSubFromReq(req: CognitoRequest): string | null {
  const payload = req.cognito?.payload;
  const sub = payload?.sub;
  return typeof sub === 'string' && sub.trim() ? sub.trim() : null;
}

type RtmsJoinFn = (payload: Record<string, unknown>) => void;

type RtmsParticipantInfo = { id?: number; name?: string };
type RtmsEventParticipant = { userId?: number; userName?: string };

type RtmsClient = {
  onTranscriptData: (
    cb: (data: Buffer | string, size: number, timestamp: number, metadata: unknown) => void
  ) => void;
  onUserUpdate?: (cb: (op: number, participant: RtmsParticipantInfo) => void) => unknown;
  onParticipantEvent?: (
    cb: (event: 'join' | 'leave', timestamp: number, participants: RtmsEventParticipant[]) => void
  ) => unknown;
  onActiveSpeakerEvent?: (
    cb: (timestamp: number, userId: number, userName: string) => void
  ) => unknown;
  setTranscriptParams?: (params: { srcLanguage: number; enableLid: boolean }) => unknown;
  join: (payload: unknown) => void;
};

/** Zoom RTMS ENGLISH = 9. Prefer English ASR; LID still allows Hindi detection. */
export const ZOOM_RTMS_TRANSCRIPT_PARAMS = {
  srcLanguage: 9,
  enableLid: true,
} as const;

/**
 * Apply York meeting transcript language policy before join.
 * English primary + LID so Hindi (and imperfect Gujarati) can still be recognized,
 * then desktop translates HI/GU text to English.
 */
export function applyZoomRtmsTranscriptParams(client: {
  setTranscriptParams?: (params: { srcLanguage: number; enableLid: boolean }) => unknown;
}): void {
  if (typeof client.setTranscriptParams !== 'function') {
    console.warn(
      '[york-ie-backend] RTMS client missing setTranscriptParams — skipping language hint'
    );
    return;
  }
  client.setTranscriptParams({ ...ZOOM_RTMS_TRANSCRIPT_PARAMS });
  console.log(
    '[york-ie-backend] RTMS transcript params applied',
    `srcLanguage=ENGLISH(${ZOOM_RTMS_TRANSCRIPT_PARAMS.srcLanguage})`,
    `enableLid=${ZOOM_RTMS_TRANSCRIPT_PARAMS.enableLid}`
  );
}

let rtmsJoin: RtmsJoinFn | null = null;

/** Active RTMS joins keyed by meeting UUID — avoid stacking duplicate SDK clients. */
const activeRtmsJoins = new Set<string>();

/** Meetings that already logged a missing-speaker diagnostic (once per join). */
const missingSpeakerDiagLogged = new Set<string>();

/**
 * Optionally wire a live RTMS joiner (e.g. @zoom/rtms Client).
 * When unset, webhook events are accepted and CRC works; transcripts can still be
 * injected via tests / future joiners.
 */
export function setZoomRtmsJoiner(join: RtmsJoinFn | null): void {
  rtmsJoin = join;
}

/** Test helper to clear active join tracking. */
export function clearActiveRtmsJoinsForTests(): void {
  activeRtmsJoins.clear();
  missingSpeakerDiagLogged.clear();
}

function extractMeetingUuid(eventBody: Record<string, unknown>): string | null {
  const payloadObject = (eventBody as { payload?: { object?: { meeting_uuid?: string } } }).payload
    ?.object;
  if (payloadObject && typeof payloadObject.meeting_uuid === 'string') {
    return payloadObject.meeting_uuid;
  }
  return null;
}

function rememberParticipantName(
  meetingUuid: string,
  roster: RtmsSpeakerRoster,
  userId: string | number | null | undefined,
  name: string | null | undefined
): void {
  const changed = roster.set(userId, name);
  if (!changed || userId == null || !name?.trim()) return;
  const backfilled = backfillSpeakerNames(meetingUuid, userId, name.trim());
  if (backfilled > 0) {
    console.log(
      '[york-ie-backend] RTMS speaker backfill',
      `meetingUuid=${meetingUuid}`,
      `userId=${userId}`,
      `speaker=${name.trim()}`,
      `count=${backfilled}`
    );
  }
}

async function tryLoadZoomRtmsSdk(): Promise<void> {
  if (rtmsJoin) return;
  process.env.ZM_RTMS_CLIENT =
    process.env.ZM_RTMS_CLIENT || process.env.ZOOM_CONNECTOR_CLIENT_ID || '';
  process.env.ZM_RTMS_SECRET =
    process.env.ZM_RTMS_SECRET || process.env.ZOOM_CONNECTOR_CLIENT_SECRET || '';
  const clientId = process.env.ZM_RTMS_CLIENT.trim();
  const clientSecret = process.env.ZM_RTMS_SECRET.trim();
  if (!clientId || !clientSecret) return;
  try {
    // Optional dependency — may be absent until RTMS is provisioned.
    const rtmsPackage = '@zoom/rtms';
    const mod = (await import(rtmsPackage)) as {
      default?: {
        Client: new () => RtmsClient;
        TranscriptLanguage?: { ENGLISH?: number };
      };
      Client?: new () => RtmsClient;
      TranscriptLanguage?: { ENGLISH?: number };
    };
    const Client = mod.default?.Client || mod.Client;
    if (!Client) return;
    const englishLangId =
      mod.default?.TranscriptLanguage?.ENGLISH ?? mod.TranscriptLanguage?.ENGLISH ?? 9;
    if (englishLangId !== ZOOM_RTMS_TRANSCRIPT_PARAMS.srcLanguage) {
      console.warn(
        '[york-ie-backend] RTMS TranscriptLanguage.ENGLISH mismatch',
        `sdk=${englishLangId}`,
        `expected=${ZOOM_RTMS_TRANSCRIPT_PARAMS.srcLanguage}`
      );
    }
    rtmsJoin = (eventBody) => {
      const meetingUuid = extractMeetingUuid(eventBody);
      if (!meetingUuid) {
        console.warn('[york-ie-backend] RTMS join skipped — missing meeting_uuid');
        return;
      }
      if (activeRtmsJoins.has(meetingUuid)) {
        console.log(
          '[york-ie-backend] RTMS join already active — skipping duplicate',
          `meetingUuid=${meetingUuid}`
        );
        return;
      }
      activeRtmsJoins.add(meetingUuid);
      missingSpeakerDiagLogged.delete(meetingUuid);
      console.log('[york-ie-backend] RTMS join invoked', `meetingUuid=${meetingUuid}`);
      const client = new Client();
      const roster = new RtmsSpeakerRoster();
      applyZoomRtmsTranscriptParams(client);

      if (typeof client.onUserUpdate === 'function') {
        client.onUserUpdate((_op, participant) => {
          rememberParticipantName(meetingUuid, roster, participant?.id, participant?.name);
        });
      }
      if (typeof client.onParticipantEvent === 'function') {
        client.onParticipantEvent((_event, _ts, participants) => {
          for (const p of participants || []) {
            rememberParticipantName(meetingUuid, roster, p?.userId, p?.userName);
          }
        });
      }
      if (typeof client.onActiveSpeakerEvent === 'function') {
        client.onActiveSpeakerEvent((_ts, userId, userName) => {
          const changed = roster.setActiveSpeaker(userId, userName);
          if (changed) {
            const backfilled = backfillSpeakerNames(meetingUuid, userId, userName);
            if (backfilled > 0) {
              console.log(
                '[york-ie-backend] RTMS speaker backfill',
                `meetingUuid=${meetingUuid}`,
                `userId=${userId}`,
                `speaker=${userName}`,
                `count=${backfilled}`
              );
            }
          }
        });
      }

      client.onTranscriptData((data, _size, timestamp, metadata) => {
        const speakerMeta = extractSpeakerFromMetadata(metadata);
        const resolved = roster.resolveForTranscript({
          userName: speakerMeta.user_name,
          userId: speakerMeta.user_id,
        });
        const segment = mapRtmsTranscriptPacket({
          data,
          timestamp,
          user_name: resolved.user_name,
          user_id: resolved.user_id,
        });
        if (segment) {
          appendSegmentToZoomUuid(meetingUuid, segment);
          console.log(
            '[york-ie-backend] RTMS transcript received',
            `meetingUuid=${meetingUuid}`,
            `speaker=${segment.speaker || 'unknown'}`,
            `chars=${segment.text.length}`,
            `ts=${timestamp}`
          );
          if (!segment.speaker && !missingSpeakerDiagLogged.has(meetingUuid)) {
            missingSpeakerDiagLogged.add(meetingUuid);
            console.warn(
              '[york-ie-backend] RTMS speaker unresolved',
              `meetingUuid=${meetingUuid}`,
              `userId=${segment.speakerUserId ?? 'n/a'}`,
              `metadataKeys=${metadataKeysPresent(metadata).join(',') || 'none'}`,
              `rosterSize=${roster.size}`,
              `hasActiveSpeaker=${roster.hasActiveSpeaker}`
            );
          }
        }
      });
      const joinPayload = (eventBody as { payload?: unknown }).payload;
      client.join(joinPayload || eventBody);
    };
    console.log('[york-ie-backend] Zoom RTMS SDK joiner ready');
  } catch {
    console.warn(
      '[york-ie-backend] @zoom/rtms not available — webhook CRC/register work; install @zoom/rtms for live join'
    );
  }
}

void tryLoadZoomRtmsSdk();

function handleZoomWebhook(req: Request, res: Response): void {
  const body = req.body as Record<string, unknown>;
  if (body?.event === 'endpoint.url_validation') {
    const plainToken =
      body.payload && typeof body.payload === 'object'
        ? (body.payload as { plainToken?: string }).plainToken
        : undefined;
    const secret = process.env.ZOOM_WEBHOOK_SECRET_TOKEN?.trim() || '';
    if (!plainToken || !secret) {
      res.status(400).json({ error: 'Missing plainToken or ZOOM_WEBHOOK_SECRET_TOKEN' });
      return;
    }
    const encryptedToken = createHmac('sha256', secret).update(plainToken).digest('hex');
    res.json({ plainToken, encryptedToken });
    return;
  }

  const secret = process.env.ZOOM_WEBHOOK_SECRET_TOKEN?.trim() || '';
  const signature = String(req.header('x-zm-signature') || '');
  const timestamp = String(req.header('x-zm-request-timestamp') || '');
  const rawBody =
    typeof (req as Request & { rawBody?: string }).rawBody === 'string'
      ? (req as Request & { rawBody: string }).rawBody
      : JSON.stringify(body);

  if (
    secret &&
    !verifyZoomWebhookSignature({ body: rawBody, timestamp, signature, secretToken: secret })
  ) {
    res.status(401).json({ error: 'Invalid Zoom webhook signature' });
    return;
  }

  const event = typeof body.event === 'string' ? body.event : '';
  console.log('[york-ie-backend] Zoom webhook event', event || 'unknown');
  if (event === 'meeting.rtms_started' && rtmsJoin) {
    try {
      rtmsJoin(body);
    } catch (error) {
      console.warn('[york-ie-backend] RTMS join failed', error);
    }
  } else if (event === 'meeting.rtms_started') {
    console.warn('[york-ie-backend] meeting.rtms_started received but rtmsJoin is unavailable');
  } else if (event === 'meeting.rtms_stopped') {
    const meetingUuid = extractMeetingUuid(body);
    if (meetingUuid) {
      activeRtmsJoins.delete(meetingUuid);
      missingSpeakerDiagLogged.delete(meetingUuid);
      console.log('[york-ie-backend] RTMS stopped', `meetingUuid=${meetingUuid}`);
    }
  }

  res.json({ ok: true });
}

/** Public webhook routes (no Cognito). */
export function createZoomWebhookRouter(): Router {
  const router = createRouter();
  router.post('/webhooks', handleZoomWebhook);
  return router;
}

/** Authenticated session register / poll / unregister. */
export function createZoomSessionRouter(): Router {
  const router = createRouter();
  router.use(requireCognito);

  router.post('/sessions/register', (req: CognitoRequest, res: Response) => {
    const userSub = userSubFromReq(req);
    if (!userSub) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const body = req.body as {
      yorkMeetingId?: string;
      zoomMeetingUuid?: string | null;
      zoomMeetingId?: string | null;
      zoomUserId?: string | null;
    };
    if (!body.yorkMeetingId?.trim()) {
      res.status(400).json({ error: 'yorkMeetingId required' });
      return;
    }
    const record = registerZoomSession({
      yorkMeetingId: body.yorkMeetingId.trim(),
      userSub,
      zoomMeetingUuid: body.zoomMeetingUuid,
      zoomMeetingId: body.zoomMeetingId,
      zoomUserId: body.zoomUserId,
    });
    res.json({ ok: true, session: { yorkMeetingId: record.yorkMeetingId } });
  });

  router.get('/sessions/:yorkMeetingId/segments', (req: CognitoRequest, res: Response) => {
    const userSub = userSubFromReq(req);
    if (!userSub) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const after = Number(req.query.after || 0);
    const result = listSegmentsAfter(
      String(req.params.yorkMeetingId),
      userSub,
      Number.isFinite(after) ? after : 0
    );
    res.json(result);
  });

  router.delete('/sessions/:yorkMeetingId', (req: CognitoRequest, res: Response) => {
    const userSub = userSubFromReq(req);
    if (!userSub) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const ok = unlinkZoomSession(String(req.params.yorkMeetingId), userSub);
    res.json({ ok });
  });

  return router;
}

/** @deprecated prefer createZoomWebhookRouter + createZoomSessionRouter */
export function createZoomRouter(): Router {
  const router = createRouter();
  router.use(createZoomWebhookRouter());
  router.use(createZoomSessionRouter());
  return router;
}
