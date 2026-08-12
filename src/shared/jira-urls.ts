/**
 * Helpers to turn Jira REST/API self-links into user-facing /browse/{KEY} URLs.
 * MCP and REST payloads often only expose `self` (e.g. .../rest/api/3/issue/10001).
 */

/** Default York IE Jira Cloud site when the payload has no *.atlassian.net host. */
export const DEFAULT_JIRA_SITE_ORIGIN = 'https://yorkblack.atlassian.net';

const ISSUE_KEY_RE = /[A-Z][A-Z0-9]+-\d+/i;

export function isJiraRestApiUrl(url: string): boolean {
  try {
    const pathname = new URL(url).pathname;
    return /\/rest\/api\//i.test(pathname) || /\/gateway\/api\//i.test(pathname);
  } catch {
    return false;
  }
}

/** Site origin from a Cloud URL like https://yorkblack.atlassian.net/... */
export function jiraSiteOriginFromUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (host.endsWith('.atlassian.net') && host !== 'api.atlassian.net') {
      return parsed.origin;
    }
  } catch {
    // ignore
  }
  return undefined;
}

export function jiraBrowseUrl(
  issueKey: string,
  siteOrigin: string = DEFAULT_JIRA_SITE_ORIGIN
): string {
  const key = issueKey.trim().toUpperCase();
  const origin = siteOrigin.replace(/\/$/, '') || DEFAULT_JIRA_SITE_ORIGIN;
  return `${origin}/browse/${key}`;
}

/** Issue key embedded in a path (/browse/KEY or /issue/KEY). */
export function jiraIssueKeyFromUrl(url: string): string | undefined {
  try {
    const pathname = new URL(url).pathname;
    const browse = pathname.match(/\/browse\/([A-Z][A-Z0-9]+-\d+)/i);
    if (browse) return browse[1].toUpperCase();
    const issue = pathname.match(/\/issue\/([A-Z][A-Z0-9]+-\d+)/i);
    if (issue) return issue[1].toUpperCase();
  } catch {
    // ignore
  }
  return undefined;
}

/**
 * Convert a Jira REST self-link to /browse/{KEY}, or drop it when no key is known.
 * Non-Jira / already-browse URLs are returned unchanged.
 */
export function normalizeJiraSourceUrl(
  url: string,
  options?: { issueKey?: string; siteOrigin?: string }
): string | null {
  try {
    const parsed = new URL(url);
    if (/\/browse\/[A-Z][A-Z0-9]+-\d+/i.test(parsed.pathname)) {
      const browseKey = jiraIssueKeyFromUrl(url) || options?.issueKey?.trim();
      if (browseKey && ISSUE_KEY_RE.test(browseKey)) {
        return `${parsed.origin}/browse/${browseKey.toUpperCase()}`;
      }
      return url;
    }

    if (!isJiraRestApiUrl(url)) {
      return url;
    }

    const key = jiraIssueKeyFromUrl(url) || options?.issueKey?.trim();
    if (!key || !ISSUE_KEY_RE.test(key)) return null;

    const site =
      options?.siteOrigin ||
      jiraSiteOriginFromUrl(url) ||
      DEFAULT_JIRA_SITE_ORIGIN;
    return jiraBrowseUrl(key, site);
  } catch {
    return url;
  }
}

/** Prefer JSON `"key":"PROJ-123"` and URL path keys over loose prose matches. */
export function extractJiraIssueKeys(text: string): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const key = raw.toUpperCase();
    if (seen.has(key)) return;
    seen.add(key);
    keys.push(key);
  };

  for (const match of text.matchAll(/"key"\s*:\s*"([A-Z][A-Z0-9]+-\d+)"/gi)) {
    add(match[1]);
  }
  for (const match of text.matchAll(/\/browse\/([A-Z][A-Z0-9]+-\d+)/gi)) {
    add(match[1]);
  }
  for (const match of text.matchAll(/\/issue\/([A-Z][A-Z0-9]+-\d+)/gi)) {
    add(match[1]);
  }
  return keys;
}

/**
 * Rewrite extracted http(s) URLs so Sources open the Jira board (browse), not REST.
 * When results only expose API self-links, synthesize /browse/{KEY} from issue keys.
 */
export function toUserFacingSourceUrls(urls: string[], resultText: string): string[] {
  const siteOrigin =
    urls.map(jiraSiteOriginFromUrl).find(Boolean) || DEFAULT_JIRA_SITE_ORIGIN;
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (url: string | null | undefined) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    out.push(url);
  };

  let sawJiraRest = false;
  for (const url of urls) {
    if (isJiraRestApiUrl(url)) {
      sawJiraRest = true;
      add(normalizeJiraSourceUrl(url, { siteOrigin }));
      continue;
    }
    add(url);
  }

  if (sawJiraRest || /"key"\s*:\s*"[A-Z][A-Z0-9]+-\d+"/i.test(resultText)) {
    for (const key of extractJiraIssueKeys(resultText)) {
      add(jiraBrowseUrl(key, siteOrigin));
    }
  }

  return out;
}
