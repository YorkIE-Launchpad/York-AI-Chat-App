/**
 * Parse Drive / Slack / Jira permalinks pasted into the composer.
 */

import { jiraIssueKeyFromUrl, DEFAULT_JIRA_SITE_ORIGIN } from './jira-urls';
import type { ExternalReferenceContent, ExternalReferenceSource } from './external-reference';

export interface ParsedExternalReferenceUrl {
  source: ExternalReferenceSource;
  externalId: string;
  url: string;
  title?: string;
  subtitle?: string;
  meta?: Record<string, string>;
}

const DRIVE_FILE_RE =
  /https?:\/\/(?:drive|docs)\.google\.com\/(?:file\/d\/|document\/d\/|spreadsheets\/d\/|presentation\/d\/|open\?id=)([a-zA-Z0-9_-]+)/i;
const DRIVE_OPEN_RE = /https?:\/\/drive\.google\.com\/open\?[^#]*\bid=([a-zA-Z0-9_-]+)/i;
const SLACK_ARCHIVE_RE =
  /https?:\/\/[a-z0-9.-]+\.slack\.com\/archives\/([A-Z0-9]+)\/p(\d{10,})(?:\?([^#\s]+))?/i;

function slackTsFromP(pStamp: string): string {
  if (pStamp.length <= 6) return pStamp;
  return `${pStamp.slice(0, pStamp.length - 6)}.${pStamp.slice(pStamp.length - 6)}`;
}

export function parseExternalReferenceUrl(raw: string): ParsedExternalReferenceUrl | null {
  const candidate = raw.trim().split(/\s+/)[0] ?? '';
  if (!/^https?:\/\//i.test(candidate)) return null;

  const jiraKey = jiraIssueKeyFromUrl(candidate);
  if (jiraKey && /atlassian\.net/i.test(candidate)) {
    return {
      source: 'jira',
      externalId: jiraKey,
      url: candidate,
      title: jiraKey,
      subtitle: 'Jira',
    };
  }
  if (jiraKey && /\/browse\//i.test(candidate)) {
    return {
      source: 'jira',
      externalId: jiraKey,
      url: candidate,
      title: jiraKey,
      subtitle: 'Jira',
    };
  }

  const slack = candidate.match(SLACK_ARCHIVE_RE);
  if (slack) {
    const channelId = slack[1];
    const ts = slackTsFromP(slack[2]);
    const params = new URLSearchParams(slack[3] || '');
    const threadTs = params.get('thread_ts') || ts;
    return {
      source: 'slack',
      externalId: `${channelId}:${ts}`,
      url: candidate,
      title: 'Slack message',
      subtitle: channelId,
      meta: { channelId, ts, threadTs },
    };
  }

  const driveOpen = candidate.match(DRIVE_OPEN_RE);
  const driveFile = candidate.match(DRIVE_FILE_RE);
  const fileId = driveOpen?.[1] || driveFile?.[1];
  if (fileId) {
    return {
      source: 'drive',
      externalId: fileId,
      url: candidate,
      title: 'Drive file',
      subtitle: 'Google Drive',
      meta: { fileId },
    };
  }

  return null;
}

export function toExternalReferenceContent(
  parsed: ParsedExternalReferenceUrl
): ExternalReferenceContent {
  return {
    type: 'external_reference',
    source: parsed.source,
    externalId: parsed.externalId,
    title: parsed.title || parsed.externalId,
    url: parsed.url,
    subtitle: parsed.subtitle,
    meta: parsed.meta,
  };
}

export function defaultJiraBrowseUrl(issueKey: string): string {
  return `${DEFAULT_JIRA_SITE_ORIGIN}/browse/${issueKey}`;
}
