import { WebClient } from '@slack/web-api';
import { startConnectorMcpServer } from './connector-mcp-utils';
import { resolveSlackPermalink } from './slack-permalink';
import { assertSlackWriteAllowed } from './slack-write-guard';

const accessToken = process.env.SLACK_USER_TOKEN?.trim();
if (!accessToken) {
  throw new Error('SLACK_USER_TOKEN is required for Slack connector MCP');
}
if (!accessToken.startsWith('xoxp-') && !accessToken.startsWith('xoxe.xoxp-')) {
  throw new Error('SLACK_USER_TOKEN must be a Slack user token');
}

const client = new WebClient(accessToken);
const CHANNEL_TYPES = 'public_channel,private_channel,mpim,im';
const SLACK_CHANNEL_ID_RE = /^[CGD][A-Z0-9]+$/;

type ChannelSummary = {
  id: string;
  name: string;
  is_private: boolean;
  is_im: boolean;
  purpose?: string;
};

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
  if (channel.name) {
    return channel.is_private ? channel.name : `#${channel.name}`;
  }
  return channel.id;
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
      return new Error(`${context} failed: ${slackError}`);
  }
}

async function listChannels(limit: number): Promise<ChannelSummary[]> {
  const channels: ChannelSummary[] = [];
  let cursor: string | undefined;

  while (channels.length < limit) {
    const remaining = Math.max(limit - channels.length, 1);
    const response = await client.conversations.list({
      cursor,
      limit: Math.min(remaining, 200),
      exclude_archived: true,
      types: CHANNEL_TYPES,
    });
    for (const channel of response.channels ?? []) {
      if (!channel?.id) continue;
      channels.push({
        id: channel.id,
        name: channel.name || channel.user || channel.id,
        is_private: Boolean(channel.is_private),
        is_im: Boolean(channel.is_im),
        purpose: channel.purpose?.value,
      });
      if (channels.length >= limit) break;
    }
    cursor = response.response_metadata?.next_cursor || undefined;
    if (!cursor) break;
  }

  return channels;
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
    const channels = await listChannels(500);
    const match = channels.find((channel) => channel.name === normalized);
    if (!match) {
      throw new Error(`Slack channel "${normalized}" was not found.`);
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
    throw formatSlackError(error, `Looking up Slack channel ${normalized}`);
  }
}

function formatMessages(messages: SlimMessage[]): string {
  return messages
    .map((message) => {
      const permalink = resolveSlackPermalink({
        permalink: message.permalink,
        channelId: message.channelId,
        ts: message.ts,
      });
      const base = `[${message.ts}] ${message.user || 'unknown'}: ${message.text || ''}`;
      return permalink ? `${base}\nLink: ${permalink}` : base;
    })
    .join('\n');
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
      permalink:
        typeof (message as { permalink?: unknown }).permalink === 'string'
          ? (message as { permalink: string }).permalink
          : null,
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
        description: 'List Slack channels the connected user can read.',
        inputSchema: {
          type: 'object',
          properties: {
            limit: { type: 'number' },
          },
        },
      },
      {
        name: 'get_channel_history',
        description: 'Read recent messages from a Slack channel.',
        inputSchema: {
          type: 'object',
          properties: {
            channel_id: { type: 'string' },
            limit: { type: 'number' },
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
        description: 'Read Slack user profile details.',
        inputSchema: {
          type: 'object',
          properties: {
            user_id: { type: 'string' },
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
        const limit = typeof args.limit === 'number' ? args.limit : 50;
        const channels = await listChannels(limit);
        return makeMemoryEnvelope({
          externalId: `slack:channels:${Date.now()}`,
          title: 'Slack channels',
          summary: `Fetched ${channels.length} Slack channels`,
          body: channels
            .map((channel) => `${channel.name || channel.id}: ${channel.purpose || ''}`)
            .join('\n'),
          keywords: ['slack', 'channels'],
          coreKey: 'slack_latest_read',
          coreValue: `Fetched ${channels.length} channels`,
        });
      },
      get_channel_history: async (args) => {
        const requestedChannel = String(args.channel_id || '');
        const limit = typeof args.limit === 'number' ? args.limit : 50;
        const channel = await resolveChannel(requestedChannel);
        let messages: SlimMessage[];
        let usedFallbackSearch = false;
        try {
          const response = await client.conversations.history({
            channel: channel.id,
            limit,
          });
          messages = mapMessages(response.messages, channel.id);
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
          summary: `${usedFallbackSearch ? 'Searched' : 'Fetched'} ${messages.length} messages from ${channelLabel}`,
          body: formatMessages(messages),
          occurredAt: Date.now(),
          keywords: ['slack', 'messages', channel.id, channel.name || channel.id],
          coreKey: 'slack_latest_read',
          coreValue: `Read ${messages.length} Slack messages from ${channelLabel}`,
        });
      },
      search_messages: async (args) => {
        const query = String(args.query || '');
        let response;
        try {
          response = await client.search.messages({
            query,
            count: typeof args.limit === 'number' ? args.limit : 20,
          });
        } catch (error) {
          throw formatSlackError(error, 'Searching Slack messages');
        }
        const matches = (response.messages?.matches ?? []).map((message) => {
          const channelId =
            typeof message.channel === 'object' && message.channel && 'id' in message.channel
              ? String((message.channel as { id?: string }).id || '')
              : typeof message.channel === 'string'
                ? message.channel
                : '';
          const permalink =
            typeof (message as { permalink?: unknown }).permalink === 'string'
              ? (message as { permalink: string }).permalink
              : resolveSlackPermalink({
                  channelId,
                  ts: message.ts,
                });
          return {
            ts: message.ts,
            text: message.text,
            channel: message.channel?.name || message.channel?.id || channelId,
            username: message.username || message.user,
            permalink,
          };
        });
        return makeMemoryEnvelope({
          externalId: `slack:search:${query}`,
          title: `Slack search: ${query}`,
          summary: `Found ${matches.length} Slack message matches`,
          body: matches
            .map((message) => {
              const base = `${message.channel || 'unknown'} [${message.ts}] ${message.username || 'unknown'}: ${message.text || ''}`;
              return message.permalink ? `${base}\nLink: ${message.permalink}` : base;
            })
            .join('\n'),
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
          body: formatMessages(messages),
          occurredAt: Date.now(),
          keywords: ['slack', 'thread', channel.id],
        });
      },
      get_user: async (args) => {
        const userId = String(args.user_id || '');
        let response;
        try {
          response = await client.users.info({ user: userId });
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
