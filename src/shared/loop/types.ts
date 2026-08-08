/**
 * Shared types for chat loops, scheduled loops, and WatchTask reactive polling.
 */

export type ChatLoopKind = 'interval' | 'goal';

export type ScheduleTaskKind = 'schedule' | 'loop' | 'watch';

export type ScheduleSessionMode = 'new' | 'continue';

export type LoopIntervalUnit = 's' | 'm' | 'h' | 'd';

export interface LoopInterval {
  value: number;
  unit: LoopIntervalUnit;
  /** Duration in milliseconds (clamped to MIN_LOOP_INTERVAL_MS). */
  ms: number;
}

/** Minimum interval for any automated loop/schedule fire. */
export const MIN_LOOP_INTERVAL_MS = 30_000;

/** Default tick interval when a goal is started without an explicit interval. */
export const DEFAULT_GOAL_INTERVAL_MS = 2 * 60_000;

/** Max goal iterations before auto-stop. */
export const DEFAULT_GOAL_MAX_ITERATIONS = 20;

export type WatchCheckType = 'http' | 'command' | 'file' | 'agent';

export type WatchCompareMode = 'hash' | 'status' | 'jsonpath' | 'regex';

export interface HttpWatchCheckConfig {
  url: string;
  /** Optional JSONPath-like simple selector (dot path) into JSON body. */
  bodySelector?: string;
}

export interface CommandWatchCheckConfig {
  command: string;
}

export interface FileWatchCheckConfig {
  path: string;
}

export interface AgentWatchCheckConfig {
  checkPrompt: string;
}

export type WatchCheckConfig =
  | HttpWatchCheckConfig
  | CommandWatchCheckConfig
  | FileWatchCheckConfig
  | AgentWatchCheckConfig;

export interface WatchConfig {
  checkType: WatchCheckType;
  checkConfig: WatchCheckConfig;
  compareMode: WatchCompareMode;
  lastState?: string;
  lastCheckedAt?: number;
  consecutiveUnchanged?: number;
}

export type ParsedLoopCommand =
  | { type: 'stop' }
  | { type: 'usage' }
  | {
      type: 'loop';
      kind: 'interval';
      prompt: string;
      interval: LoopInterval;
    }
  | {
      type: 'goal';
      kind: 'goal';
      goal: string;
      interval: LoopInterval;
      maxIterations: number;
    };

export const GOAL_STATUS_COMPLETE = 'GOAL_STATUS: complete';
export const GOAL_STATUS_IN_PROGRESS = 'GOAL_STATUS: in_progress';

export function buildGoalTickPrompt(goal: string): string {
  return [
    'Continue working toward this goal until it is fully done (use the goal-runner skill when available):',
    goal,
    '',
    'On this tick:',
    '1. Auto-detect (or keep) the goal type — e.g. fix, tests-ci, implement, refactor, research, ops-status, content-docs, verify, launchpad, or multi. If a prior reply has a RESUME: line, resume that job first (poll status tools before starting new work).',
    '2. Load the domain skill when relevant (LaunchPad release/migrate/preview/fidelity → rnd-launchpad-mcp-sdlc) and take the highest-leverage next step using tools; prefer concrete progress over plans.',
    '3. After any start tool (implement, migrate, lock, preview, AI fix, CI, agent): keep this turn alive and poll status until terminal; then run the next SDLC step in the same tick. Do not park solely because a job "started" or wait for the next goal interval instead of polling.',
    '4. If you must exit mid long-running job (hours-scale or poll budget), include one durable line: RESUME: projectId=… releaseId=… conversionId=… agentId=… step=… next=<status_tool>. Agent-not-found is not terminal — use list_versions / implement / preview status alternates.',
    '5. Only report complete when success criteria are met with evidence (re-run failed checks when relevant).',
    '',
    'When the goal is fully achieved, end your reply with a line containing exactly:',
    GOAL_STATUS_COMPLETE,
    'Otherwise end with:',
    GOAL_STATUS_IN_PROGRESS,
  ].join('\n');
}

export function isGoalCompleteInText(text: string): boolean {
  return /GOAL_STATUS:\s*complete\b/i.test(text);
}
