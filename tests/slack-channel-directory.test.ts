import { describe, expect, it } from 'vitest';
import {
  clampSlackPageLimit,
  findSlackChannelByName,
  formatSlackChannelLines,
  resolveSlackListType,
  SLACK_CHANNEL_PAGE_SIZE,
  type SlackChannelSummary,
  type SlackConversationPage,
} from '../src/main/mcp/slack-channel-directory';

function channel(id: string, name: string, isPrivate = false): SlackChannelSummary {
  return { id, name, is_private: isPrivate, is_im: false };
}

describe('slack channel directory', () => {
  it('caps page size so a large limit cannot ask Slack for a bigger page', () => {
    expect(clampSlackPageLimit(200)).toBe(SLACK_CHANNEL_PAGE_SIZE);
    expect(clampSlackPageLimit(30)).toBe(30);
    expect(clampSlackPageLimit(undefined)).toBe(50);
    expect(clampSlackPageLimit(0)).toBe(1);
  });

  it('refuses combined conversation types that hang conversations.list', () => {
    expect(resolveSlackListType(undefined)).toBe('public_channel');
    expect(resolveSlackListType('public_channel,private_channel,mpim,im')).toBe('public_channel');
    expect(resolveSlackListType('private_channel')).toBe('private_channel');
    expect(resolveSlackListType('im')).toBe('im');
  });

  it('includes the channel id so history is not called with a name', () => {
    expect(formatSlackChannelLines([channel('C0123', 'infinite-conquerors')])).toBe(
      'C0123\t#infinite-conquerors'
    );
  });

  it('resolves a channel name one type at a time and stops at the match', async () => {
    const calls: Array<{ types: string; limit: number; cursor?: string }> = [];
    const pages: Record<string, SlackConversationPage[]> = {
      public_channel: [
        {
          channels: [channel('C1', 'general')],
          nextCursor: 'pub-2',
        },
        {
          channels: [channel('C2', 'other')],
          nextCursor: null,
        },
      ],
      private_channel: [
        {
          channels: [channel('G9', 'infinite-conquerors', true)],
          nextCursor: 'priv-2',
        },
      ],
    };
    const cache = new Map<string, SlackChannelSummary>();
    const found = await findSlackChannelByName(
      '#infinite-conquerors',
      async (input) => {
        calls.push(input);
        const queue = pages[input.types];
        if (!queue?.length) return { channels: [], nextCursor: null };
        return queue.shift()!;
      },
      cache,
      { pageSize: 100, maxPagesPerType: 6 }
    );

    expect(found?.id).toBe('G9');
    expect(calls.map((call) => call.types)).toEqual([
      'public_channel',
      'public_channel',
      'private_channel',
    ]);
    expect(calls.every((call) => !call.types.includes(','))).toBe(true);
    expect(calls.every((call) => call.limit === 100)).toBe(true);
    expect(cache.get('infinite-conquerors')?.id).toBe('G9');

    calls.length = 0;
    const again = await findSlackChannelByName(
      'infinite-conquerors',
      async () => {
        throw new Error('should use the cache');
      },
      cache
    );
    expect(again?.id).toBe('G9');
    expect(calls).toHaveLength(0);
  });
});
