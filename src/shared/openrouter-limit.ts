/**
 * Detect OpenRouter account-wide rate/credit limits and map user-facing copy.
 */
import {
  OPENROUTER_KEY_REQUIRED_MESSAGE,
  OPENROUTER_LIMIT_USER_MESSAGE,
} from './openrouter-user-key';

export function isOpenRouterProvider(provider: string | undefined | null): boolean {
  return (provider || '').trim().toLowerCase() === 'openrouter';
}

function isRateLimitError(errorText: string): boolean {
  const lower = errorText.toLowerCase();
  return (
    /\b429\b/.test(errorText) ||
    lower.includes('rate limit') ||
    lower.includes('rate limited') ||
    lower.includes('too many requests')
  );
}

function isUsageLimitError(errorText: string): boolean {
  const lower = errorText.toLowerCase();
  return (
    /\b402\b/.test(errorText) ||
    lower.includes('usage limit') ||
    lower.includes('api usage') ||
    lower.includes('quota exceeded') ||
    lower.includes('out of quota') ||
    lower.includes('regain access') ||
    lower.includes('billing') ||
    lower.includes('more credits') ||
    lower.includes('requires more credits') ||
    lower.includes('can only afford') ||
    lower.includes('insufficient credits')
  );
}

/** True when an OpenRouter call hit account-wide rate or credit limits. */
export function isOpenRouterAccountLimitError(
  provider: string | undefined | null,
  errorText: string
): boolean {
  if (!isOpenRouterProvider(provider) || !errorText) return false;
  return isRateLimitError(errorText) || isUsageLimitError(errorText);
}

export function openRouterLimitUserMessage(fallbackFailed = false): string {
  if (fallbackFailed) {
    return `${OPENROUTER_LIMIT_USER_MESSAGE} York eco fallback also failed.`;
  }
  return OPENROUTER_LIMIT_USER_MESSAGE;
}

export function openRouterKeyRequiredMessage(): string {
  return OPENROUTER_KEY_REQUIRED_MESSAGE;
}
