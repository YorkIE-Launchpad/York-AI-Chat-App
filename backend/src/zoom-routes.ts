import { createHmac } from 'crypto';
import type { Request, Response, Router } from 'express';
import { Router as createRouter } from 'express';
import { requireCognito } from './cognito-auth.js';
import {
  appendSegmentToZoomUuid,
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

type RtmsClient = {
  onTranscriptData: (
    cb: (data: Buffer | string, size: number, timestamp: number, metadata: unknown) => void
  ) => void;
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
}

function extractMeetingUuid(eventBody: Record<string, unknown>): string | null {
  const payloadObject = (eventBody as { payload?: { object?: { meeting_uuid?: string } } }).payload
    ?.object;
  if (payloadObject && typeof payloadObject.meeting_uuid === 'string') {
    return payloadObject.meeting_uuid;
  }
  return null;
}

function extractSpeakerFromMetadata(metadata: unknown): {
  user_name?: string;
  user_id?: string | number;
} {
  if (!metadata || typeof metadata !== 'object') return {};
  const meta = metadata as Record<string, unknown>;
  const nested =
    meta.user && typeof meta.user === 'object' ? (meta.user as Record<string, unknown>) : null;

  const nameCandidates = [
    meta.userName,
    meta.user_name,
    meta.speakerName,
    meta.speaker_name,
    meta.speaker,
    nested?.userName,
    nested?.user_name,
    nested?.name,
  ];
  const idCandidates = [
    meta.userId,
    meta.user_id,
    meta.speakerUserId,
    meta.speaker_user_id,
    nested?.userId,
    nested?.user_id,
    nested?.id,
  ];

  let user_name: string | undefined;
  for (const value of nameCandidates) {
    if (typeof value === 'string' && value.trim()) {
      user_name = value.trim();
      break;
    }
  }
  let user_id: string | number | undefined;
  for (const value of idCandidates) {
    if (value != null && String(value).trim()) {
      user_id = value as string | number;
      break;
    }
  }
  return { user_name, user_id };
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
      console.log('[york-ie-backend] RTMS join invoked', `meetingUuid=${meetingUuid}`);
      const client = new Client();
      applyZoomRtmsTranscriptParams(client);
      client.onTranscriptData((data, _size, timestamp, metadata) => {
        const speakerMeta = extractSpeakerFromMetadata(metadata);
        const segment = mapRtmsTranscriptPacket({
          data,
          timestamp,
          user_name: speakerMeta.user_name,
          user_id: speakerMeta.user_id,
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
