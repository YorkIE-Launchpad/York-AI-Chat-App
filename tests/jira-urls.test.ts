import { describe, expect, it } from 'vitest';
import {
  DEFAULT_JIRA_SITE_ORIGIN,
  extractJiraIssueKeys,
  isJiraRestApiUrl,
  jiraBrowseUrl,
  jiraSiteOriginFromUrl,
  normalizeJiraSourceUrl,
  toUserFacingSourceUrls,
} from '../src/shared/jira-urls';

describe('jira-urls', () => {
  it('detects REST API self-links', () => {
    expect(
      isJiraRestApiUrl('https://yorkblack.atlassian.net/rest/api/3/issue/10001')
    ).toBe(true);
    expect(isJiraRestApiUrl('https://yorkblack.atlassian.net/browse/VECOS-12')).toBe(false);
  });

  it('builds browse URLs and derives site origin from self links', () => {
    expect(jiraBrowseUrl('vecos-12')).toBe(`${DEFAULT_JIRA_SITE_ORIGIN}/browse/VECOS-12`);
    expect(
      jiraSiteOriginFromUrl('https://acme.atlassian.net/rest/api/3/issue/10001')
    ).toBe('https://acme.atlassian.net');
  });

  it('normalizes REST issue URLs that embed a key', () => {
    expect(
      normalizeJiraSourceUrl('https://yorkblack.atlassian.net/rest/api/3/issue/VECOS-42')
    ).toBe('https://yorkblack.atlassian.net/browse/VECOS-42');
  });

  it('normalizes numeric REST issue URLs when an issue key is provided', () => {
    expect(
      normalizeJiraSourceUrl('https://yorkblack.atlassian.net/rest/api/3/issue/10001', {
        issueKey: 'VECOS-42',
      })
    ).toBe('https://yorkblack.atlassian.net/browse/VECOS-42');
  });

  it('drops numeric REST issue URLs when no key is available', () => {
    expect(
      normalizeJiraSourceUrl('https://yorkblack.atlassian.net/rest/api/3/issue/10001')
    ).toBeNull();
  });

  it('extracts issue keys from JSON payloads', () => {
    expect(
      extractJiraIssueKeys(
        JSON.stringify({
          issues: [
            { key: 'VECOS-1', self: 'https://yorkblack.atlassian.net/rest/api/3/issue/1' },
            { key: 'VECOS-2', self: 'https://yorkblack.atlassian.net/rest/api/3/issue/2' },
          ],
        })
      )
    ).toEqual(['VECOS-1', 'VECOS-2']);
  });

  it('rewrites API self-links to browse URLs for Sources', () => {
    const payload = JSON.stringify({
      issues: [
        {
          key: 'VECOS-9',
          self: 'https://yorkblack.atlassian.net/rest/api/3/issue/10009',
          fields: { summary: 'Fix sources' },
        },
      ],
    });
    const urls = ['https://yorkblack.atlassian.net/rest/api/3/issue/10009'];
    expect(toUserFacingSourceUrls(urls, payload)).toEqual([
      'https://yorkblack.atlassian.net/browse/VECOS-9',
    ]);
  });
});
