import { parseConfluenceUrl } from './confluence-urls';
import { jiraIssueKeyFromUrl } from './jira-urls';

export function jiraJql(userQuery: string): string {
  const trimmed = userQuery.trim();
  const fromUrl = jiraIssueKeyFromUrl(trimmed);
  if (fromUrl) {
    return `key = "${fromUrl}"`;
  }
  if (/^[A-Z][A-Z0-9]+-\d+$/i.test(trimmed)) {
    return `key = "${trimmed.toUpperCase()}"`;
  }
  const escaped = trimmed.replace(/"/g, '\\"').slice(0, 80);
  if (!escaped) {
    return 'assignee = currentUser() ORDER BY updated DESC';
  }
  return `text ~ "${escaped}" ORDER BY updated DESC`;
}

export function confluenceCql(userQuery: string): string {
  const trimmed = userQuery.trim();
  const fromUrl = parseConfluenceUrl(trimmed);
  if (fromUrl && /^\d+$/.test(fromUrl.pageId)) {
    const type =
      fromUrl.contentType === 'blog' ? 'blogpost' : fromUrl.contentType === 'page' ? 'page' : null;
    if (type) {
      return `id = "${fromUrl.pageId}" AND type = ${type}`;
    }
    return `id = "${fromUrl.pageId}" AND type IN (page, blogpost)`;
  }
  if (/^\d+$/.test(trimmed)) {
    return `id = "${trimmed}" AND type IN (page, blogpost)`;
  }
  const escaped = trimmed.replace(/"/g, '\\"').slice(0, 80);
  if (!escaped) {
    return 'type = page ORDER BY lastModified DESC';
  }
  return `title ~ "${escaped}" AND type = page ORDER BY lastModified DESC`;
}
