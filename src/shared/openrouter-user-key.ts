/**
 * User OpenRouter BYOK: key is stored locally and sent to the local proxy
 * as a dedicated header (Cognito JWT stays in Authorization).
 */

export const YORK_OPENROUTER_USER_KEY_HEADER = 'x-york-openrouter-key';

export const OPENROUTER_KEY_REQUIRED_MESSAGE =
  'OpenRouter requires your own API key. Add one in Settings → General (get a key at openrouter.ai/keys). Free models have no per-token cost; with $10+ in credits you get higher daily limits (20 RPM / 1000 RPD vs 20 RPM / 50 RPD).';

export const OPENROUTER_LIMIT_USER_MESSAGE =
  'OpenRouter rate or credit limit reached for your key (limits apply to the whole account). Add credits at openrouter.ai (≈$10 raises daily limits to 1000 requests/day), or switch to another provider.';

export const OPENROUTER_LIMIT_FALLBACK_NOTE = 'OpenRouter limit hit; switched to York eco model.';

export function hasOpenRouterUserApiKey(value: string | undefined | null): boolean {
  return Boolean(value?.trim());
}

/** Attach BYOK header for OpenRouter proxy calls. Cognito JWT remains Authorization. */
export function withOpenRouterUserKeyHeader<T extends { headers?: Record<string, string> }>(
  model: T,
  userKey: string | undefined | null
): T {
  const key = userKey?.trim();
  if (!key) return model;
  return {
    ...model,
    headers: {
      ...(model.headers || {}),
      [YORK_OPENROUTER_USER_KEY_HEADER]: key,
    },
  };
}
