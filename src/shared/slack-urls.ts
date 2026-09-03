/**
 * Slack channel-page URLs and source-footer helpers.
 * Message permalinks (.../p<ts>/n%5B...) are not used in Sources.
 */

const SLACK_HOST_RE = /(^|\.)slack\.com$/i;
const CHANNEL_ID_RE = /^[CDG][A-Z0-9]+$/i;

export function isSlackUrl(url: string): boolean {
  try {
    return SLACK_HOST_RE.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** Channel / DM / group ID from archives or client URLs. */
export function slackChannelIdFromUrl(url: string): string | undefined {
  try {
    const pathname = new URL(url).pathname;
    const archives = pathname.match(/\/archives\/([CDG][A-Z0-9]+)/i);
    if (archives) return archives[1];
    const client = pathname.match(/\/client\/[TE][A-Z0-9]+\/([CDG][A-Z0-9]+)/i);
    if (client) return client[1];
  } catch {
    // ignore
  }
  return undefined;
}

export function buildSlackChannelPageUrl(
  channelId: string,
  teamId?: string | null
): string {
  const id = channelId.trim();
  const team = typeof teamId === 'string' ? teamId.trim() : '';
  if (team) {
    return `https://app.slack.com/client/${team}/${id}`;
  }
  return `https://app.slack.com/archives/${id}`;
}

/** Strip message/thread suffixes so Sources open the channel page. */
export function normalizeSlackSourceUrl(url: string): string {
  const channelId = slackChannelIdFromUrl(url);
  if (!channelId) return url;
  try {
    const parsed = new URL(url);
    const client = parsed.pathname.match(/\/client\/([TE][A-Z0-9]+)\//i);
    if (client) {
      return buildSlackChannelPageUrl(channelId, client[1]);
    }
  } catch {
    // ignore
  }
  return buildSlackChannelPageUrl(channelId);
}

/**
 * Prefer `#eng` / DM display name from Slack MCP lines:
 * `C123|#eng [ts] user: text`
 */
export function slackChannelLabelFromResultText(
  resultText: string,
  channelId: string
): string | undefined {
  const id = channelId.trim();
  if (!id || !CHANNEL_ID_RE.test(id)) return undefined;
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const token = new RegExp(`(?:^|[\\s"'<(])${escaped}\\|([^\\n\\[]+?)\\s+\\[`, 'i');
  const match = resultText.match(token);
  if (!match?.[1]) return undefined;
  const raw = match[1].replace(/^#/, '').trim();
  if (!raw || CHANNEL_ID_RE.test(raw)) return undefined;
  return /^D/i.test(id) ? raw : `#${raw}`;
}

/** Rewrite Slack permalinks in extracted source URLs to channel pages. */
export function toUserFacingSlackSourceUrls(urls: string[]): string[] {
  return urls.map((url) => (isSlackUrl(url) ? normalizeSlackSourceUrl(url) : url));
}
