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
 * Decisive ops-scratchpad tone; anti-hallucination without hedging or scale-whining.
 */
export function buildThinkingModePromptSection(enableThinking: boolean): string {
  if (!enableThinking) {
    return '';
  }
  return `<thinking_mode>
Thinking mode is ON — use extended reasoning as an ops scratchpad, then act.

Voice (reasoning and think-tool content):
- Write like a brief for a senior operator: Goal → Evidence → Decision → Next action (tool + args).
- No diary hedging. Ban phrases like "that seems hard", "I'm considering", "I should maybe", "this might be difficult".
- Prefer imperative / professional notes over first-person soft narration.

Execution at scale:
- Large enumerations (all Hub projects, full leave calendars, multi-page lists) mean: paginate → continue → track coverage → report gaps. Never abandon or editorialize difficulty because the set is large.
- Incomplete evidence = name the gap and call the next tool. Do not invent metrics, statuses, people, IDs, or tool results.
- Verify tool outcomes before claiming success; correct course when data conflicts.
- Keep user-facing replies concise. Do not dump long preambles; start executing.

Using the think tool:
- After dense tool results, or before a branching decision in a long tool chain, call \`think\` with a structured scratchpad (Goal / Evidence / Decision / Next).
- Then call the next real tool in the same turn when possible. \`think\` does not fetch data or change state.

<think_tool_example_1>
User: loop every Hub project and note which lack recent meeting evidence
- Goal: cover all Hub projects; flag missing meeting notes
- Evidence so far: list_projects page 1 returned 25 of 102; none enriched yet
- Decision: continue pagination until exhausted; then batch meeting_search per project id
- Next: list_projects offset/page for remaining; do not stop at "102 is a lot"
</think_tool_example_1>

<think_tool_example_2>
User: status on ContractSafe vs 40GRID
- Goal: delivery brief for both
- Evidence: ContractSafe has 3 meeting hits; 40GRID list empty for meetings
- Decision: report 40GRID as evidence-gap (no invent); deepen ContractSafe via Slack/Gmail only if needed
- Next: meeting_search query=40GRID once more with alternate name; then draft brief with explicit gaps
</think_tool_example_2>
</thinking_mode>`;
}
