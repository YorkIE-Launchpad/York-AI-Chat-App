import { WebClient } from '@slack/web-api';
import { startConnectorMcpServer } from './connector-mcp-utils';

const accessToken = process.env.SLACK_USER_TOKEN?.trim();
if (!accessToken) {
  throw new Error('SLACK_USER_TOKEN is required for Slack connector MCP');
}

const client = new WebClient(accessToken);

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
    ],
    handlers: {
      list_channels: async (args) => {
        const response = await client.conversations.list({
          limit: typeof args.limit === 'number' ? args.limit : 50,
          exclude_archived: true,
          types: 'public_channel,private_channel,mpim,im',
        });
        const channels = (response.channels ?? []).map((channel) => ({
          id: channel.id,
          name: channel.name,
          is_private: channel.is_private,
          is_im: channel.is_im,
          purpose: channel.purpose?.value,
        }));
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
        const channelId = String(args.channel_id || '');
        const response = await client.conversations.history({
          channel: channelId,
          limit: typeof args.limit === 'number' ? args.limit : 50,
        });
        const messages = (response.messages ?? []).map((message) => ({
          ts: message.ts,
          user: message.user,
          text: message.text,
        }));
        return makeMemoryEnvelope({
          externalId: `slack:${channelId}:${messages[0]?.ts || Date.now()}`,
          title: `Slack channel history ${channelId}`,
          summary: `Fetched ${messages.length} messages from ${channelId}`,
          body: messages
            .map((message) => `[${message.ts}] ${message.user || 'unknown'}: ${message.text || ''}`)
            .join('\n'),
          occurredAt: Date.now(),
          keywords: ['slack', 'messages', channelId],
          coreKey: 'slack_latest_read',
          coreValue: `Read ${messages.length} Slack messages from ${channelId}`,
        });
      },
      search_messages: async (args) => {
        const query = String(args.query || '');
        const response = await client.search.messages({
          query,
          count: typeof args.limit === 'number' ? args.limit : 20,
        });
        const matches = (response.messages?.matches ?? []).map((message) => ({
          ts: message.ts,
          text: message.text,
          channel: message.channel?.name || message.channel?.id,
          username: message.username || message.user,
        }));
        return makeMemoryEnvelope({
          externalId: `slack:search:${query}`,
          title: `Slack search: ${query}`,
          summary: `Found ${matches.length} Slack message matches`,
          body: matches
            .map(
              (message) =>
                `${message.channel || 'unknown'} [${message.ts}] ${message.username || 'unknown'}: ${message.text || ''}`
            )
            .join('\n'),
          occurredAt: Date.now(),
          keywords: ['slack', 'search', ...query.split(/\s+/).filter(Boolean)],
        });
      },
      get_thread: async (args) => {
        const channelId = String(args.channel_id || '');
        const threadTs = String(args.thread_ts || '');
        const response = await client.conversations.replies({
          channel: channelId,
          ts: threadTs,
        });
        const messages = (response.messages ?? []).map((message) => ({
          ts: message.ts,
          user: message.user,
          text: message.text,
        }));
        return makeMemoryEnvelope({
          externalId: `slack:thread:${channelId}:${threadTs}`,
          title: `Slack thread ${threadTs}`,
          summary: `Fetched ${messages.length} thread messages`,
          body: messages
            .map((message) => `[${message.ts}] ${message.user || 'unknown'}: ${message.text || ''}`)
            .join('\n'),
          occurredAt: Date.now(),
          keywords: ['slack', 'thread', channelId],
        });
      },
      get_user: async (args) => {
        const userId = String(args.user_id || '');
        const response = await client.users.info({ user: userId });
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
    },
  });
}

void main();
