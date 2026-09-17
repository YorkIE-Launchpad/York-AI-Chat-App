import { describe, expect, it } from 'vitest';
import { matterDeepLinkUrl, parseMatterDeepLinkUrl } from '../src/shared/matter-deeplink';

describe('parseMatterDeepLinkUrl', () => {
  it('parses home, meeting, and item links', () => {
    expect(parseMatterDeepLinkUrl('yorkgrowthos://matter')).toEqual({ type: 'home' });
    expect(parseMatterDeepLinkUrl('yorkgrowthos://matter/meeting?id=abc')).toEqual({
      type: 'meeting',
      meetingId: 'abc',
    });
    expect(parseMatterDeepLinkUrl('yorkgrowthos://matter/item?id=sig-1')).toEqual({
      type: 'item',
      itemId: 'sig-1',
    });
  });

  it('rejects unknown hosts', () => {
    expect(parseMatterDeepLinkUrl('yorkgrowthos://settings')).toBeNull();
    expect(parseMatterDeepLinkUrl('https://example.com')).toBeNull();
  });
});

describe('matterDeepLinkUrl', () => {
  it('round-trips meeting and item urls', () => {
    const meeting = matterDeepLinkUrl({ type: 'meeting', meetingId: 'm1' });
    expect(parseMatterDeepLinkUrl(meeting)).toEqual({ type: 'meeting', meetingId: 'm1' });
    const item = matterDeepLinkUrl({ type: 'item', itemId: 'x/y' });
    expect(parseMatterDeepLinkUrl(item)).toEqual({ type: 'item', itemId: 'x/y' });
  });
});
