/**
 * SuperContext (M2) settings — budgeted pre-turn research scout.
 */

export type SuperContextMode = 'off' | 'cold_intent' | 'always';

export const DEFAULT_SUPER_CONTEXT_MODE: SuperContextMode = 'cold_intent';

/** Approximate character budget for the scout prompt prefix (~3k tokens). */
export const SUPER_CONTEXT_CHAR_BUDGET = 6000;

/** Local retrieval target (ms); scout stays retrieval-only. */
export const SUPER_CONTEXT_SCOUT_TIMEOUT_MS = 3000;

export const SUPER_CONTEXT_BRIEF_PATTERNS: RegExp[] = [
  /\bcatch me up\b/i,
  /\bbrief me\b/i,
  /\bwhat'?s going on\b/i,
  /\bstatus (on|of|for)\b/i,
  /\bupdate on\b/i,
  /\bhow is (project|client)\b/i,
  /\bwho is out\b/i,
  /\bopen loops?\b/i,
  /\bwhat'?s (coming|up) (this|today|tomorrow)\b/i,
];

export function isBriefLikeIntent(prompt: string): boolean {
  const text = prompt.trim();
  if (!text) return false;
  return SUPER_CONTEXT_BRIEF_PATTERNS.some((pattern) => pattern.test(text));
}
