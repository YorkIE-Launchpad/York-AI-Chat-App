/**
 * Channels the Slack connector must never write to, even if the user asks.
 * Matched against channel names (leading # ignored, case-insensitive).
 */
export const SLACK_WRITE_BLOCKED_CHANNELS = new Set([
  'general',
  'virtual-water-cooler',
  // Common misspelling seen in requests / channel refs
  'virtaul-water-cooler',
]);

export function normalizeSlackChannelName(input: string): string {
  return input.trim().replace(/^#/, '').toLowerCase();
}

/**
 * True when the ref names a blocked channel (#general, general, etc.).
 * Channel IDs (e.g. C0123…) do not match the blocklist by id — resolve the
 * channel first and re-check with the resolved name.
 */
export function isSlackWriteBlockedChannel(channelNameOrRef: string | null | undefined): boolean {
  if (!channelNameOrRef) return false;
  return SLACK_WRITE_BLOCKED_CHANNELS.has(normalizeSlackChannelName(channelNameOrRef));
}

export function assertSlackWriteAllowed(
  channelName: string | null | undefined,
  channelId?: string
): void {
  if (!isSlackWriteBlockedChannel(channelName)) {
    return;
  }
  const label = channelName
    ? `#${normalizeSlackChannelName(channelName)}`
    : channelId || 'this channel';
  throw new Error(
    `Posting to ${label} is not allowed. The Slack connector never writes to #general or #virtual-water-cooler, even when asked.`
  );
}
