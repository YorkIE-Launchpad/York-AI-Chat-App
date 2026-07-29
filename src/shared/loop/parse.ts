import {
  DEFAULT_GOAL_MAX_ITERATIONS,
  MIN_LOOP_INTERVAL_MS,
  type LoopInterval,
  type LoopIntervalUnit,
  type ParsedLoopCommand,
} from './types';

const UNIT_MS: Record<LoopIntervalUnit, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

const SHORT_INTERVAL_RE =
  /^(\d+)\s*(s|m|h|d|sec|secs|second|seconds|min|mins|minute|minutes|hr|hrs|hour|hours|day|days)\b/i;
const EVERY_INTERVAL_RE =
  /\bevery\s+(\d+)\s*(s|m|h|d|sec|secs|second|seconds|min|mins|minute|minutes|hr|hrs|hour|hours|day|days)\b/i;

function normalizeUnit(raw: string): LoopIntervalUnit {
  const u = raw.toLowerCase();
  if (u === 's' || u.startsWith('sec')) return 's';
  if (u === 'm' || u.startsWith('min')) return 'm';
  if (u === 'h' || u.startsWith('hr') || u.startsWith('hour')) return 'h';
  return 'd';
}

export function intervalToMs(value: number, unit: LoopIntervalUnit): number {
  const raw = value * UNIT_MS[unit];
  return Math.max(MIN_LOOP_INTERVAL_MS, raw);
}

export function parseIntervalToken(token: string): LoopInterval | null {
  const trimmed = token.trim();
  const match = SHORT_INTERVAL_RE.exec(trimmed);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  const unit = normalizeUnit(match[2]);
  return { value, unit, ms: intervalToMs(value, unit) };
}

export function formatInterval(interval: LoopInterval): string {
  return `${interval.value}${interval.unit}`;
}

export function msToLoopInterval(ms: number): LoopInterval {
  const clamped = Math.max(MIN_LOOP_INTERVAL_MS, ms);
  if (clamped % UNIT_MS.d === 0) {
    return { value: clamped / UNIT_MS.d, unit: 'd', ms: clamped };
  }
  if (clamped % UNIT_MS.h === 0) {
    return { value: clamped / UNIT_MS.h, unit: 'h', ms: clamped };
  }
  if (clamped % UNIT_MS.m === 0) {
    return { value: clamped / UNIT_MS.m, unit: 'm', ms: clamped };
  }
  return { value: Math.max(1, Math.round(clamped / UNIT_MS.s)), unit: 's', ms: clamped };
}

function stripEveryClause(text: string): { rest: string; interval: LoopInterval | null } {
  const match = EVERY_INTERVAL_RE.exec(text);
  if (!match) return { rest: text.trim(), interval: null };
  const value = Number(match[1]);
  const unit = normalizeUnit(match[2]);
  const interval = { value, unit, ms: intervalToMs(value, unit) };
  const rest = `${text.slice(0, match.index)} ${text.slice(match.index + match[0].length)}`.trim();
  return { rest, interval };
}

/**
 * Parse a chat slash command for loops.
 * Interval is required — e.g. `/loop 5m check deploy` or `/goal 2m make tests pass`.
 */
export function parseLoopCommand(raw: string): ParsedLoopCommand {
  const trimmed = raw.trim();
  if (!trimmed) return { type: 'usage' };

  const withoutSlash = trimmed.startsWith('/') ? trimmed.slice(1).trim() : trimmed;
  const lower = withoutSlash.toLowerCase();

  if (
    lower === 'loop stop' ||
    lower === 'goal stop' ||
    lower === 'stop' ||
    lower.startsWith('loop stop ') ||
    lower.startsWith('goal stop ')
  ) {
    return { type: 'stop' };
  }

  let command: 'loop' | 'goal' | null = null;
  let body = withoutSlash;

  if (lower === 'loop' || lower.startsWith('loop ')) {
    command = 'loop';
    body = withoutSlash.slice(4).trim();
  } else if (lower === 'goal' || lower.startsWith('goal ')) {
    command = 'goal';
    body = withoutSlash.slice(4).trim();
  } else if (lower.startsWith('loop:')) {
    command = 'loop';
    body = withoutSlash.slice(5).trim();
  } else if (lower.startsWith('goal:')) {
    command = 'goal';
    body = withoutSlash.slice(5).trim();
  }

  if (command === 'loop' && (!body || body.toLowerCase() === 'stop')) {
    if (body.toLowerCase() === 'stop') return { type: 'stop' };
    return { type: 'usage' };
  }

  if (command === 'goal' && (!body || body.toLowerCase() === 'stop')) {
    if (body.toLowerCase() === 'stop') return { type: 'stop' };
    return { type: 'usage' };
  }

  // If no command prefix, treat as loop body (caller already stripped /loop).
  if (!command) {
    command = 'loop';
    body = withoutSlash;
  }

  const every = stripEveryClause(body);
  let promptOrGoal = every.rest;
  let interval = every.interval;

  if (!interval) {
    const leading = SHORT_INTERVAL_RE.exec(promptOrGoal);
    if (leading && leading.index === 0) {
      interval = parseIntervalToken(leading[0]);
      promptOrGoal = promptOrGoal.slice(leading[0].length).trim();
    }
  }

  if (!interval || !promptOrGoal) {
    return { type: 'usage' };
  }

  if (command === 'goal') {
    return {
      type: 'goal',
      kind: 'goal',
      goal: promptOrGoal,
      interval,
      maxIterations: DEFAULT_GOAL_MAX_ITERATIONS,
    };
  }

  return {
    type: 'loop',
    kind: 'interval',
    prompt: promptOrGoal,
    interval,
  };
}

export function isLoopSlashInput(value: string): boolean {
  const t = value.trim();
  return /^\/(?:loop|goal)(?:\s|:|$)/i.test(t);
}
