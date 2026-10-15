/**
 * Public Slack Events API endpoint for the remote-control relay.
 * Mounted before Cognito; every request must carry a valid Slack signature.
 */
import express, { type Request, type Response, type Router } from 'express';
import type { SlackRelayConfig } from './config.js';
import type { InboundSlackMessage, SlackRelayHub } from './relay-hub.js';
import { verifySlackSignature } from './signature.js';
import { logWarn } from '../safe-log.js';

export const SLACK_EVENTS_BODY_LIMIT = '64kb';

function header(req: Request, name: string): string | undefined {
  const value = req.headers[name];
  if (Array.isArray(value)) return value[0];
  return typeof value === 'string' ? value : undefined;
}

/** Narrow a signed event_callback to a plain-text 1:1 DM from a human. */
export function toInboundMessage(
  body: Record<string, unknown>,
  config: SlackRelayConfig
): InboundSlackMessage | null {
  if (body.type !== 'event_callback') return null;
  if (body.api_app_id !== config.appId || body.team_id !== config.teamId) return null;

  const eventId = typeof body.event_id === 'string' ? body.event_id : '';
  const event =
    body.event && typeof body.event === 'object' ? (body.event as Record<string, unknown>) : null;
  if (!eventId || !event) return null;

  if (event.type !== 'message' || event.channel_type !== 'im') return null;
  if (event.subtype !== undefined || event.bot_id !== undefined || event.files !== undefined) {
    return null;
  }

  const userId = typeof event.user === 'string' ? event.user : '';
  const channel = typeof event.channel === 'string' ? event.channel : '';
  const text = typeof event.text === 'string' ? event.text.trim() : '';
  const ts = typeof event.ts === 'string' ? event.ts : '';
  if (!/^[UW][A-Z0-9]{1,30}$/.test(userId) || !/^D[A-Z0-9]{1,30}$/.test(channel) || !text || !ts) {
    return null;
  }

  const threadTs = typeof event.thread_ts === 'string' ? event.thread_ts : undefined;
  return { eventId, teamId: config.teamId, userId, channel, text, ts, threadTs };
}

export function createSlackEventsRouter(deps: {
  config: SlackRelayConfig | null;
  hub: SlackRelayHub | null;
}): Router {
  const router = express.Router();

  router.post(
    '/events',
    express.raw({ type: () => true, limit: SLACK_EVENTS_BODY_LIMIT }),
    (req: Request, res: Response) => {
      const { config, hub } = deps;
      if (!config || !hub) {
        res.status(503).json({ error: 'slack_relay_disabled' });
        return;
      }

      const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
      const signed = verifySlackSignature({
        rawBody,
        timestamp: header(req, 'x-slack-request-timestamp'),
        signature: header(req, 'x-slack-signature'),
        signingSecret: config.signingSecret,
      });
      if (!signed) {
        res.status(401).json({ error: 'invalid_signature' });
        return;
      }

      let body: Record<string, unknown>;
      try {
        const parsed = JSON.parse(rawBody) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
        body = parsed as Record<string, unknown>;
      } catch {
        res.status(400).json({ error: 'invalid_json' });
        return;
      }

      if (body.type === 'url_verification') {
        const challenge = typeof body.challenge === 'string' ? body.challenge : '';
        res.status(200).json({ challenge });
        return;
      }

      // Ack first: Slack retries anything slower than 3s. Retries are never reprocessed.
      res.status(200).json({ ok: true });
      if (header(req, 'x-slack-retry-num')) return;

      const message = toInboundMessage(body, config);
      if (!message) return;
      void hub
        .handleInbound(message)
        .catch((error) => logWarn('[slack-relay] inbound handling failed', error));
    }
  );

  return router;
}
