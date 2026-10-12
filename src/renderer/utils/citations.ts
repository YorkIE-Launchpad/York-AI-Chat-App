/**
 * Numbered citations: the agent ends answers with a "Sources:" list and cites inline
 * with [n]. We split the list off, number it, and turn [n] markers into cite: links.
 */

export interface Citation {
  n: number;
  title: string;
  url?: string;
}

export interface CitationParse {
  body: string;
  sources: Citation[];
}

export const CITE_PROTOCOL = 'cite:';

const HEADING_RE = /^\s*(?:#{1,4}\s*)?(?:\*\*|__)?Sources(?:\*\*|__)?\s*:?\s*(?:\*\*|__)?\s*$/i;
const LIST_ITEM_RE = /^\s*(?:[-*•]|\d{1,2}[.)])\s+(.*)$/;
const MD_LINK_RE = /^\[([^\]]+)\]\(([^)\s]+)\)\s*(.*)$/;
const BARE_URL_RE = /^<?(https?:\/\/[^\s>]+)>?\s*(.*)$/;

function parseItem(raw: string): { title: string; url?: string } | null {
  const text = raw.trim();
  if (!text) return null;
  const link = MD_LINK_RE.exec(text);
  if (link) {
    const rest = link[3].replace(/^[—–:-]\s*/, '').trim();
    return { title: rest ? `${link[1]} — ${rest}` : link[1], url: link[2] };
  }
  const bare = BARE_URL_RE.exec(text);
  if (bare) {
    const rest = bare[2].replace(/^[—–:-]\s*/, '').trim();
    return { title: rest || bare[1], url: bare[1] };
  }
  return { title: text.replace(/\*\*/g, '') };
}

/** Splits a trailing "Sources:" section (list items only) off an answer. */
export function splitSources(text: string): CitationParse {
  const lines = text.split('\n');
  let headingIndex = -1;
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) inFence = !inFence;
    if (!inFence && HEADING_RE.test(lines[i])) headingIndex = i;
  }
  if (headingIndex < 0) return { body: text, sources: [] };

  const sources: Citation[] = [];
  let end = headingIndex + 1;
  for (; end < lines.length; end++) {
    const line = lines[end];
    if (!line.trim()) continue;
    const item = LIST_ITEM_RE.exec(line);
    if (!item) break;
    const parsed = parseItem(item[1]);
    if (parsed) sources.push({ n: sources.length + 1, ...parsed });
  }
  if (sources.length === 0) return { body: text, sources: [] };

  const body = [...lines.slice(0, headingIndex), ...lines.slice(end)].join('\n').trimEnd();
  return { body, sources };
}

const MARKER_RE = /\[(\d{1,2}(?:\s*,\s*\d{1,2})*)\](?![(:\]])/g;

/** Rewrites inline [n] / [1, 2] markers that match a source into [n](cite:n) links. */
export function linkCitationMarkers(body: string, sourceCount: number): string {
  if (sourceCount === 0) return body;
  const parts = body.split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return part;
      return part.replace(MARKER_RE, (match, list: string, offset: number, whole: string) => {
        if (whole[offset - 1] === '^' || whole[offset - 1] === ']') return match;
        const nums = list.split(',').map((n) => Number(n.trim()));
        if (nums.some((n) => !Number.isInteger(n) || n < 1 || n > sourceCount)) return match;
        return nums.map((n) => `[${n}](${CITE_PROTOCOL}${n})`).join('');
      });
    })
    .join('');
}

export function citationHost(url?: string): string {
  if (!url) return '';
  if (url.startsWith('memory:')) return 'Memory';
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}
