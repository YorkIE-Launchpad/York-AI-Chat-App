import { describe, expect, it } from 'vitest';
import {
  buildSlackChannelPageUrl,
  normalizeSlackSourceUrl,
  slackChannelIdFromUrl,
  slackChannelLabelFromResultText,
} from '../src/shared/slack-urls';

describe('slack channel page URLs', () => {
  it('builds client URLs when team id is known', () => {
    expect(buildSlackChannelPageUrl('C08E0DTLAQH', 'T0123ABC')).toBe(
      'https://app.slack.com/client/T0123ABC/C08E0DTLAQH'
    );
  });

  it('falls back to archives channel page without team id', () => {
    expect(buildSlackChannelPageUrl('C08E0DTLAQH')).toBe(
      'https://app.slack.com/archives/C08E0DTLAQH'
    );
  });

  it('strips message permalink suffixes including n[ts]', () => {
    expect(
      normalizeSlackSourceUrl(
        'https://app.slack.com/archives/C08E0DTLAQH/p1788361741127329/n%5B1788341023.941369'
      )
    ).toBe('https://app.slack.com/archives/C08E0DTLAQH');
  });

  it('keeps client URLs as channel pages', () => {
    expect(
      slackChannelIdFromUrl('https://app.slack.com/client/T0123ABC/C08E0DTLAQH')
    ).toBe('C08E0DTLAQH');
    expect(
      normalizeSlackSourceUrl('https://app.slack.com/client/T0123ABC/C08E0DTLAQH/p99')
    ).toBe('https://app.slack.com/client/T0123ABC/C08E0DTLAQH');
  });
});

describe('slackChannelLabelFromResultText', () => {
  it('reads #channel from search tokens', () => {
    expect(
      slackChannelLabelFromResultText(
        'C123|#eng [1700000001.000200] Sam: standup notes\nLink: https://app.slack.com/client/T1/C123',
        'C123'
      )
    ).toBe('#eng');
  });

  it('reads DM display names without a hash', () => {
    expect(
      slackChannelLabelFromResultText('D0123ABC|Jay Smith [1.2] Ada: hello', 'D0123ABC')
    ).toBe('Jay Smith');
  });
});
