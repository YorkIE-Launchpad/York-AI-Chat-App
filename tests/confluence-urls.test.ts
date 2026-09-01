import { describe, expect, it } from 'vitest';
import {
  confluencePageIdFromUrl,
  confluencePageUrl,
  confluenceSiteOriginFromUrl,
  confluenceSpaceKeyFromUrl,
  DEFAULT_CONFLUENCE_SITE_ORIGIN,
  isConfluenceUrl,
  parseConfluenceUrl,
} from '../src/shared/confluence-urls';

describe('confluence-urls', () => {
  it('detects Confluence wiki URLs', () => {
    expect(
      isConfluenceUrl(
        'https://yorkblack.atlassian.net/wiki/spaces/ENG/pages/123456789/Architecture'
      )
    ).toBe(true);
    expect(
      isConfluenceUrl('https://yorkblack.atlassian.net/wiki/pages/viewpage.action?pageId=99')
    ).toBe(true);
    expect(isConfluenceUrl('https://yorkblack.atlassian.net/wiki/x/AbCdEfGh')).toBe(true);
    expect(isConfluenceUrl('https://yorkblack.atlassian.net/browse/PLAT-42')).toBe(false);
    expect(isConfluenceUrl('https://example.com/wiki/spaces/X/pages/1')).toBe(false);
  });

  it('extracts page ID from standard page URLs', () => {
    expect(
      confluencePageIdFromUrl(
        'https://yorkblack.atlassian.net/wiki/spaces/ENG/pages/123456789/Architecture'
      )
    ).toBe('123456789');
  });

  it('extracts page ID from viewpage.action URLs', () => {
    expect(
      confluencePageIdFromUrl(
        'https://yorkblack.atlassian.net/wiki/pages/viewpage.action?pageId=987654321'
      )
    ).toBe('987654321');
  });

  it('extracts tiny-link page IDs', () => {
    expect(confluencePageIdFromUrl('https://yorkblack.atlassian.net/wiki/x/AbCdEfGh')).toBe(
      'AbCdEfGh'
    );
  });

  it('extracts page ID from blog URLs', () => {
    expect(
      confluencePageIdFromUrl(
        'https://yorkblack.atlassian.net/wiki/spaces/ENG/blog/2024/01/15/555666777/Release'
      )
    ).toBe('555666777');
  });

  it('derives site origin and space key', () => {
    const url = 'https://acme.atlassian.net/wiki/spaces/TEAM/pages/42/Doc';
    expect(confluenceSiteOriginFromUrl(url)).toBe('https://acme.atlassian.net');
    expect(confluenceSpaceKeyFromUrl(url)).toBe('TEAM');
  });

  it('parses full URL parts', () => {
    expect(
      parseConfluenceUrl('https://yorkblack.atlassian.net/wiki/spaces/ENG/pages/123/Title')
    ).toEqual({
      pageId: '123',
      siteOrigin: 'https://yorkblack.atlassian.net',
      spaceKey: 'ENG',
      contentType: 'page',
    });
    expect(
      parseConfluenceUrl(
        'https://yorkblack.atlassian.net/wiki/spaces/ENG/blog/2024/01/15/555/Post'
      )?.contentType
    ).toBe('blog');
  });

  it('builds browse URLs', () => {
    expect(confluencePageUrl('123', DEFAULT_CONFLUENCE_SITE_ORIGIN, 'ENG', 'My Page')).toBe(
      `${DEFAULT_CONFLUENCE_SITE_ORIGIN}/wiki/spaces/ENG/pages/123/My%20Page`
    );
    expect(confluencePageUrl('456', DEFAULT_CONFLUENCE_SITE_ORIGIN)).toBe(
      `${DEFAULT_CONFLUENCE_SITE_ORIGIN}/wiki/pages/viewpage.action?pageId=456`
    );
  });

  it('returns null for unrelated URLs', () => {
    expect(parseConfluenceUrl('https://example.com/docs')).toBeNull();
  });
});
