/**
 * Deep links from the macOS Matter widget (yorkgrowthos://).
 */

export type MatterOpenDeepLink =
  | { type: 'home' }
  | { type: 'meeting'; meetingId: string }
  | { type: 'item'; itemId: string };

export const MATTER_DEEP_LINK_SCHEME = 'yorkgrowthos';

export function parseMatterDeepLinkUrl(raw: string): MatterOpenDeepLink | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== `${MATTER_DEEP_LINK_SCHEME}:`) return null;
  const host = (url.hostname || '').toLowerCase();
  if (host !== 'matter') return null;

  const path = url.pathname.replace(/\/$/, '') || '/';
  if (path === '/' || path === '') {
    return { type: 'home' };
  }
  if (path === '/meeting') {
    const meetingId = url.searchParams.get('id')?.trim();
    if (!meetingId) return { type: 'home' };
    return { type: 'meeting', meetingId };
  }
  if (path === '/item') {
    const itemId = url.searchParams.get('id')?.trim();
    if (!itemId) return { type: 'home' };
    return { type: 'item', itemId };
  }
  return null;
}

export function matterDeepLinkUrl(link: MatterOpenDeepLink): string {
  const base = `${MATTER_DEEP_LINK_SCHEME}://matter`;
  if (link.type === 'home') return base;
  if (link.type === 'meeting') {
    return `${base}/meeting?id=${encodeURIComponent(link.meetingId)}`;
  }
  return `${base}/item?id=${encodeURIComponent(link.itemId)}`;
}
