import { WebClient } from '@slack/web-api';
import { buildSlackChannelPageUrl } from '../../shared/slack-urls';
import { startConnectorMcpServer } from './connector-mcp-utils';
import {
  clampSlackPageLimit,
  findSlackChannelByName,
  formatSlackChannelLines,
  rememberSlackChannels,
  resolveSlackListType,
  SLACK_HTTP_TIMEOUT_MS,
  type SlackChannelSummary,
  type SlackConversationPage,
} from './slack-channel-directory';
import { assertSlackWriteAllowed } from './slack-write-guard';

const accessToken = process.env.SLACK_USER_TOKEN?.trim();
if (!accessToken) {
  throw new Error('SLACK_USER_TOKEN is required for Slack connector MCP');
}
if (!accessToken.startsWith('xoxp-') && !accessToken.startsWith('xoxe.xoxp-')) {
  throw new Error('SLACK_USER_TOKEN must be a Slack user token');
}

const client = new WebClient(accessToken, {
  // Default Slack retries span ~30 minutes and leave the tool call hung until the
  // agent aborts it. Fail the page instead, so a smaller limit is not the recovery.
  timeout: SLACK_HTTP_TIMEOUT_MS,
  retryConfig: {
    retries: 1,
    factor: 2,
    minTimeout: 500,
    maxTimeout: 2_000,
  },
});
const SLACK_CHANNEL_ID_RE = /^[CGD][A-Z0-9]+$/;
const SLACK_USER_ID_RE = /^[UW][A-Z0-9]{8,}$/i;
const SLACK_OPAQUE_ID_RE = /^[UWCGD][A-Z0-9]{8,}$/i;

type ChannelSummary = SlackChannelSummary;

const channelCache = new Map<string, ChannelSummary>();

type SlimMessage = {
  ts?: string;
  user?: string;
  text?: string;
  channelId?: string;
  permalink?: string | null;
};

function makeMemoryEnvelope(input: {
  externalId: string;
  title: string;
  summary: string;
  body: string;
  occurredAt?: number;
  keywords?: string[];
  coreKey?: string;
  coreValue?: string;
}) {
  return {
    ...input,
    ingest: true,
    memoryTitle: input.title,
    memorySummary: input.summary,
    memoryBody: input.body,
  };
}

function normalizeChannelInput(input: string): string {
  return input.trim().replace(/^#/, '');
}

function formatChannelLabel(channel: {
  id: string;
  name?: string | null;
  is_private?: boolean;
}): string {
  if (channel.name && !SLACK_OPAQUE_ID_RE.test(channel.name)) {
    return channel.is_private ? channel.name : `#${channel.name}`;
  }
  return channel.id;
}

function pickUserDisplayName(
  user:
    | {
        real_name?: string | null;
        name?: string | null;
        profile?: { display_name?: string | null; real_name?: string | null } | null;
      }
    | null
    | undefined
): string {
  const display = user?.profile?.display_name?.trim() || '';
  const real = user?.real_name?.trim() || user?.profile?.real_name?.trim() || '';
  const name = user?.name?.trim() || '';
  const picked = display || real || name;
  return picked && !SLACK_OPAQUE_ID_RE.test(picked) ? picked : '';
}

const userLabelCache = new Map<string, string>();
let cachedTeamId: string | null | undefined;

async function resolveTeamId(): Promise<string | null> {
  if (cachedTeamId !== undefined) return cachedTeamId;
  try {
    const response = await client.auth.test({});
    const teamId = typeof response.team_id === 'string' ? response.team_id.trim() : '';
    cachedTeamId = teamId || null;
  } catch {
    cachedTeamId = null;
  }
  return cachedTeamId;
}

async function channelPageLink(channelId?: string | null): Promise<string | null> {
  const id = typeof channelId === 'string' ? channelId.trim() : '';
  if (!id || !SLACK_CHANNEL_ID_RE.test(id)) return null;
  return buildSlackChannelPageUrl(id, await resolveTeamId());
}

async function resolveUserLabel(userId: string): Promise<string> {
  const id = userId.trim();
  if (!SLACK_USER_ID_RE.test(id)) return id;
  const cached = userLabelCache.get(id);
  if (cached) return cached;
  try {
    const response = await client.users.info({ user: id });
    const label = pickUserDisplayName(response.user) || id;
    userLabelCache.set(id, label);
    return label;
  } catch {
    userLabelCache.set(id, id);
    return id;
  }
}

async function humanizeSlackLabel(value: string): Promise<string> {
  const trimmed = value.trim().replace(/^#/, '');
  if (!trimmed) return '';
  if (SLACK_USER_ID_RE.test(trimmed)) {
    const resolved = await resolveUserLabel(trimmed);
    return SLACK_OPAQUE_ID_RE.test(resolved) ? '' : resolved;
  }
  if (SLACK_OPAQUE_ID_RE.test(trimmed)) return '';
  return trimmed;
}

function formatSlackError(error: unknown, context: string): Error {
  const details =
    error && typeof error === 'object'
      ? (error as { data?: { error?: unknown }; code?: unknown; message?: unknown })
      : null;
  const slackError =
    typeof details?.data?.error === 'string'
      ? details.data.error
      : typeof details?.code === 'string'
        ? details.code
        : typeof details?.message === 'string'
          ? details.message
          : 'unknown_error';

  switch (slackError) {
    case 'missing_scope':
    case 'invalid_auth':
    case 'token_expired':
    case 'token_revoked':
      return new Error(`${context} failed because the Slack connector needs to be reconnected.`);
    case 'channel_not_found':
      return new Error(`${context} failed because the Slack channel name or ID is invalid.`);
    case 'not_in_channel':
      return new Error(
        `${context} failed because this Slack channel is not accessible to the connected user.`
      );
    case 'ratelimited':
      return new Error(`${context} was rate limited by Slack. Please retry in a moment.`);
    default:
      if (/timeout|timed out|econnaborted|request_timeout|etimedout/i.test(slackError)) {
        return new Error(
          `${context} did not respond in time. Slack pages are already capped; pass a channel ID (C…) or the next_cursor from list_channels. A smaller limit does not make conversations.list faster.`
        );
      }
      return new Error(`${context} failed: ${slackError}`);
  }
}

async function listConversationPage(input: {
  types: string;
  limit: number;
  cursor?: string;
}): Promise<SlackConversationPage> {
  const response = await client.conversations.list({
    cursor: input.cursor,
    limit: input.limit,
    exclude_archived: true,
    types: input.types,
  });
  const channels: ChannelSummary[] = [];
  for (const channel of response.channels ?? []) {
    if (!channel?.id) continue;
    channels.push({
      id: channel.id,
      name: channel.name || channel.user || channel.id,
      is_private: Boolean(channel.is_private),
      is_im: Boolean(channel.is_im),
      purpose: channel.purpose?.value,
    });
  }
  rememberSlackChannels(channelCache, channels);
  const nextCursor = response.response_metadata?.next_cursor?.trim() || null;
  return { channels, nextCursor };
}

/** One search call. Avoids walking conversations.list when the caller passed a name. */
async function findChannelIdBySearch(name: string): Promise<ChannelSummary | null> {
  const response = await client.search.messages({
    query: `in:#${name}`,
    count: 1,
    sort: 'timestamp',
    sort_dir: 'desc',
  });
  const match = response.messages?.matches?.[0];
  const channel = match?.channel;
  if (!channel || typeof channel !== 'object' || !('id' in channel) || !channel.id) return null;
  const id = String(channel.id);
  const summary: ChannelSummary = {
    id,
    name:
      'name' in channel && typeof channel.name === 'string' && channel.name.trim()
        ? channel.name.trim()
        : name,
    is_private: Boolean((channel as { is_private?: boolean }).is_private) || id.startsWith('G'),
    is_im: id.startsWith('D'),
  };
  rememberSlackChannels(channelCache, [summary]);
  return summary;
}

async function resolveChannel(channelRef: string): Promise<{
  id: string;
  name: string | null;
  isPrivate: boolean;
}> {
  const normalized = normalizeChannelInput(channelRef);
  if (!normalized) {
    throw new Error('Slack channel name or ID is required.');
  }

  if (SLACK_CHANNEL_ID_RE.test(normalized)) {
    try {
      const response = await client.conversations.info({ channel: normalized });
      const channel = response.channel;
      return {
        id: normalized,
        name: channel?.name || null,
        isPrivate: Boolean(channel?.is_private),
      };
    } catch (error) {
      throw formatSlackError(error, `Looking up Slack channel ${normalized}`);
    }
  }

  try {
    let match: ChannelSummary | null = null;
    try {
      match = await findChannelIdBySearch(normalized);
    } catch (error) {
      const slackError =
        error && typeof error === 'object'
          ? (error as { data?: { error?: unknown } }).data?.error
          : null;
      if (slackError !== 'missing_scope' && slackError !== 'not_allowed_token_type') {
        throw error;
      }
    }
    match ??= await findSlackChannelByName(normalized, listConversationPage, channelCache);
    if (!match) {
      throw new Error(
        `Slack channel "${normalized}" was not found in the scanned pages. Pass the channel ID (C…) from list_channels.`
      );
    }
    return {
      id: match.id,
      name: match.name,
      isPrivate: match.is_private,
    };
  } catch (error) {
    if (error instanceof Error && error.message.includes('was not found')) {
      throw error;
    }
    if (error instanceof Error && error.message.includes('did not respond in time')) {
      throw error;
    }
    throw formatSlackError(error, `Looking up Slack channel ${normalized}`);
  }
}

async function formatMessages(messages: SlimMessage[]): Promise<string> {
  const lines = await Promise.all(
    messages.map(async (message) => {
      const link = await channelPageLink(message.channelId);
      const base = `[${message.ts}] ${message.user || 'unknown'}: ${message.text || ''}`;
      return link ? `${base}\nLink: ${link}` : base;
    })
  );
  return lines.join('\n');
}

/** Parse-stable search line: `channelId|#name [ts] user: text` (DM names omit #). */
function formatSearchMatchLine(message: {
  ts?: string;
  text?: string;
  username?: string;
  channelLink?: string | null;
  channelId: string;
  channelName: string;
}): string {
  const id = message.channelId.trim() || 'unknown';
  const rawName = message.channelName.trim().replace(/^#/, '');
  const isIm = /^D/i.test(id);
  const safeName = rawName && !SLACK_OPAQUE_ID_RE.test(rawName) ? rawName : '';
  const namePart = safeName ? (isIm ? safeName : `#${safeName}`) : '';
  const channelToken = namePart ? `${id}|${namePart}` : id;
  const username =
    message.username && !SLACK_OPAQUE_ID_RE.test(message.username) ? message.username : 'unknown';
  const base = `${channelToken} [${message.ts || ''}] ${username}: ${message.text || ''}`;
  return message.channelLink ? `${base}\nLink: ${message.channelLink}` : base;
}

function mapMessages(messages: SlimMessage[] | undefined, channelId?: string): SlimMessage[] {
  return (messages ?? []).map((message) => ({
    ts: message.ts,
    user: message.user,
    text: message.text,
    channelId: channelId || message.channelId,
    permalink: message.permalink ?? null,
  }));
}

async function searchChannelMessages(
  channel: { id: string; name: string | null },
  limit: number
): Promise<SlimMessage[]> {
  if (!channel.name) {
    return [];
  }
  try {
    const response = await client.search.messages({
      query: `in:${channel.name}`,
      count: limit,
    });
    const matches = response.messages?.matches ?? [];
    return matches.map((message) => ({
      ts: message.ts,
      user: message.username || message.user,
      text: message.text,
      channelId: channel.id,
      permalink: null,
    }));
  } catch (error) {
    throw formatSlackError(error, `Searching Slack messages in ${formatChannelLabel(channel)}`);
  }
}

async function main() {
  await startConnectorMcpServer({
    serverName: 'slack-connector-server',
    tools: [
      {
        name: 'list_channels',
        description:
          'List one page of Slack channels the connected user can read. One conversation type per call (default public_channel). Pass next_cursor to continue. Use the returned channel ID (C…) with get_channel_history. Do not combine types; a smaller limit does not make Slack faster.',
        inputSchema: {
          type: 'object',
          properties: {
            limit: {
              type: 'number',
              description: 'Page size, capped at 100. Defaults to 50.',
            },
            cursor: {
              type: 'string',
              description: 'next_cursor from the previous page. Use with the same types value.',
            },
            types: {
              type: 'string',
              description:
                'Exactly one of public_channel, private_channel, mpim, im. Defaults to public_channel.',
              enum: ['public_channel', 'private_channel', 'mpim', 'im'],
            },
          },
        },
      },
      {
        name: 'get_channel_history',
        description:
          'Read one page of recent messages from a Slack channel. Prefer a channel ID (C…). A channel name is resolved one conversation type at a time. Pass cursor to fetch the next page. Limit is capped at 100.',
        inputSchema: {
          type: 'object',
          properties: {
            channel_id: {
              type: 'string',
              description: 'Slack channel ID (C…) or channel name.',
            },
            limit: { type: 'number', description: 'Page size, capped at 100. Defaults to 50.' },
            cursor: {
              type: 'string',
              description: 'next_cursor from the previous history page.',
            },
          },
          required: ['channel_id'],
        },
      },
      {
        name: 'search_messages',
        description: 'Search Slack messages across readable conversations.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            limit: { type: 'number' },
            sort: {
              type: 'string',
              description: 'score (relevance) or timestamp (newest first). Defaults to timestamp.',
              enum: ['score', 'timestamp'],
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'get_thread',
        description: 'Fetch a Slack thread by channel and thread timestamp.',
        inputSchema: {
          type: 'object',
          properties: {
            channel_id: { type: 'string' },
            thread_ts: { type: 'string' },
          },
          required: ['channel_id', 'thread_ts'],
        },
      },
      {
        name: 'get_user',
        description: 'Read Slack user profile details by user id (U…) or email address.',
        inputSchema: {
          type: 'object',
          properties: {
            user_id: { type: 'string', description: 'Slack user id (U…) or email address.' },
          },
          required: ['user_id'],
        },
      },
      {
        name: 'post_message',
        description:
          'Post a message to a Slack channel or reply in a thread. Requires user approval. Never posts to #general or #virtual-water-cooler (hard-blocked even if the user asks).',
        inputSchema: {
          type: 'object',
          properties: {
            channel: {
              type: 'string',
              description:
                'Channel name (e.g. eng-team) or ID (e.g. C0123…). #general and #virtual-water-cooler are blocked.',
            },
            text: { type: 'string', description: 'Message text to post.' },
            thread_ts: {
              type: 'string',
              description: 'Optional parent message timestamp to reply in that thread.',
            },
          },
          required: ['channel', 'text'],
        },
      },
    ],
    handlers: {
      list_channels: async (args) => {
        const limit = clampSlackPageLimit(args.limit);
        const types = resolveSlackListType(args.types);
        const cursor = typeof args.cursor === 'string' ? args.cursor.trim() : '';
        let page: SlackConversationPage;
        try {
          page = await listConversationPage({
            types,
            limit,
            ...(cursor ? { cursor } : {}),
          });
        } catch (error) {
          throw formatSlackError(error, `Listing Slack ${types.replace('_', ' ')}s`);
        }
        const cursorLine = page.nextCursor
          ? `\nnext_cursor: ${page.nextCursor}\ntypes: ${types}`
          : `\ntypes: ${types}`;
        return makeMemoryEnvelope({
          externalId: `slack:channels:${types}:${cursor || 'start'}`,
          title: 'Slack channels',
          summary: `Fetched ${page.channels.length} Slack ${types.replace('_', ' ')}s`,
          body: `${formatSlackChannelLines(page.channels)}${cursorLine}`,
          keywords: ['slack', 'channels', types],
          coreKey: 'slack_latest_read',
          coreValue: `Fetched ${page.channels.length} ${types} channels`,
        });
      },
      get_channel_history: async (args) => {
        const requestedChannel = String(args.channel_id || '');
        const limit = clampSlackPageLimit(args.limit);
        const cursor = typeof args.cursor === 'string' ? args.cursor.trim() : '';
        const channel = await resolveChannel(requestedChannel);
        let messages: SlimMessage[];
        let historyCursor: string | null = null;
        let usedFallbackSearch = false;
        try {
          const response = await client.conversations.history({
            channel: channel.id,
            limit,
            ...(cursor ? { cursor } : {}),
          });
          messages = mapMessages(response.messages, channel.id);
          historyCursor = response.response_metadata?.next_cursor?.trim() || null;
        } catch (error) {
          messages = await searchChannelMessages(channel, limit);
          usedFallbackSearch = true;
          if (messages.length === 0) {
            throw formatSlackError(
              error,
              `Reading Slack channel ${formatChannelLabel({
                id: channel.id,
                name: channel.name,
                is_private: channel.isPrivate,
              })}`
            );
          }
        }
        const channelLabel = formatChannelLabel({
          id: channel.id,
          name: channel.name,
          is_private: channel.isPrivate,
        });
        return makeMemoryEnvelope({
          externalId: `slack:${channel.id}:${messages[0]?.ts || Date.now()}`,
          title: `Slack channel history ${channelLabel}`,
          summary: `${usedFallbackSearch ? 'Searched' : 'Fetched'} ${messages.length} messages from ${channelLabel} (${channel.id})`,
          body: [
            `channel_id: ${channel.id}`,
            await formatMessages(messages),
            historyCursor ? `next_cursor: ${historyCursor}` : '',
          ]
            .filter(Boolean)
            .join('\n'),
          occurredAt: Date.now(),
          keywords: ['slack', 'messages', channel.id, channel.name || channel.id],
          coreKey: 'slack_latest_read',
          coreValue: `Read ${messages.length} Slack messages from ${channelLabel}`,
        });
      },
      search_messages: async (args) => {
        const query = String(args.query || '');
        const sort = args.sort === 'score' ? 'score' : 'timestamp';
        let response;
        try {
          response = await client.search.messages({
            query,
            count: clampSlackPageLimit(args.limit, 20),
            sort,
            sort_dir: 'desc',
          });
        } catch (error) {
          throw formatSlackError(error, 'Searching Slack messages');
        }
        const rawMatches = (response.messages?.matches ?? []).map((message) => {
          const channelId =
            typeof message.channel === 'object' && message.channel && 'id' in message.channel
              ? String((message.channel as { id?: string }).id || '')
              : typeof message.channel === 'string'
                ? message.channel
                : '';
          const channelName =
            typeof message.channel === 'object' && message.channel && 'name' in message.channel
              ? String((message.channel as { name?: string }).name || '')
              : '';
          return {
            ts: message.ts,
            text: message.text,
            channelId,
            channelName,
            username: String(message.username || message.user || ''),
          };
        });
        const idsToResolve = new Set<string>();
        for (const match of rawMatches) {
          if (SLACK_USER_ID_RE.test(match.channelName.trim()))
            idsToResolve.add(match.channelName.trim());
          if (SLACK_USER_ID_RE.test(match.username.trim())) idsToResolve.add(match.username.trim());
        }
        await Promise.all([...idsToResolve].map((id) => resolveUserLabel(id)));
        const matches = await Promise.all(
          rawMatches.map(async (match) => ({
            ...match,
            channelName: await humanizeSlackLabel(match.channelName),
            username: (await humanizeSlackLabel(match.username)) || 'unknown',
            channelLink: await channelPageLink(match.channelId),
          }))
        );
        return makeMemoryEnvelope({
          externalId: `slack:search:${query}`,
          title: `Slack search: ${query}`,
          summary: `Found ${matches.length} Slack message matches`,
          body: matches.map((message) => formatSearchMatchLine(message)).join('\n'),
          occurredAt: Date.now(),
          keywords: ['slack', 'search', ...query.split(/\s+/).filter(Boolean)],
        });
      },
      get_thread: async (args) => {
        const channel = await resolveChannel(String(args.channel_id || ''));
        const threadTs = String(args.thread_ts || '');
        let response;
        try {
          response = await client.conversations.replies({
            channel: channel.id,
            ts: threadTs,
          });
        } catch (error) {
          throw formatSlackError(
            error,
            `Reading Slack thread in ${formatChannelLabel({
              id: channel.id,
              name: channel.name,
              is_private: channel.isPrivate,
            })}`
          );
        }
        const messages = mapMessages(response.messages, channel.id);
        return makeMemoryEnvelope({
          externalId: `slack:thread:${channel.id}:${threadTs}`,
          title: `Slack thread ${threadTs}`,
          summary: `Fetched ${messages.length} thread messages`,
          body: await formatMessages(messages),
          occurredAt: Date.now(),
          keywords: ['slack', 'thread', channel.id],
        });
      },
      get_user: async (args) => {
        const userId = String(args.user_id || args.email || '').trim();
        let response;
        try {
          response = userId.includes('@')
            ? await client.users.lookupByEmail({ email: userId })
            : await client.users.info({ user: userId });
        } catch (error) {
          throw formatSlackError(error, `Reading Slack user ${userId}`);
        }
        const user = response.user;
        const body = JSON.stringify(
          {
            id: user?.id,
            name: user?.name,
            real_name: user?.real_name,
            email: user?.profile?.email,
            title: user?.profile?.title,
          },
          null,
          2
        );
        return makeMemoryEnvelope({
          externalId: `slack:user:${userId}`,
          title: `Slack user ${user?.real_name || user?.name || userId}`,
          summary: `Fetched Slack user profile for ${userId}`,
          body,
          occurredAt: Date.now(),
          keywords: ['slack', 'user', userId],
        });
      },
      post_message: async (args) => {
        const text = String(args.text || '').trim();
        if (!text) {
          throw new Error('Slack message text is required.');
        }
        const threadTs = typeof args.thread_ts === 'string' ? args.thread_ts.trim() : '';
        const requestedChannel = String(args.channel || '');
        // Reject by name before any Slack API calls when the user/agent passes a banned name.
        assertSlackWriteAllowed(requestedChannel);
        const channel = await resolveChannel(requestedChannel);
        // Also block when the ref was a channel ID that resolves to a banned name.
        assertSlackWriteAllowed(channel.name, channel.id);
        const channelLabel = formatChannelLabel({
          id: channel.id,
          name: channel.name,
          is_private: channel.isPrivate,
        });
        let response;
        try {
          response = await client.chat.postMessage({
            channel: channel.id,
            text,
            ...(threadTs ? { thread_ts: threadTs } : {}),
          });
        } catch (error) {
          throw formatSlackError(error, `Posting Slack message to ${channelLabel}`);
        }
        return {
          ok: true,
          channel: channel.id,
          channel_label: channelLabel,
          ts: response.ts ?? null,
          ...(threadTs ? { thread_ts: threadTs } : {}),
        };
      },
    },
  });
}

void main();
