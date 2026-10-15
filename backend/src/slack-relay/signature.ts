import { createHmac, timingSafeEqual } from 'node:crypto';

export const SLACK_SIGNATURE_MAX_SKEW_SECONDS = 300;

/**
 * Slack v0 request signature check over the exact raw request body.
 * https://api.slack.com/authentication/verifying-requests-from-slack
 */
export function verifySlackSignature(input: {
  rawBody: string;
  timestamp: string | undefined;
  signature: string | undefined;
  signingSecret: string;
  nowSeconds?: number;
}): boolean {
  const { rawBody, timestamp, signature, signingSecret } = input;
  if (!signingSecret || !timestamp || !signature) return false;
  if (!/^\d{1,12}$/.test(timestamp)) return false;
  if (!/^v0=[0-9a-f]{64}$/.test(signature)) return false;

  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > SLACK_SIGNATURE_MAX_SKEW_SECONDS) return false;

  const expected = `v0=${createHmac('sha256', signingSecret)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest('hex')}`;
  const a = Buffer.from(signature, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
