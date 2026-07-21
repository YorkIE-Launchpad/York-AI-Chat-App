/**
 * Shared HTTP page fetch used by ToolExecutor and the agent webfetch tool.
 * http/https only; truncates large bodies for model context.
 */

const BODY_CHAR_LIMIT = 20000;
const FETCH_TIMEOUT_MS = 15000;

/** Browser-like UA so sites that block bot/custom agents (e.g. 403) still respond. */
const DEFAULT_HEADERS: HeadersInit = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

/**
 * Fetch a web page and return a text summary suitable for agent context.
 */
export async function fetchWebPage(url: string): Promise<string> {
  const trimmed = url.trim();
  if (!trimmed) {
    throw new Error('URL is required');
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('Invalid URL');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Only http/https URLs are supported');
  }

  let response: Response;
  try {
    response = await fetch(parsed.toString(), {
      headers: DEFAULT_HEADERS,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
      throw new Error('Request timed out, please check your network connection and retry');
    }
    throw error;
  }

  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}`);
  }

  const contentType = response.headers.get('content-type') || 'unknown';
  const body = await response.text();
  const truncated =
    body.length > BODY_CHAR_LIMIT
      ? `${body.slice(0, BODY_CHAR_LIMIT)}\n\n[Truncated ${body.length - BODY_CHAR_LIMIT} chars]`
      : body;

  return `URL: ${parsed.toString()}\nStatus: ${response.status}\nContent-Type: ${contentType}\n\n${truncated}`;
}
