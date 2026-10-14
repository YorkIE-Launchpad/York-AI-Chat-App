/**
 * Anthropic prompt-cache helpers.
 *
 * pi-ai 0.60 applies ephemeral cache_control on Anthropic Messages by default
 * (5-minute TTL). Setting PI_CACHE_RETENTION=long upgrades to ttl:"1h" when the
 * base URL is api.anthropic.com.
 */

/** Prefer 1-hour Anthropic prompt cache for long agent tool loops. */
export function enableLongAnthropicPromptCache(): void {
  if (process.env.PI_CACHE_RETENTION !== 'none') {
    process.env.PI_CACHE_RETENTION = 'long';
  }
}
