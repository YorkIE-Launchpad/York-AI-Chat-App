/**
 * Thinking / extended-reasoning mode for complex tasks.
 * Maps the user-facing enableThinking flag onto pi-ai thinking levels.
 */

/** Matches @mariozechner/pi-agent-core ThinkingLevel (no "max"). */
export type PiThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

/** When thinking is on, use high effort (not just medium) for harder tasks. */
export function resolveThinkingLevel(enableThinking: boolean): PiThinkingLevel {
  return enableThinking ? 'high' : 'off';
}

/**
 * Extra system guidance when thinking mode is active.
 * Reinforces careful tool use and anti-hallucination without dumping long plans to the user.
 */
export function buildThinkingModePromptSection(enableThinking: boolean): string {
  if (!enableThinking) {
    return '';
  }
  return `<thinking_mode>
Thinking mode is ON — slower, more deliberate work for complex tasks.
- Use extended reasoning before answering or acting. Keep user-facing text concise; do not dump long preambles.
- Prefer connected tools and sources for company/work/data facts. Never invent metrics, statuses, people, IDs, or tool results.
- If evidence is incomplete, say what is unknown and what you still need instead of guessing.
- Verify tool outcomes before claiming success; correct course when data conflicts.
</thinking_mode>`;
}
