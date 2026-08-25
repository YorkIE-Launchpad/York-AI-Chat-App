/**
 * Shared web search used by ToolExecutor, SandboxToolExecutor, and the agent websearch tool.
 * DuckDuckGo Instant Answer plus HTML result links when the instant API is thin.
 */

const RESULT_CHAR_LIMIT = 20000;
const SEARCH_TIMEOUT_MS = 10000;
const HTML_RESULT_LIMIT = 8;

const SEARCH_HEADERS: HeadersInit = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

type TopicItem = { text: string; url?: string };

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

async function fetchWithTimeout(url: string): Promise<Response> {
  try {
    return await fetch(url, {
      headers: SEARCH_HEADERS,
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new Error('Request timed out, please check your network connection and retry');
    }
    throw error;
  }
}

function collectTopics(topic: unknown, results: TopicItem[]): void {
  if (!topic || typeof topic !== 'object') return;
  const record = topic as Record<string, unknown>;
  const text = typeof record.Text === 'string' ? record.Text : '';
  const firstUrl = typeof record.FirstURL === 'string' ? record.FirstURL : '';
  if (text) {
    results.push({ text, url: firstUrl || undefined });
  }
  const nested = Array.isArray(record.Topics) ? record.Topics : [];
  for (const nestedItem of nested) {
    collectTopics(nestedItem, results);
  }
}

function parseDuckDuckGoHtml(html: string): TopicItem[] {
  const results: TopicItem[] = [];
  const seen = new Set<string>();
  const linkRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = linkRe.exec(html)) !== null && results.length < HTML_RESULT_LIMIT) {
    const href = decodeDuckDuckGoRedirect(match[1] || '');
    const text = stripTags(match[2] || '').trim();
    if (!href || !text || seen.has(href)) continue;
    seen.add(href);
    results.push({ text, url: href });
  }
  return results;
}

function decodeDuckDuckGoRedirect(href: string): string {
  try {
    const parsed = new URL(href, 'https://duckduckgo.com');
    const uddg = parsed.searchParams.get('uddg');
    if (uddg) return uddg;
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.toString();
  } catch {
    // ignore malformed hrefs
  }
  return '';
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
}

function trimOutput(text: string): string {
  if (text.length <= RESULT_CHAR_LIMIT) return text;
  return `${text.slice(0, RESULT_CHAR_LIMIT)}\n\n[Truncated ${text.length - RESULT_CHAR_LIMIT} chars]`;
}

/**
 * Search the public web and return a compact text summary for the model.
 */
export async function searchWeb(query: string): Promise<string> {
  const trimmed = query.trim();
  if (!trimmed) {
    throw new Error('Query is required');
  }

  const instantUrl = new URL('https://api.duckduckgo.com/');
  instantUrl.searchParams.set('q', trimmed);
  instantUrl.searchParams.set('format', 'json');
  instantUrl.searchParams.set('no_redirect', '1');
  instantUrl.searchParams.set('no_html', '1');
  instantUrl.searchParams.set('skip_disambig', '1');

  const instantResponse = await fetchWithTimeout(instantUrl.toString());
  if (!instantResponse.ok) {
    throw new Error(`Search request failed with status ${instantResponse.status}`);
  }

  const data = (await instantResponse.json()) as Record<string, unknown>;
  const heading = typeof data.Heading === 'string' ? data.Heading : '';
  const abstractText = typeof data.AbstractText === 'string' ? data.AbstractText : '';
  const abstractUrl = typeof data.AbstractURL === 'string' ? data.AbstractURL : '';
  const relatedTopics = Array.isArray(data.RelatedTopics) ? data.RelatedTopics : [];

  const results: TopicItem[] = [];
  for (const topic of relatedTopics) {
    collectTopics(topic, results);
  }

  if (results.length < 3) {
    try {
      const htmlUrl = new URL('https://html.duckduckgo.com/html/');
      htmlUrl.searchParams.set('q', trimmed);
      const htmlResponse = await fetchWithTimeout(htmlUrl.toString());
      if (htmlResponse.ok) {
        const html = await htmlResponse.text();
        const htmlResults = parseDuckDuckGoHtml(html);
        const seen = new Set(results.map((item) => item.url).filter(Boolean));
        for (const item of htmlResults) {
          if (item.url && seen.has(item.url)) continue;
          if (item.url) seen.add(item.url);
          results.push(item);
        }
      }
    } catch {
      // HTML fallback is best-effort; Instant Answer output still ships.
    }
  }

  const lines: string[] = [];
  lines.push(`Query: ${trimmed}`);
  lines.push('Source: DuckDuckGo');
  if (heading) lines.push(`Heading: ${heading}`);
  if (abstractText) {
    lines.push(`Abstract: ${abstractText}${abstractUrl ? ` (${abstractUrl})` : ''}`);
  }

  const topResults = results.slice(0, 8);
  if (topResults.length > 0) {
    lines.push('Results:');
    for (const item of topResults) {
      lines.push(`- ${item.text}${item.url ? ` (${item.url})` : ''}`);
    }
    lines.push(
      'Next: use webfetch on the most relevant http(s) URLs. Do not use Chrome MCP for this research.'
    );
  } else if (!abstractText) {
    lines.push('Results: No related topics found.');
  }

  return trimOutput(lines.join('\n'));
}
