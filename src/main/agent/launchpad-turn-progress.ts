/**
 * LaunchPad turn progress — tracks MCP start/poll calls within a single agent
 * turn so the host can detect wrong implement target, unfinished async jobs,
 * and missing next SDLC steps (e.g. start_preview after platform implement).
 *
 * Pure helpers + a lightweight class; no electron / network.
 */

/** Base names that start a long-running LaunchPad job. */
export const LAUNCHPAD_START_TOOLS = new Set([
  'start_scope_implement',
  'start_preview',
  'lock_release',
  'start_feedback_ai_fix',
  'start_feedback_ai_fix_batch',
  'backend_code_chat_send_message',
  'spawn_dev_agent',
  'create_cursor_agent',
  'start_backend_cloud_deploy',
  'start_scratch_agent',
]);

/** Lifecycle tools we also record (not always long-running). */
export const LAUNCHPAD_LIFECYCLE_TOOLS = new Set(['seed_release_from_prior']);

/** Base names used to poll LaunchPad async jobs. */
export const LAUNCHPAD_POLL_TOOLS = new Set([
  'get_scope_implement_active',
  'get_scope_implement_run',
  'get_preview_status',
  'get_release_lock_status',
  'get_feedback_ai_fix_status',
  'backend_code_chat_get_session',
  'get_agent_status',
  'get_cursor_agent',
  'get_backend_cloud_deploy_latest',
  'get_backend_cloud_deploy_run',
]);

/** Maps start tool → preferred poll tool base name. */
export const START_TO_POLL: Record<string, string> = {
  start_scope_implement: 'get_scope_implement_active',
  start_preview: 'get_preview_status',
  lock_release: 'get_release_lock_status',
  start_feedback_ai_fix: 'get_feedback_ai_fix_status',
  start_feedback_ai_fix_batch: 'get_feedback_ai_fix_status',
  backend_code_chat_send_message: 'backend_code_chat_get_session',
  spawn_dev_agent: 'get_agent_status',
  create_cursor_agent: 'get_cursor_agent',
  start_backend_cloud_deploy: 'get_backend_cloud_deploy_latest',
};

/** Explicit user intent for development-repo / Backend Code work. */
const EXPLICIT_BACKEND_INTENT_RE =
  /\b(development\s+repo|dev\s+repo|backend\s+code|backend\s+repo|target\s*[:=]\s*development|on\s+development)\b/i;

/** User asked for preview / LaunchPad frontend surface. */
const PREVIEW_SURFACE_RE =
  /\b(on\s+preview|launchpad\s+preview|through\s+launchpad|via\s+launchpad|start_preview|fc\d+)\b|\bpreview\b/i;

const IN_PROGRESS_STATUS_RE =
  /\b(agentActive\s*[:=]\s*true|in[_ ]?progress|running|queued|pending|processing)\b/i;

const DONE_TOTAL_RE = /done\s*[/:=]\s*(\d+)\s*(?:of|\/)\s*(\d+)/i;

export type LaunchPadCallKind = 'start' | 'poll' | 'lifecycle' | 'other';

export interface LaunchPadCallRecord {
  /** Normalized base tool name (e.g. start_scope_implement). */
  baseName: string;
  /** Full model-facing name before normalization. */
  rawName: string;
  kind: LaunchPadCallKind;
  args: Record<string, unknown>;
  resultText: string;
  isError: boolean;
  target?: string;
}

export interface LaunchPadTurnProgressSnapshot {
  calls: readonly LaunchPadCallRecord[];
  hasWrongImplementTarget: boolean;
  asyncJobsInProgress: readonly string[];
  needsPreviewAfterImplement: boolean;
  needsSeedAfterLock: boolean;
  lastImplementTerminal: boolean;
  lastLockReady: boolean;
}

/**
 * Strip mcp__server__ prefix and trailing hash suffixes to a base tool name.
 */
export function normalizeLaunchPadToolBaseName(toolName: string): string {
  let name = (toolName || '').trim();
  if (!name) return '';
  const mcpMatch = name.match(/^mcp__.+?__(.+)$/i);
  if (mcpMatch) {
    name = mcpMatch[1];
  }
  name = name.replace(/__?[a-f0-9]{4,8}$/i, '');
  return name.trim().toLowerCase();
}

export function classifyLaunchPadToolKind(baseName: string): LaunchPadCallKind {
  if (LAUNCHPAD_START_TOOLS.has(baseName)) return 'start';
  if (LAUNCHPAD_LIFECYCLE_TOOLS.has(baseName)) return 'lifecycle';
  if (LAUNCHPAD_POLL_TOOLS.has(baseName)) return 'poll';
  if (baseName.startsWith('get_scope_implement')) return 'poll';
  if (baseName.endsWith('_get_session') && baseName.includes('chat')) return 'poll';
  return 'other';
}

export function userExplicitlyAskedForBackend(prompt: string): boolean {
  return EXPLICIT_BACKEND_INTENT_RE.test(prompt || '');
}

export function userAskedForPreviewSurface(prompt: string): boolean {
  return PREVIEW_SURFACE_RE.test(prompt || '');
}

/**
 * True when result text looks like a non-terminal / still-running job status.
 */
export function isNonTerminalJobResult(resultText: string): boolean {
  const text = (resultText || '').trim();
  if (!text) return true;
  if (text.toLowerCase().startsWith('error calling')) return false;

  if (/\bagentActive\s*[:=]\s*true\b/i.test(text)) return true;
  if (/\breadyForNextCycle\s*[:=]\s*true\b/i.test(text)) return false;
  if (/\blocked\s*[:=]\s*true\b/i.test(text) && /\bagentActive\s*[:=]\s*false\b/i.test(text)) {
    return false;
  }

  const doneTotal = text.match(DONE_TOTAL_RE);
  if (doneTotal) {
    const done = Number(doneTotal[1]);
    const total = Number(doneTotal[2]);
    if (Number.isFinite(done) && Number.isFinite(total) && total > 0 && done < total) {
      return true;
    }
    if (Number.isFinite(done) && Number.isFinite(total) && done >= total && total > 0) {
      return false;
    }
  }

  const jsonDone = text.match(/"done"\s*:\s*(\d+)/i);
  const jsonTotal = text.match(/"total"\s*:\s*(\d+)/i);
  if (jsonDone && jsonTotal) {
    const done = Number(jsonDone[1]);
    const total = Number(jsonTotal[1]);
    if (Number.isFinite(done) && Number.isFinite(total) && total > 0 && done < total) {
      return true;
    }
    if (Number.isFinite(done) && Number.isFinite(total) && done >= total && total > 0) {
      return false;
    }
  }

  if (
    /\b(status|state)\s*[:=]\s*["']?(completed|complete|succeeded|success|failed|cancelled|canceled|error)["']?/i.test(
      text
    )
  ) {
    return false;
  }

  if (IN_PROGRESS_STATUS_RE.test(text)) return true;

  if (/\b(completed|complete|succeeded|success|failed|cancelled|canceled)\b/i.test(text)) {
    return false;
  }

  // Ambiguous payload after a start (e.g. only runId) — treat as needing poll
  return false;
}

export function isTerminalJobResult(resultText: string): boolean {
  const text = (resultText || '').trim();
  if (!text || text.toLowerCase().startsWith('error')) return false;
  return !isNonTerminalJobResult(text);
}

/**
 * Whether an MCP tool base name (or nested mcp_call_tool target) should skip
 * frequency loop-guard limits (long-running status polls).
 */
export function isLaunchPadPollToolForLoopGuard(
  toolName: string,
  nestedToolName?: string | null
): boolean {
  const base = normalizeLaunchPadToolBaseName(toolName);
  if (base && classifyLaunchPadToolKind(base) === 'poll') return true;
  if (nestedToolName) {
    const nested = normalizeLaunchPadToolBaseName(nestedToolName);
    if (nested && classifyLaunchPadToolKind(nested) === 'poll') return true;
  }
  return false;
}

function extractTarget(args: Record<string, unknown>): string | undefined {
  const t = args.target ?? args.implementTarget ?? args.executionTarget;
  if (typeof t === 'string' && t.trim()) return t.trim().toLowerCase();
  return undefined;
}

export type OnLaunchPadProgressRecord = (record: {
  toolName: string;
  args?: Record<string, unknown> | null;
  resultText?: string;
  isError?: boolean;
}) => void;

/**
 * Mutable progress tracker for one agent turn.
 */
export class LaunchPadTurnProgress {
  private readonly records: LaunchPadCallRecord[] = [];

  record(input: {
    toolName: string;
    args?: Record<string, unknown> | null;
    resultText?: string;
    isError?: boolean;
  }): void {
    const rawName = (input.toolName || '').trim();
    if (!rawName) return;
    const baseName = normalizeLaunchPadToolBaseName(rawName);
    if (!baseName) return;
    const kind = classifyLaunchPadToolKind(baseName);
    if (kind === 'other') return;

    const args =
      input.args && typeof input.args === 'object' && !Array.isArray(input.args)
        ? (input.args as Record<string, unknown>)
        : {};
    this.records.push({
      baseName,
      rawName,
      kind,
      args,
      resultText: typeof input.resultText === 'string' ? input.resultText : '',
      isError: Boolean(input.isError),
      target: extractTarget(args),
    });
  }

  getCalls(): readonly LaunchPadCallRecord[] {
    return this.records;
  }

  snapshot(userPrompt: string): LaunchPadTurnProgressSnapshot {
    const calls = this.records;
    const explicitBackend = userExplicitlyAskedForBackend(userPrompt);
    const previewAsk = userAskedForPreviewSurface(userPrompt);

    let hasWrongImplementTarget = false;
    if (!explicitBackend) {
      for (const c of calls) {
        if (c.baseName === 'start_scope_implement' && c.target === 'development') {
          hasWrongImplementTarget = true;
        }
        if (c.baseName === 'backend_code_chat_send_message' && previewAsk) {
          hasWrongImplementTarget = true;
        }
        // Development implement when user asked for preview is always wrong.
        if (
          previewAsk &&
          c.baseName === 'start_scope_implement' &&
          (c.target === 'development' || !c.target)
        ) {
          // Missing target is OK (defaults platform). Only flag development.
          if (c.target === 'development') hasWrongImplementTarget = true;
        }
      }
    }

    const starts = calls.filter((c) => c.kind === 'start' && !c.isError);
    const asyncJobsInProgress: string[] = [];
    for (const start of starts) {
      // skipLockAgentOperations lock does not need poll
      if (
        start.baseName === 'lock_release' &&
        (start.args.skipLockAgentOperations === true ||
          start.args.skipLockAgentOperations === 'true')
      ) {
        continue;
      }
      // Wrong-target starts shouldn't block wait path; wrong_implement_target handles them.
      if (
        start.baseName === 'start_scope_implement' &&
        start.target === 'development' &&
        !explicitBackend
      ) {
        continue;
      }
      if (start.baseName === 'backend_code_chat_send_message' && previewAsk && !explicitBackend) {
        continue;
      }

      const pollNames = pollCandidatesForStart(start.baseName);
      const polls = calls.filter(
        (c) => c.kind === 'poll' && pollNames.has(c.baseName) && !c.isError
      );
      if (polls.length === 0) {
        asyncJobsInProgress.push(start.baseName);
        continue;
      }
      const lastPoll = polls[polls.length - 1];
      if (isNonTerminalJobResult(lastPoll.resultText)) {
        asyncJobsInProgress.push(start.baseName);
      }
    }

    const implementStarts = starts.filter((c) => c.baseName === 'start_scope_implement');
    const implementPolls = calls.filter(
      (c) => c.kind === 'poll' && c.baseName.startsWith('get_scope_implement') && !c.isError
    );
    const lastImplementTerminal =
      implementStarts.length > 0 &&
      implementPolls.length > 0 &&
      isTerminalJobResult(implementPolls[implementPolls.length - 1].resultText) &&
      !asyncJobsInProgress.includes('start_scope_implement');

    const previewStarted = starts.some((c) => c.baseName === 'start_preview');
    const platformImplement =
      implementStarts.some((c) => !c.target || c.target === 'platform') ||
      (implementStarts.length > 0 && !implementStarts.every((c) => c.target === 'development'));

    const needsPreviewAfterImplement =
      previewAsk && lastImplementTerminal && !previewStarted && platformImplement;

    const lockStarts = starts.filter((c) => c.baseName === 'lock_release');
    const lockPolls = calls.filter(
      (c) => c.kind === 'poll' && c.baseName === 'get_release_lock_status' && !c.isError
    );
    const skipAgentLocks = lockStarts.every(
      (c) => c.args.skipLockAgentOperations === true || c.args.skipLockAgentOperations === 'true'
    );
    const lastLockReady =
      lockStarts.length > 0 &&
      (skipAgentLocks ||
        (lockPolls.length > 0 &&
          isTerminalJobResult(lockPolls[lockPolls.length - 1].resultText) &&
          !asyncJobsInProgress.includes('lock_release')));

    const seedCalled = calls.some((c) => c.baseName === 'seed_release_from_prior');
    const needsSeedAfterLock = lastLockReady && shipOrLockIntent(userPrompt) && !seedCalled;

    return {
      calls,
      hasWrongImplementTarget,
      asyncJobsInProgress,
      needsPreviewAfterImplement,
      needsSeedAfterLock,
      lastImplementTerminal,
      lastLockReady,
    };
  }
}

function pollCandidatesForStart(startBase: string): Set<string> {
  const preferred = START_TO_POLL[startBase];
  const set = new Set<string>();
  if (preferred) set.add(preferred);
  if (startBase === 'start_scope_implement') {
    set.add('get_scope_implement_active');
    set.add('get_scope_implement_run');
  }
  if (startBase === 'start_backend_cloud_deploy') {
    set.add('get_backend_cloud_deploy_latest');
    set.add('get_backend_cloud_deploy_run');
  }
  if (startBase === 'spawn_dev_agent' || startBase === 'create_cursor_agent') {
    set.add('get_agent_status');
    set.add('get_cursor_agent');
  }
  return set;
}

function shipOrLockIntent(prompt: string): boolean {
  return /\b(ship|lock\s+the\s+release|lock_release|end\s+of\s+cycle|next\s+cycle)\b/i.test(
    prompt || ''
  );
}
