/**
 * Incomplete-turn detection — catches agent turns that discover work (e.g.
 * mcp_search_tools) then end without acting, finish with thinking-only content
 * on an actionable user request, or stop LaunchPad delivery mid-async / wrong target.
 *
 * Pure helpers so the host (agent-runner) can decide whether to steer once
 * (or multiple times for wait loops) and/or surface a clear failure message
 * instead of silently going idle.
 */

import { isLaunchPadDeliveryIntent } from '../skills/skill-intent-expand';
import { type LaunchPadTurnProgressSnapshot, START_TO_POLL } from './launchpad-turn-progress';
import { MCP_CALL_TOOL_NAME, MCP_RUN_TOOL_NAME, MCP_SEARCH_TOOLS_NAME } from './mcp-tool-budget';

/** Imperative / write-oriented cues that imply the user expects an action. */
const ACTIONABLE_PROMPT_RE =
  /\b(send|post|message|dm|email|mail|create|update|edit|write|delete|remove|schedule|book|invite|share|upload|download|reply|forward|assign|comment|transition|publish|deploy|run|execute|call|invoke|set|add|attach|move|rename|copy|paste|open|close|start|stop|cancel|approve|reject|submit|fill|click|navigate|screenshot|implement|feature|preview|build|fix|qa|release|scope|seed|lock|search\s+and\s+(send|post|create|update)|tell\s+\w+\s+that)\b/i;

export type IncompleteTurnReason =
  | 'search_without_call'
  | 'thinking_only_actionable'
  | 'actionable_without_tools'
  | 'wrong_implement_target'
  | 'async_job_in_progress'
  | 'sdlc_next_step'
  | 'none';

/** Reasons that should re-steer multiple times within one host run (wait/continue). */
export const MULTI_STEER_INCOMPLETE_REASONS: ReadonlySet<IncompleteTurnReason> = new Set([
  'async_job_in_progress',
  'sdlc_next_step',
  'wrong_implement_target',
]);

/** Default max steers for wait/next-step loops (search_without_call stays single). */
export const INCOMPLETE_TURN_MULTI_STEER_MAX = 12;

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
  /** Optional LaunchPad MCP progress snapshot from host tool wrappers. */
  launchPadProgress?: LaunchPadTurnProgressSnapshot | null;
}

export interface IncompleteTurnDecision {
  incomplete: boolean;
  reason: IncompleteTurnReason;
}

export const INCOMPLETE_TURN_FAILURE_MESSAGE =
  '**Stopped before finishing the action.** I found what to do but did not complete it. Send “continue” to retry.';

export const INCOMPLETE_TURN_WAIT_FAILURE_MESSAGE =
  '**Stopped while a LaunchPad job was still in progress.** Send “continue” to keep polling and finish the next step.';

const NOOP: IncompleteTurnDecision = { incomplete: false, reason: 'none' };

/** True when the user prompt looks like an actionable request (not pure Q&A). */
export function isActionableUserPrompt(prompt: string): boolean {
  const trimmed = (prompt || '').trim();
  if (!trimmed) return false;
  if (isLaunchPadDeliveryIntent(trimmed)) return true;
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

  const lp = input.launchPadProgress;

  // LaunchPad wrong surface (backend/development when preview/platform expected).
  if (lp?.hasWrongImplementTarget) {
    return { incomplete: true, reason: 'wrong_implement_target' };
  }

  // Async job started without terminal poll.
  if (lp && lp.asyncJobsInProgress.length > 0) {
    return { incomplete: true, reason: 'async_job_in_progress' };
  }

  // Next SDLC step after terminal implement/lock.
  if (lp && (lp.needsPreviewAfterImplement || lp.needsSeedAfterLock)) {
    return { incomplete: true, reason: 'sdlc_next_step' };
  }

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

  // LaunchPad-style delivery ask answered with chat-only refuse / plan and no tools.
  // Typical failure on weaker models: invent "implementation workspace unavailable".
  if (
    isLaunchPadDeliveryIntent(input.userPrompt) &&
    input.toolsInvoked.length === 0 &&
    hasText &&
    !hasToolUse
  ) {
    return { incomplete: true, reason: 'actionable_without_tools' };
  }

  return NOOP;
}

function preferredPollHint(progress: LaunchPadTurnProgressSnapshot | null | undefined): string {
  const jobs = progress?.asyncJobsInProgress ?? [];
  if (jobs.length === 0) return 'the matching get_* status tool';
  const hints = jobs.map((j) => START_TO_POLL[j] || `status poll for ${j}`);
  return [...new Set(hints)].join(' / ');
}

/** Steering message injected when an incomplete turn is detected. */
export function buildIncompleteTurnSteerMessage(
  reason: IncompleteTurnReason,
  progress?: LaunchPadTurnProgressSnapshot | null
): string {
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
  if (reason === 'actionable_without_tools') {
    return (
      '[Incomplete turn · Continue] The user asked for LaunchPad delivery (implement/preview/release) ' +
      'but you ended with chat-only text and no tools.\n' +
      '**Immediately use LaunchPad MCP tools** (via mcp_call_tool in meta mode, or direct tools when flat). ' +
      'Follow the rnd-launchpad-mcp-sdlc skill: default implement target is platform; use start_scope_implement / start_preview as appropriate. ' +
      'Do **not** refuse because a local implementation workspace is missing — that work runs on platform via MCP, not local files.'
    );
  }
  if (reason === 'wrong_implement_target') {
    return (
      '[Incomplete turn · Continue] You started **backend/development** work but the user asked for **LaunchPad preview/platform**.\n' +
      '**Stop the development/Backend Code path.** Immediately use `start_scope_implement` with `target: "platform"` ' +
      '(LaunchPad frontend/preview). Do not use `target: "development"` or `backend_code_chat_send_message` ' +
      'unless the user explicitly asked for the development repo or Backend Code.\n' +
      'Then poll until terminal and call `start_preview` if the user asked for preview. Poll now with tools — never sleep silently.'
    );
  }
  if (reason === 'async_job_in_progress') {
    const poll = preferredPollHint(progress);
    return (
      '[Incomplete turn · Continue] A LaunchPad long-running job is still in progress.\n' +
      `**Immediately poll** \`${poll}\` (via mcp_call_tool in meta mode). Keep polling until a terminal status ` +
      '(`completed` / `failed` / `locked && !agentActive` / done≥total). ' +
      'Do **not** stop, idle, or ask the user to wait. Do **not** sleep without tool calls — poll with tools now.'
    );
  }
  if (reason === 'sdlc_next_step') {
    if (progress?.needsPreviewAfterImplement) {
      return (
        '[Incomplete turn · Continue] Platform implement finished. The user asked for preview.\n' +
        '**Immediately call `start_preview`**, then poll `get_preview_status` until ready. ' +
        'Do not ask the user; continue the SDLC automatically.'
      );
    }
    if (progress?.needsSeedAfterLock) {
      return (
        '[Incomplete turn · Continue] Lock settled. **Seed the new active release** with ' +
        '`seed_release_from_prior` `{ mode: "baseline_copy" }` on the **new** active id from list_releases. ' +
        'Do not implement on the locked id. Continue the release loop automatically.'
      );
    }
    return (
      '[Incomplete turn · Continue] Continue the next LaunchPad SDLC step automatically ' +
      '(preview / seed next active as appropriate). Do not stop mid-loop.'
    );
  }
  return (
    '[Incomplete turn · Continue] Finish the user request now with the appropriate tool call. ' +
    'Do not stop mid-task.'
  );
}

/** Failure message after steers are exhausted for a given reason. */
export function incompleteTurnFailureMessage(reason: IncompleteTurnReason): string {
  if (
    reason === 'async_job_in_progress' ||
    reason === 'sdlc_next_step' ||
    reason === 'wrong_implement_target'
  ) {
    return INCOMPLETE_TURN_WAIT_FAILURE_MESSAGE;
  }
  return INCOMPLETE_TURN_FAILURE_MESSAGE;
}
