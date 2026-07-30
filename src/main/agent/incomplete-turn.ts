/**
 * Incomplete-turn detection — catches agent turns that discover work (e.g.
 * mcp_search_tools) then end without acting, or finish with thinking-only
 * content on an actionable user request.
 *
 * Pure helpers so the host (agent-runner) can decide whether to steer once
 * and/or surface a clear failure message instead of silently going idle.
 */

import { MCP_CALL_TOOL_NAME, MCP_RUN_TOOL_NAME, MCP_SEARCH_TOOLS_NAME } from './mcp-tool-budget';

/** Imperative / write-oriented cues that imply the user expects an action. */
const ACTIONABLE_PROMPT_RE =
  /\b(send|post|message|dm|email|mail|create|update|edit|write|delete|remove|schedule|book|invite|share|upload|download|reply|forward|assign|comment|transition|publish|deploy|run|execute|call|invoke|set|add|attach|move|rename|copy|paste|open|close|start|stop|cancel|approve|reject|submit|fill|click|navigate|screenshot|search\s+and\s+(send|post|create|update)|tell\s+\w+\s+that)\b/i;

export type IncompleteTurnReason = 'search_without_call' | 'thinking_only_actionable' | 'none';

export interface TurnContentSummary {
  hasText: boolean;
  hasThinking: boolean;
  hasToolUse: boolean;
}

export interface IncompleteTurnInput {
  userPrompt: string;
  /** Tool names invoked during this turn (e.g. from tool_execution_start). */
  toolsInvoked: readonly string[];
  /** Summary of the final assistant message content for this turn. */
  finalAssistant: TurnContentSummary;
}

export interface IncompleteTurnDecision {
  incomplete: boolean;
  reason: IncompleteTurnReason;
}

export const INCOMPLETE_TURN_FAILURE_MESSAGE =
  '**Stopped before finishing the action.** I found what to do but did not complete it. Send “continue” to retry.';

const NOOP: IncompleteTurnDecision = { incomplete: false, reason: 'none' };

/** True when the user prompt looks like an actionable request (not pure Q&A). */
export function isActionableUserPrompt(prompt: string): boolean {
  const trimmed = (prompt || '').trim();
  if (!trimmed) return false;
  return ACTIONABLE_PROMPT_RE.test(trimmed);
}

/** Summarize assistant content blocks for incomplete-turn checks. */
export function summarizeContentBlocks(
  blocks: ReadonlyArray<{ type?: string; text?: string; thinking?: string }>
): TurnContentSummary {
  let hasText = false;
  let hasThinking = false;
  let hasToolUse = false;

  for (const block of blocks) {
    const type = block.type ?? '';
    if (type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
      hasText = true;
    } else if (
      type === 'thinking' &&
      typeof block.thinking === 'string' &&
      block.thinking.trim() !== ''
    ) {
      hasThinking = true;
    } else if (type === 'tool_use' || type === 'toolCall') {
      hasToolUse = true;
    }
  }

  return { hasText, hasThinking, hasToolUse };
}

function normalizeToolName(name: string): string {
  return (name || '').trim().toLowerCase();
}

function toolsInclude(toolsInvoked: readonly string[], target: string): boolean {
  const needle = normalizeToolName(target);
  return toolsInvoked.some((t) => normalizeToolName(t) === needle);
}

/**
 * Decide whether a completed prompt turn looks incomplete and should be
 * auto-continued (steer) or reported to the user.
 */
export function detectIncompleteTurn(input: IncompleteTurnInput): IncompleteTurnDecision {
  const actionable = isActionableUserPrompt(input.userPrompt);
  if (!actionable) return NOOP;

  const searched = toolsInclude(input.toolsInvoked, MCP_SEARCH_TOOLS_NAME);
  const called =
    toolsInclude(input.toolsInvoked, MCP_CALL_TOOL_NAME) ||
    toolsInclude(input.toolsInvoked, MCP_RUN_TOOL_NAME);

  if (searched && !called) {
    return { incomplete: true, reason: 'search_without_call' };
  }

  const { hasText, hasThinking, hasToolUse } = input.finalAssistant;
  // Thinking-only abort with no tool progress (search-then-stop is covered above).
  if (hasThinking && !hasText && !hasToolUse && input.toolsInvoked.length === 0) {
    return { incomplete: true, reason: 'thinking_only_actionable' };
  }

  return NOOP;
}

/** Steering message injected once when an incomplete turn is detected. */
export function buildIncompleteTurnSteerMessage(reason: IncompleteTurnReason): string {
  if (reason === 'search_without_call') {
    return (
      '[Incomplete turn · Continue] You already ran mcp_search_tools and found matching tools, ' +
      'but you did not call mcp_call_tool.\n' +
      '**Immediately call mcp_call_tool** with the exact tool name and arguments needed to finish the user request. ' +
      'Do not stop after searching. Do not only plan or think — execute now.'
    );
  }
  if (reason === 'thinking_only_actionable') {
    return (
      '[Incomplete turn · Continue] Your last response was thinking only and the user asked for an action.\n' +
      '**Execute the next tool call now** (for MCP: mcp_call_tool with the exact name/args). ' +
      'Do not end the turn with only a plan.'
    );
  }
  return (
    '[Incomplete turn · Continue] Finish the user request now with the appropriate tool call. ' +
    'Do not stop mid-task.'
  );
}
