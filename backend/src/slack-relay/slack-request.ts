/**
 * Shared plumbing for Slack-signed HTTP endpoints (interactivity, slash commands).
 *
 * Slack's 3-second rule: every handler must answer within 3s or Slack shows
 * "operation_timeout" / retries. Handlers therefore only verify, parse, and do
 * in-memory checks before responding; Slack Web API calls and relay frames run
 * afterwards via `afterAck`.
 */
import express, { type Request, type RequestHandler } from 'express';
import type { SlackRelayConfig } from './config.js';
import type { OwnerActionResult } from './relay-hub.js';
import type { SlackApi } from './slack-api.js';
import { verifySlackSignature } from './signature.js';
import { logWarn } from '../safe-log.js';

export const SLACK_FORM_BODY_LIMIT = '64kb';

export const rawSlackBody: RequestHandler = express.raw({
  type: () => true,
  limit: SLACK_FORM_BODY_LIMIT,
});

function header(req: Request, name: string): string | undefined {
  const value = req.headers[name];
  if (Array.isArray(value)) return value[0];
  return typeof value === 'string' ? value : undefined;
}

/** Raw body when the Slack signature is valid, otherwise null. */
export function verifiedRawBody(req: Request, config: SlackRelayConfig): string | null {
  const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
  const signed = verifySlackSignature({
    rawBody,
    timestamp: header(req, 'x-slack-request-timestamp'),
    signature: header(req, 'x-slack-signature'),
    signingSecret: config.signingSecret,
  });
  return signed ? rawBody : null;
}

/** Run work after the HTTP response has been handed to the socket. */
export function afterAck(label: string, work: () => void | Promise<void>): void {
  setImmediate(() => {
    Promise.resolve()
      .then(work)
      .catch((error) => logWarn(`[slack-relay] ${label} failed`, error));
  });
}

const RESULT_MESSAGES: Record<Exclude<OwnerActionResult, 'ok'>, string> = {
  offline:
    'York IE GrowthOS is not connected on your computer right now. Open York IE GrowthOS and turn on "Control York IE GrowthOS from Slack" to continue.',
  outdated:
    'Update York IE GrowthOS on your computer to use buttons and slash commands from Slack.',
  unknown: 'This request is no longer active.',
  expired: 'This request expired. Ask York IE GrowthOS again if you still need it.',
  rate_limited: 'That was a lot of requests in a short time. Try again in a minute.',
  incomplete: 'Pick an answer for every question first, then press Submit.',
};

export function resultMessage(result: Exclude<OwnerActionResult, 'ok'>): string {
  return RESULT_MESSAGES[result];
}

export function ephemeral(text: string): Record<string, unknown> {
  return { response_type: 'ephemeral', replace_original: false, text };
}

/** Best-effort ephemeral follow-up through a `response_url` (never on the ack path). */
export async function respondEphemeral(
  api: SlackApi,
  responseUrl: unknown,
  text: string
): Promise<void> {
  if (typeof responseUrl !== 'string') return;
  await api.respond(responseUrl, ephemeral(text));
}
