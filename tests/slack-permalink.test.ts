import { describe, expect, it } from 'vitest';
import { buildSlackPermalink, resolveSlackPermalink } from '../src/main/mcp/slack-permalink';

describe('slack permalink helpers', () => {
  it('builds archive URLs from channel id and ts', () => {
    expect(buildSlackPermalink('C0123ABC', '1234567890.123456')).toBe(
      'https://app.slack.com/archives/C0123ABC/p1234567890123456'
    );
  });

  it('prefers an API-provided permalink', () => {
    expect(
      resolveSlackPermalink({
        permalink: 'https://yorkie.slack.com/archives/C0123/p99',
        channelId: 'C0123',
        ts: '1.2',
      })
    ).toBe('https://yorkie.slack.com/archives/C0123/p99');
  });

  it('falls back to building a permalink when API omits it', () => {
    expect(
      resolveSlackPermalink({
        channelId: 'C99',
        ts: '1700000000.000100',
      })
    ).toBe('https://app.slack.com/archives/C99/p1700000000000100');
  });

  it('returns null when neither permalink nor channel/ts are available', () => {
    expect(resolveSlackPermalink({ permalink: 'not-a-url' })).toBeNull();
    expect(resolveSlackPermalink({})).toBeNull();
  });
});
