import { describe, expect, it } from 'vitest';
import { extractSearchableText, toFtsMatchQuery } from '../src/shared/chat-search';
import { parseExternalReferenceUrl } from '../src/shared/external-reference-urls';

describe('toFtsMatchQuery', () => {
  it('builds a prefix AND query and strips special characters', () => {
    expect(toFtsMatchQuery('hello world')).toBe('"hello"* AND "world"*');
    expect(toFtsMatchQuery('foo"bar^')).toBe('"foobar"*');
    expect(toFtsMatchQuery('   ')).toBe('');
  });
});

describe('extractSearchableText', () => {
  it('extracts text, filenames, and reference titles while skipping images', () => {
    const content = JSON.stringify([
      { type: 'text', text: 'Ship the launch notes' },
      { type: 'file_attachment', filename: 'brief.pdf' },
      { type: 'meeting_attachment', title: 'Standup' },
      {
        type: 'external_reference',
        source: 'jira',
        title: 'PLAT-12 Fix login',
        subtitle: 'Jira',
      },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
      },
    ]);
    expect(extractSearchableText(content)).toContain('Ship the launch notes');
    expect(extractSearchableText(content)).toContain('brief.pdf');
    expect(extractSearchableText(content)).toContain('Standup');
    expect(extractSearchableText(content)).toContain('PLAT-12 Fix login');
    expect(extractSearchableText(content)).not.toContain('AAAA');
  });
});

describe('parseExternalReferenceUrl', () => {
  it('parses Drive, Slack, and Jira permalinks', () => {
    expect(
      parseExternalReferenceUrl('https://drive.google.com/file/d/abc123xyz/view')?.source
    ).toBe('drive');
    expect(
      parseExternalReferenceUrl('https://docs.google.com/document/d/docid99/edit')?.externalId
    ).toBe('docid99');
    const slack = parseExternalReferenceUrl(
      'https://yorkie.slack.com/archives/C0123ABCDE/p1700000000000000'
    );
    expect(slack?.source).toBe('slack');
    expect(slack?.meta?.channelId).toBe('C0123ABCDE');
    expect(slack?.meta?.ts).toBe('1700000000.000000');
    const jira = parseExternalReferenceUrl('https://yorkblack.atlassian.net/browse/PLAT-42');
    expect(jira?.source).toBe('jira');
    expect(jira?.externalId).toBe('PLAT-42');
    const confluence = parseExternalReferenceUrl(
      'https://yorkblack.atlassian.net/wiki/spaces/ENG/pages/123456789/Architecture'
    );
    expect(confluence?.source).toBe('confluence');
    expect(confluence?.externalId).toBe('123456789');
    expect(confluence?.meta?.cloudId).toBe('yorkblack.atlassian.net');
    expect(confluence?.meta?.spaceKey).toBe('ENG');
  });

  it('returns null for unrelated text', () => {
    expect(parseExternalReferenceUrl('hello world')).toBeNull();
    expect(parseExternalReferenceUrl('https://example.com/docs')).toBeNull();
  });
});
