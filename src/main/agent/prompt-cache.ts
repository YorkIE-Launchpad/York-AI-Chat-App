/**
 * Anthropic / OpenRouter prompt-cache helpers.
 *
 * pi-ai 0.60 applies ephemeral cache_control on Anthropic Messages by default
 * (5-minute TTL). Setting PI_CACHE_RETENTION=long upgrades to ttl:"1h" when the
 * base URL is api.anthropic.com. OpenRouter Claude models get cache_control
 * when provider==="openrouter" and id starts with "anthropic/".
 */
import type { Api, Model } from '@mariozechner/pi-ai';

/** Prefer 1-hour Anthropic prompt cache for long agent tool loops. */
export function enableLongAnthropicPromptCache(): void {
  if (process.env.PI_CACHE_RETENTION !== 'none') {
    process.env.PI_CACHE_RETENTION = 'long';
  }
}

/**
 * Ensure OpenRouter Claude models keep the anthropic/ id prefix and sticky
 * session headers so prompt-cache hits survive multi-turn agent loops.
 */
export function applyOpenRouterClaudeCacheHints(
  model: Model<Api>,
  sessionId?: string | null
): Model<Api> {
  const provider = String(model.provider || '');
  const isOpenRouter =
    provider === 'openrouter' ||
    (typeof model.baseUrl === 'string' && model.baseUrl.includes('openrouter.ai'));
  if (!isOpenRouter) {
    return model;
  }

  let next = model;
  const id = String(model.id || '');
  const looksClaude =
    /(^|\/)claude[-/]/i.test(id) || id.toLowerCase().startsWith('anthropic/');
  if (looksClaude && !id.startsWith('anthropic/') && !id.includes('/')) {
    next = { ...next, id: `anthropic/${id}`, name: next.name || `anthropic/${id}` } as Model<Api>;
  }
  if (provider !== 'openrouter') {
    next = { ...next, provider: 'openrouter' } as Model<Api>;
  }

  if (sessionId?.trim()) {
    const sid = sessionId.trim();
    const prevHeaders =
      next.headers && typeof next.headers === 'object'
        ? { ...(next.headers as Record<string, string>) }
        : {};
    next = {
      ...next,
      headers: {
        ...prevHeaders,
        // OpenRouter sticky routing so cache stays on the same upstream host.
        'x-session-id': sid,
      },
    } as Model<Api>;
  }

  return next;
}
