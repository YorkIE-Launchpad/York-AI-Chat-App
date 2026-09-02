/**
 * User OpenRouter key (bring-your-own): stored locally and sent to the local proxy
 * as a dedicated header (Cognito JWT stays in Authorization).
 *
 * Product rule: General workspace and personal Folders only use OpenRouter with
 * this key — not York-billed Anthropic/OpenAI/Gemini. Hub uses your personal
 * York allowance; Project uses York-managed models — neither needs this key.
 */

export const YORK_OPENROUTER_USER_KEY_HEADER = 'x-york-openrouter-key';

export const OPENROUTER_KEY_REQUIRED_MESSAGE =
  'General and personal Folders run on OpenRouter with your own API key — York does not pay for those models. Add your key in Settings → General (get one free at openrouter.ai/keys). Free OpenRouter models have no per-token cost (rate limits apply). For York-managed Claude, GPT, or Gemini, switch to Hub or a Project workspace.';

export const OPENROUTER_LIMIT_USER_MESSAGE =
  'Your OpenRouter account hit a rate or credit limit (limits apply to the whole key). Add credits at openrouter.ai (about $10 raises daily limits to 1000 requests/day), pick a free OpenRouter model, or switch to Hub / Project for York-managed company models.';

export const OPENROUTER_LIMIT_FALLBACK_NOTE =
  'OpenRouter limit hit on your key; switched to a York eco model.';

export function hasOpenRouterUserApiKey(value: string | undefined | null): boolean {
  return Boolean(value?.trim());
}

/** True when this workspace only supports OpenRouter + the user’s own key. */
export function isOpenRouterUserKeyWorkspace(
  division: { kind?: string | null } | null | undefined
): boolean {
  const kind = division?.kind;
  return kind === 'general' || kind === 'folder';
}

/** True when chat would need an OpenRouter key but none is saved. */
export function needsOpenRouterUserKey(
  division: { kind?: string | null } | null | undefined,
  openRouterUserApiKey: string | undefined | null,
  options?: { activeSource?: 'project' | 'user' | 'none' | null; budgetReady?: boolean }
): boolean {
  if (isOpenRouterUserKeyWorkspace(division)) {
    return !hasOpenRouterUserApiKey(openRouterUserApiKey);
  }
  if (division?.kind === 'hub' || division?.kind === 'project' || division?.kind === 'client') {
    if (!options?.budgetReady) return false;
    if (options.activeSource === 'none') {
      return !hasOpenRouterUserApiKey(openRouterUserApiKey);
    }
  }
  return false;
}

/** Free / router catalog entries shown under "Free" in the General model picker. */
export function isOpenRouterFreeTierModel(id: string): boolean {
  const lower = id.trim().toLowerCase();
  if (lower === 'openrouter/free' || lower.startsWith('openrouter/auto')) return true;
  return lower.endsWith(':free') || lower.includes(':free/');
}

/** Attach user OpenRouter key header for proxy calls. Cognito JWT remains Authorization. */
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
