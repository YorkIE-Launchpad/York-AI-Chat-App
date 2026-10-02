/**
 * Shared Loops types — persistent, user-owned commitments ("open loops").
 *
 * Matter signals are re-ranked every scan and can expire; a loop stays until
 * the user closes or drops it.
 */

export type LoopStatus = 'open' | 'done' | 'dropped';
export type LoopOrigin = 'meeting' | 'matter' | 'manual' | 'chat';
export type LoopOwner = 'me' | 'other';
export type LoopPriority = 'high' | 'normal' | 'low';

export interface LoopSourceRef {
  meetingId?: string | null;
  matterItemId?: string | null;
  url?: string | null;
  label?: string | null;
}

export type LoopResearchStatus = 'idle' | 'running' | 'done' | 'error';

export interface LoopResearchSource {
  /** Citation id used inside the note, e.g. `E2`. */
  id: string;
  source: string;
  title: string;
  url: string | null;
}

export interface Loop {
  id: string;
  /** Dedupe key. Meeting/Matter captures reuse the Matter fingerprint. */
  fingerprint: string;
  title: string;
  notes: string | null;
  /** Markdown note synthesized from connector search, with `[E1]` citations. */
  researchNote: string | null;
  researchSources: LoopResearchSource[];
  researchStatus: LoopResearchStatus;
  researchError: string | null;
  researchedAt: number | null;
  origin: LoopOrigin;
  sourceRef: LoopSourceRef;
  /** `other` = I'm waiting on someone. */
  owner: LoopOwner;
  counterpart: string | null;
  dueAt: number | null;
  priority: LoopPriority;
  status: LoopStatus;
  autoCaptured: boolean;
  createdAt: number;
  updatedAt: number;
  closedAt: number | null;
}

export interface LoopCreateInput {
  title: string;
  notes?: string | null;
  /** Sweep sources for related content after creating. Defaults to true. */
  research?: boolean;
  owner?: LoopOwner;
  counterpart?: string | null;
  dueAt?: number | null;
  priority?: LoopPriority;
}

export type LoopUpdateInput = Partial<
  Pick<Loop, 'title' | 'notes' | 'owner' | 'counterpart' | 'dueAt' | 'priority' | 'status'>
>;

export const LOOP_CAPTURE_PROMPT_MAX_CHARS = 2000;

export interface LoopsRuntimeConfig {
  captureFromMeetings: boolean;
  captureFromMatter: boolean;
  /** Minimum Matter ranker confidence (0–1) to auto-capture a signal as a loop. */
  matterConfidenceThreshold: number;
  /** Capture-rules version already applied to existing auto-captured loops. */
  screenedVersion: number;
  /**
   * Optional employee override for what becomes a loop.
   * Empty means the built-in Jev / screen rules apply alone.
   */
  capturePrompt: string;
}

/** Bump when capture rules tighten so untouched auto-captured loops are re-screened once. */
export const LOOPS_SCREEN_VERSION = 2;

export const DEFAULT_LOOPS_RUNTIME: LoopsRuntimeConfig = {
  captureFromMeetings: true,
  captureFromMatter: true,
  matterConfidenceThreshold: 0.7,
  screenedVersion: 0,
  capturePrompt: '',
};

export function normalizeLoopsRuntimeConfig(raw: unknown): LoopsRuntimeConfig {
  const value = typeof raw === 'object' && raw !== null ? (raw as Partial<LoopsRuntimeConfig>) : {};
  const threshold =
    typeof value.matterConfidenceThreshold === 'number' &&
    Number.isFinite(value.matterConfidenceThreshold)
      ? Math.max(0, Math.min(1, value.matterConfidenceThreshold))
      : DEFAULT_LOOPS_RUNTIME.matterConfidenceThreshold;
  return {
    captureFromMeetings: value.captureFromMeetings !== false,
    captureFromMatter: value.captureFromMatter !== false,
    matterConfidenceThreshold: threshold,
    screenedVersion:
      typeof value.screenedVersion === 'number' && Number.isFinite(value.screenedVersion)
        ? value.screenedVersion
        : 0,
    capturePrompt:
      typeof value.capturePrompt === 'string'
        ? value.capturePrompt.trim().slice(0, LOOP_CAPTURE_PROMPT_MAX_CHARS)
        : '',
  };
}

export interface LoopsSnapshot {
  loops: Loop[];
  /** Open loops I own that are overdue or due today. */
  dueCount: number;
  settings: LoopsRuntimeConfig;
}

export type LoopDueBucket = 'overdue' | 'today' | 'week' | 'later';

function endOfDay(now: number): number {
  const d = new Date(now);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

function startOfDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function loopDueBucket(dueAt: number | null, now = Date.now()): LoopDueBucket {
  if (dueAt == null) return 'later';
  if (dueAt < startOfDay(now)) return 'overdue';
  if (dueAt <= endOfDay(now)) return 'today';
  if (dueAt <= endOfDay(now + 6 * 24 * 60 * 60 * 1000)) return 'week';
  return 'later';
}

export function isLoopDue(loop: Loop, now = Date.now()): boolean {
  if (loop.status !== 'open' || loop.owner !== 'me') return false;
  const bucket = loopDueBucket(loop.dueAt, now);
  return bucket === 'overdue' || bucket === 'today';
}

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/**
 * Pull a trailing due hint off quick-add text: "send deck fri", "call Raj tomorrow",
 * "review PR today", "ship notes by 12/10". Due dates resolve to 17:00 local.
 */
export function parseLoopQuickAdd(
  input: string,
  now = Date.now()
): { title: string; dueAt: number | null } {
  const text = input.trim().replace(/\s+/g, ' ');
  const atFive = (d: Date) => {
    d.setHours(17, 0, 0, 0);
    return d.getTime();
  };

  const relative = text.match(/\s+(?:by\s+|due\s+)?(today|tonight|tomorrow|tmrw|eow|next week)$/i);
  if (relative) {
    const word = relative[1].toLowerCase();
    const d = new Date(now);
    if (word === 'tomorrow' || word === 'tmrw') d.setDate(d.getDate() + 1);
    else if (word === 'eow') d.setDate(d.getDate() + ((5 - d.getDay() + 7) % 7));
    else if (word === 'next week') d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7));
    return { title: text.slice(0, relative.index).trim(), dueAt: atFive(d) };
  }

  const weekday = text.match(
    /\s+(?:by\s+|due\s+|on\s+)?(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(?:day|nesday|sday|urday)?$/i
  );
  if (weekday) {
    const target = WEEKDAYS.indexOf(weekday[1].toLowerCase().slice(0, 3));
    const d = new Date(now);
    const delta = (target - d.getDay() + 7) % 7 || 7;
    d.setDate(d.getDate() + delta);
    return { title: text.slice(0, weekday.index).trim(), dueAt: atFive(d) };
  }

  const numeric = text.match(/\s+(?:by\s+|due\s+|on\s+)?(\d{1,2})\/(\d{1,2})$/);
  if (numeric) {
    const month = Number(numeric[1]) - 1;
    const day = Number(numeric[2]);
    const d = new Date(now);
    d.setMonth(month, day);
    if (month >= 0 && month < 12 && day >= 1 && day <= 31) {
      if (d.getTime() < startOfDay(now)) d.setFullYear(d.getFullYear() + 1);
      return { title: text.slice(0, numeric.index).trim(), dueAt: atFive(d) };
    }
  }

  return { title: text, dueAt: null };
}
