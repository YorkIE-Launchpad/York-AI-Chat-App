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

let rtmsJoin: RtmsJoinFn | null = null;

/**
 * Optionally wire a live RTMS joiner (e.g. @zoom/rtms Client).
 * When unset, webhook events are accepted and CRC works; transcripts can still be
 * injected via tests / future joiners.
 */
export function setZoomRtmsJoiner(join: RtmsJoinFn | null): void {
  rtmsJoin = join;
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
        Client: new () => {
          onTranscriptData: (
            cb: (
              data: Buffer | string,
              size: number,
              timestamp: number,
              metadata: { userName?: string; userId?: number | string }
            ) => void
          ) => void;
          join: (payload: unknown) => void;
        };
      };
      Client?: new () => {
        onTranscriptData: (
          cb: (
            data: Buffer | string,
            size: number,
            timestamp: number,
            metadata: { userName?: string; userId?: number | string }
          ) => void
        ) => void;
        join: (payload: unknown) => void;
      };
    };
    const Client = mod.default?.Client || mod.Client;
    if (!Client) return;
    rtmsJoin = (eventBody) => {
      const client = new Client();
      const payloadObject = (eventBody as { payload?: { object?: { meeting_uuid?: string } } })
        .payload?.object;
      const meetingUuid =
        payloadObject && typeof payloadObject.meeting_uuid === 'string'
          ? payloadObject.meeting_uuid
          : null;
      console.log('[york-ie-backend] RTMS join invoked', `meetingUuid=${meetingUuid || 'missing'}`);
      client.onTranscriptData((data, _size, timestamp, metadata) => {
        if (!meetingUuid) return;
        const segment = mapRtmsTranscriptPacket({
          data,
          timestamp,
          user_name: metadata?.userName,
          user_id: metadata?.userId,
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
