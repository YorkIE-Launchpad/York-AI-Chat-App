/**
 * Slack `conversations.list` with several types at once (public + private + mpim + im)
 * often hangs on large workspaces. The `limit` argument does not make that call faster.
 * Each tool call therefore requests one conversation type and one page.
 */

export const SLACK_CHANNEL_PAGE_SIZE = 100;
export const SLACK_NAME_LOOKUP_MAX_PAGES = 6;
export const SLACK_HTTP_TIMEOUT_MS = 20_000;

/** One type per request. Combined types are what time out. */
export const SLACK_CHANNEL_LIST_TYPES = ['public_channel', 'private_channel'] as const;

export type SlackChannelListType = (typeof SLACK_CHANNEL_LIST_TYPES)[number] | 'mpim' | 'im';

const SINGLE_LIST_TYPES = new Set<string>(['public_channel', 'private_channel', 'mpim', 'im']);

export type SlackChannelSummary = {
  id: string;
  name: string;
  is_private: boolean;
  is_im: boolean;
  purpose?: string;
};

export type SlackConversationPage = {
  channels: SlackChannelSummary[];
  nextCursor: string | null;
};

export type ListSlackConversationPage = (input: {
  types: string;
  limit: number;
  cursor?: string;
}) => Promise<SlackConversationPage>;

export function clampSlackPageLimit(limit: unknown, fallback = 50): number {
  const n = typeof limit === 'number' && Number.isFinite(limit) ? Math.trunc(limit) : fallback;
  if (n < 1) return 1;
  return Math.min(n, SLACK_CHANNEL_PAGE_SIZE);
}

/**
 * Combined `types` values are dropped. A missing value is public channels only.
 * Callers that need private channels, DMs, or the next page pass one type (and a cursor).
 */
export function resolveSlackListType(input: unknown): SlackChannelListType {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw || raw.includes(',')) return 'public_channel';
  if (SINGLE_LIST_TYPES.has(raw)) return raw as SlackChannelListType;
  return 'public_channel';
}

export function slackChannelCacheKey(name: string): string {
  return name.trim().replace(/^#/, '').toLowerCase();
}

export function rememberSlackChannels(
  cache: Map<string, SlackChannelSummary>,
  channels: SlackChannelSummary[]
): void {
  for (const channel of channels) {
    const key = slackChannelCacheKey(channel.name);
    if (!key || key === channel.id.toLowerCase()) continue;
    cache.set(key, channel);
  }
}

/**
 * Find a channel by name without a mixed-type conversations.list.
 * Stops at the first match and remembers every channel it sees.
 */
export async function findSlackChannelByName(
  name: string,
  listPage: ListSlackConversationPage,
  cache: Map<string, SlackChannelSummary>,
  options?: { pageSize?: number; maxPagesPerType?: number }
): Promise<SlackChannelSummary | null> {
  const key = slackChannelCacheKey(name);
  if (!key) return null;
  const cached = cache.get(key);
  if (cached) return cached;

  const pageSize = options?.pageSize ?? SLACK_CHANNEL_PAGE_SIZE;
  const maxPages = options?.maxPagesPerType ?? SLACK_NAME_LOOKUP_MAX_PAGES;

  for (const types of SLACK_CHANNEL_LIST_TYPES) {
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page += 1) {
      const result = await listPage({ types, limit: pageSize, cursor });
      rememberSlackChannels(cache, result.channels);
      const match = cache.get(key);
      if (match) return match;
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
  }
  return null;
}

export function formatSlackChannelLines(channels: SlackChannelSummary[]): string {
  return channels
    .map((channel) => {
      const label = channel.is_im || channel.is_private ? channel.name : `#${channel.name}`;
      const purpose = channel.purpose ? `\t${channel.purpose}` : '';
      return `${channel.id}\t${label}${purpose}`;
    })
    .join('\n');
}
