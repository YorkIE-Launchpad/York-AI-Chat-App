/**
 * Helpers to parse Confluence Cloud page URLs and build user-facing browse links.
 */

/** Default York IE Confluence site when the payload has no *.atlassian.net host. */
export const DEFAULT_CONFLUENCE_SITE_ORIGIN = 'https://yorkblack.atlassian.net';

export interface ConfluenceUrlParts {
  pageId: string;
  siteOrigin: string;
  spaceKey?: string;
  contentType?: 'page' | 'blog';
}

/** Site origin from a Cloud URL like https://yorkblack.atlassian.net/wiki/... */
export function confluenceSiteOriginFromUrl(url: string): string | undefined {
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

/** True when the URL looks like a Confluence wiki link on an Atlassian Cloud site. */
export function isConfluenceUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname;
    if (!confluenceSiteOriginFromUrl(url)) return false;
    if (/\/wiki\/x\/[^/]+/i.test(path)) return true;
    if (/\/wiki\/spaces\/[^/]+\/pages\/\d+/i.test(path)) return true;
    if (/\/wiki\/spaces\/[^/]+\/blog\/\d+\/\d+\/\d+\/\d+/i.test(path)) return true;
    if (/\/wiki\/pages\/viewpage\.action/i.test(path) && parsed.searchParams.has('pageId')) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** Page ID (numeric or tiny-link token) embedded in a Confluence URL. */
export function confluencePageIdFromUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname;

    const tiny = path.match(/\/wiki\/x\/([^/?#]+)/i);
    if (tiny) return tiny[1];

    const viewPageId = parsed.searchParams.get('pageId');
    if (viewPageId && /^\d+$/.test(viewPageId)) return viewPageId;

    const page = path.match(/\/wiki\/spaces\/[^/]+\/pages\/(\d+)/i);
    if (page) return page[1];

    const blog = path.match(/\/wiki\/spaces\/[^/]+\/blog\/\d+\/\d+\/\d+\/(\d+)/i);
    if (blog) return blog[1];

    return undefined;
  } catch {
    return undefined;
  }
}

/** Space key from a Confluence spaces URL path. */
export function confluenceSpaceKeyFromUrl(url: string): string | undefined {
  try {
    const path = new URL(url).pathname;
    const match = path.match(/\/wiki\/spaces\/([^/]+)\//i);
    return match?.[1];
  } catch {
    return undefined;
  }
}

export function parseConfluenceUrl(url: string): ConfluenceUrlParts | null {
  if (!isConfluenceUrl(url)) return null;
  const pageId = confluencePageIdFromUrl(url);
  if (!pageId) return null;
  const siteOrigin =
    confluenceSiteOriginFromUrl(url) || DEFAULT_CONFLUENCE_SITE_ORIGIN;
  const spaceKey = confluenceSpaceKeyFromUrl(url);
  const contentType = /\/wiki\/spaces\/[^/]+\/blog\//i.test(url) ? 'blog' : 'page';
  return { pageId, siteOrigin, spaceKey, contentType };
}

export function confluencePageUrl(
  pageId: string,
  siteOrigin: string = DEFAULT_CONFLUENCE_SITE_ORIGIN,
  spaceKey?: string,
  title?: string
): string {
  const origin = siteOrigin.replace(/\/$/, '') || DEFAULT_CONFLUENCE_SITE_ORIGIN;
  const id = pageId.trim();
  if (spaceKey) {
    const slug = title ? `/${encodeURIComponent(title.trim())}` : '';
    return `${origin}/wiki/spaces/${encodeURIComponent(spaceKey)}/pages/${id}${slug}`;
  }
  return `${origin}/wiki/pages/viewpage.action?pageId=${encodeURIComponent(id)}`;
}
