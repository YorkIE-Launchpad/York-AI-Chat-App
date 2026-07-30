/**
 * Build a Slack archive permalink from channel id + message timestamp.
 * Slack ts "1234567890.123456" → /p1234567890123456
 */
export function buildSlackPermalink(channelId: string, ts: string): string {
  const tsWithoutDot = ts.replace(/\./g, '');
  return `https://app.slack.com/archives/${channelId}/p${tsWithoutDot}`;
}

/** Prefer an API-provided permalink; otherwise build from channel id + ts. */
export function resolveSlackPermalink(input: {
  permalink?: string | null;
  channelId?: string | null;
  ts?: string | null;
}): string | null {
  const permalink = typeof input.permalink === 'string' ? input.permalink.trim() : '';
  if (/^https?:\/\//i.test(permalink)) {
    return permalink;
  }
  const channelId = typeof input.channelId === 'string' ? input.channelId.trim() : '';
  const ts = typeof input.ts === 'string' ? input.ts.trim() : '';
  if (channelId && ts) {
    return buildSlackPermalink(channelId, ts);
  }
  return null;
}
