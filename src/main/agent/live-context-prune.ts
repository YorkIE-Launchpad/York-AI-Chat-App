/**
 * Live session context pruning + Anthropic context-editing helpers.
 *
 * Compaction only fires near overflow. Pruning old tool results on every turn
 * (and asking Anthropic to clear_tool_uses when input is large) keeps token
 * counts down on long agent loops without waiting for auto-compact.
 */
import { pruneToolOutputs } from './compaction-extension';

export const LIVE_PRUNE_TOOL_OUTPUT_ABOVE = 500;
export const LIVE_PRUNE_KEEP_RECENT = 3;

/** Anthropic context-editing defaults (clear enough that a cache rewrite pays off). */
export const ANTHROPIC_CONTEXT_EDIT_TRIGGER_TOKENS = 50_000;
export const ANTHROPIC_CONTEXT_EDIT_KEEP_TOOL_USES = 4;
export const ANTHROPIC_CONTEXT_EDIT_CLEAR_AT_LEAST = 20_000;
export const ANTHROPIC_CONTEXT_MANAGEMENT_BETA = 'context-management-2025-06-27';

/**
 * Prune verbose tool outputs in-place on a message array (mutates).
 * Safe to call before each model turn via transformContext.
 */
export function pruneMessagesForLiveTurn(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  messages: any[],
  options?: { pruneToolOutputAbove?: number; keepRecentToolResults?: number }
): { prunedCount: number; totalToolResults: number } {
  return pruneToolOutputs(
    messages,
    options?.pruneToolOutputAbove ?? LIVE_PRUNE_TOOL_OUTPUT_ABOVE,
    options?.keepRecentToolResults ?? LIVE_PRUNE_KEEP_RECENT
  );
}

/**
 * Inject Anthropic context_management clear_tool_uses into a request payload.
 * Returns the (possibly mutated) payload for onPayload chaining.
 */
export function injectAnthropicContextEditing(
  payload: Record<string, unknown>,
  options?: {
    triggerTokens?: number;
    keepToolUses?: number;
    clearAtLeast?: number;
  }
): Record<string, unknown> {
  if (!payload || typeof payload !== 'object') return payload;

  // Don't override an explicit caller-provided context_management block.
  if (payload.context_management) return payload;

  payload.context_management = {
    edits: [
      {
        type: 'clear_tool_uses_20250919',
        trigger: {
          type: 'input_tokens',
          value: options?.triggerTokens ?? ANTHROPIC_CONTEXT_EDIT_TRIGGER_TOKENS,
        },
        keep: {
          type: 'tool_uses',
          value: options?.keepToolUses ?? ANTHROPIC_CONTEXT_EDIT_KEEP_TOOL_USES,
        },
        clear_at_least: {
          type: 'input_tokens',
          value: options?.clearAtLeast ?? ANTHROPIC_CONTEXT_EDIT_CLEAR_AT_LEAST,
        },
      },
    ],
  };

  return payload;
}

/**
 * Ensure the Anthropic context-management beta header is present on a headers map.
 */
export function withAnthropicContextManagementBeta(
  headers: Record<string, string> | undefined | null
): Record<string, string> {
  const next = { ...(headers || {}) };
  const existing = next['anthropic-beta'] || next['Anthropic-Beta'] || '';
  if (existing.includes(ANTHROPIC_CONTEXT_MANAGEMENT_BETA)) {
    return next;
  }
  next['anthropic-beta'] = existing
    ? `${existing},${ANTHROPIC_CONTEXT_MANAGEMENT_BETA}`
    : ANTHROPIC_CONTEXT_MANAGEMENT_BETA;
  return next;
}

/** True when this model/API can accept Anthropic context_management. */
export function supportsAnthropicContextEditing(api: string | undefined | null): boolean {
  return api === 'anthropic-messages';
}
