/**
 * Parse memory citation hrefs produced by memory_search / memory_read
 * (e.g. memory:{id} or memory://{id}).
 */
export function parseMemoryHref(href?: string | null): string | null {
  if (!href) return null;
  const trimmed = href.trim();
  const match = /^memory:(?:\/\/)?(.+)$/i.exec(trimmed);
  if (!match) return null;
  const id = match[1].trim().replace(/^\/+/, '');
  return id || null;
}
