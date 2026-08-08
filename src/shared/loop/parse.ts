import {
  DEFAULT_GOAL_INTERVAL_MS,
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
/** Leading option: `max 50`, `max:50`, `max=50`. */
const LEADING_MAX_TICKS_RE = /^max\s*[:=]?\s*(\d+)\b/i;
/** Explicit option anywhere: `max:50` or `max=50` (colon/equals avoids eating goal prose). */
const EXPLICIT_MAX_TICKS_RE = /\bmax\s*[:=]\s*(\d+)\b/i;

/** Clamp a user-provided goal max-ticks value; invalid → default. */
export function normalizeGoalMaxIterations(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_GOAL_MAX_ITERATIONS;
  return Math.min(Math.floor(n), 10_000);
}

function stripMaxIterationsClause(text: string): {
  rest: string;
  maxIterations: number | null;
} {
  const trimmed = text.trim();
  if (!trimmed) return { rest: '', maxIterations: null };

  const leading = LEADING_MAX_TICKS_RE.exec(trimmed);
  if (leading) {
    const n = Number(leading[1]);
    if (Number.isFinite(n) && n >= 1) {
      return {
        rest: trimmed.slice(leading[0].length).trim(),
        maxIterations: normalizeGoalMaxIterations(n),
      };
    }
  }

  const explicit = EXPLICIT_MAX_TICKS_RE.exec(trimmed);
  if (explicit) {
    const n = Number(explicit[1]);
    if (Number.isFinite(n) && n >= 1) {
      const rest =
        `${trimmed.slice(0, explicit.index)} ${trimmed.slice(explicit.index + explicit[0].length)}`.trim();
      return { rest, maxIterations: normalizeGoalMaxIterations(n) };
    }
  }

  return { rest: trimmed, maxIterations: null };
}

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
 * Loop interval is required — e.g. `/loop 5m check deploy`.
 * Goal interval is optional and defaults to 2m — e.g. `/goal make tests pass` or `/goal 5m make tests pass`.
 * Goal max ticks optional (default 20) — e.g. `/goal max 50 …`, `/goal 5m max 50 …`, or `max:50` anywhere.
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

  if (!promptOrGoal) {
    return { type: 'usage' };
  }

  if (command === 'goal') {
    // Options: `/goal [interval] [max N] <goal>`, `/goal max N [interval] <goal>`, or `max:N` anywhere.
    let { rest: goalText, maxIterations } = stripMaxIterationsClause(promptOrGoal);
    if (!interval) {
      const leadingAfterMax = SHORT_INTERVAL_RE.exec(goalText);
      if (leadingAfterMax && leadingAfterMax.index === 0) {
        interval = parseIntervalToken(leadingAfterMax[0]);
        goalText = goalText.slice(leadingAfterMax[0].length).trim();
      }
    }
    if (maxIterations === null) {
      const again = stripMaxIterationsClause(goalText);
      goalText = again.rest;
      maxIterations = again.maxIterations;
    }

    if (!goalText) {
      return { type: 'usage' };
    }

    return {
      type: 'goal',
      kind: 'goal',
      goal: goalText,
      interval: interval ?? msToLoopInterval(DEFAULT_GOAL_INTERVAL_MS),
      maxIterations: maxIterations ?? DEFAULT_GOAL_MAX_ITERATIONS,
    };
  }

  if (!interval) {
    return { type: 'usage' };
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
