/**
 * Shared HTTP page fetch used by ToolExecutor and the agent webfetch tool.
 * http/https only; truncates large bodies for model context.
 */

const BODY_CHAR_LIMIT = 20000;
const FETCH_TIMEOUT_MS = 15000;

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
      headers: { 'User-Agent': 'york-ie' },
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
