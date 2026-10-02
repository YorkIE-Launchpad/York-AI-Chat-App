/**
 * Employee capture-prompt override from Loops settings.
 * Shared by the Jev keep path and the LLM screen fallback.
 */

/** Short clause appended to keep questions. The full prompt lives in state once. */
export function loopCaptureRuleClause(capturePrompt?: string | null): string {
  if (!capturePrompt?.trim()) return '';
  return ' When employeeCaptureRules conflict with the default, follow the employee rules.';
}

/** Append the capture prompt so a screen follows it when it conflicts with built-in rules. */
export function withLoopCaptureOverride(prompt: string, capturePrompt?: string | null): string {
  const extra = capturePrompt?.trim();
  if (!extra) return prompt;
  return `${prompt}\n\nEmployee capture rules (apply on top of the rules above; when they conflict, follow the employee rules):\n${extra}`;
}
