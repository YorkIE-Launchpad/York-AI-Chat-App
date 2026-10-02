/**
 * Loop extraction — turns meeting action items and Matter signals into loop candidates.
 *
 * Capture is deliberately strict: a loop must be a concrete, checkable commitment that
 * involves the user. Vague intentions ("clarify…", "ensure…", "align with…") are dropped.
 */
import { MemoryLLMClient, type MemoryLLMClientLike } from '../memory/memory-llm-client';
import type { MeetingSession } from '../meetings/meeting-types';
import type { MatterItem } from '../../shared/matter';
import type { LoopOwner, LoopsRuntimeConfig } from '../../shared/loops';
import type { WelcomeProfile } from '../../shared/welcome-actions';
import { meetingActionFingerprint } from '../matter/matter-collector';
import { collapseSameAskItems, omitSameAskAs } from '../matter/matter-same-ask';
import { runLoopActionJev } from '../jev/loops-jev';
import { logWarn } from '../utils/logger';
import type { LoopUpsertInput } from './loop-store';

/** Most loops a single meeting may auto-capture. */
export const MAX_LOOPS_PER_MEETING = 5;
const MIN_ACTION_WORDS = 3;

/** Leading verbs that signal an intention or process note rather than a deliverable. */
const VAGUE_LEADS = [
  'clarify',
  'ensure',
  'align',
  'discuss',
  'consider',
  'think',
  'explore',
  'understand',
  'figure out',
  'look into',
  'keep',
  'continue',
  'monitor',
  'be mindful',
  'make sure',
  'try to',
  'revisit',
  'reflect',
  'brainstorm',
  'decide whether',
  'determine',
  'identify',
  'evaluate',
  'assess',
];

/** Deictic references that only make sense inside the transcript ("which issue", "the tasks mentioned"). */
const CONTEXT_DEPENDENT =
  /\b(which|what)\s+(issue|task|item|thing|problem|one)s?\b|\b(mentioned|discussed|raised|offered)\s+(during|in)\s+the\s+(meeting|call)\b|\bwhat\s+is\s+scheduled\b/i;

export type ActionRejectReason = 'too_short' | 'vague_lead' | 'context_dependent';

/** Cheap deterministic screen applied before (and independent of) the LLM judge. */
export function prescreenAction(text: string): ActionRejectReason | null {
  const normalized = text
    .trim()
    .replace(/^[-*•\d.)\s]+/, '')
    .toLowerCase();
  if (normalized.split(/\s+/).filter(Boolean).length < MIN_ACTION_WORDS) return 'too_short';
  if (VAGUE_LEADS.some((lead) => normalized === lead || normalized.startsWith(`${lead} `))) {
    return 'vague_lead';
  }
  if (CONTEXT_DEPENDENT.test(normalized)) return 'context_dependent';
  return null;
}

export interface ActionScreen {
  keep: boolean;
  owner: LoopOwner;
  counterpart: string | null;
  dueAt: number | null;
}

export interface MeetingContext {
  title: string;
  startedAt: number;
  attendees?: unknown[];
  summary?: string | null;
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
    return null;
  }
}

function parseDue(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * One LLM call judges every action item: is it a concrete commitment worth tracking,
 * is it mine or owed to me, who is the counterpart, and is there an explicit deadline.
 * Returns null when the judge fails, so callers can decide how to err.
 */
const SCREEN_PROMPT = [
  "You screen meeting action items for ONE user's personal to-do list. Be strict: most items should be rejected.",
  'keep=true ONLY when ALL hold:',
  '(1) it is a concrete deliverable someone can finish and tick off — a specific verb plus a specific object (e.g. "Send the Q4 pricing sheet to Priya", "Grant Git access to Prateek Gwala", "Fix the login redirect bug");',
  '(2) it makes sense on its own, without reading the transcript (no "which issue", "the tasks mentioned", "what is scheduled");',
  '(3) the user must do it, or a named person explicitly owes it to the user.',
  'Reject: intentions and process reminders (clarify, ensure, align, discuss, confirm what…, review in general, follow the process),',
  'items about other people with no action for the user, restated meeting topics, and anything whose meaning is uncertain because the transcript is garbled.',
  'owner: "me" if the user must do it, "other" if a named person owes it to the user.',
  'counterpart: the other named person, or null.',
  'due: ISO 8601 only if the item states an explicit deadline, resolved against the meeting date; else null.',
  'Return ONLY JSON: {"items":[{"index":0,"keep":false,"owner":"me","counterpart":null,"due":null}]}.',
].join(' ');

const FIELDS_PROMPT = [
  "These meeting action items were already accepted for ONE user's to-do list. For each, extract:",
  'owner: "me" if the user must do it, "other" if a named person owes it to the user;',
  'counterpart: the other named person, or null;',
  'due: ISO 8601 only if the item states an explicit deadline, resolved against the meeting date; else null.',
  'Return ONLY JSON: {"items":[{"index":0,"owner":"me","counterpart":null,"due":null}]}.',
].join(' ');

export async function screenMeetingActions(
  meeting: MeetingContext,
  actions: string[],
  profile: WelcomeProfile | null,
  llm: MemoryLLMClientLike = new MemoryLLMClient(),
  options: { fieldsOnly?: boolean; capturePrompt?: string | null } = {}
): Promise<ActionScreen[] | null> {
  const fieldsOnly = options.fieldsOnly === true;
  const rejected = actions.map<ActionScreen>(() => ({
    keep: fieldsOnly,
    owner: 'me',
    counterpart: null,
    dueAt: null,
  }));
  if (actions.length === 0) return rejected;
  try {
    const response = await llm.complete({
      systemPrompt: withCaptureOverride(
        fieldsOnly ? FIELDS_PROMPT : SCREEN_PROMPT,
        options.capturePrompt
      ),
      userPrompt: JSON.stringify({
        user: profile ? { name: profile.name, email: profile.email } : null,
        meetingTitle: meeting.title,
        meetingDate: new Date(meeting.startedAt).toISOString(),
        attendees: meeting.attendees || [],
        items: actions.map((text, index) => ({ index, text })),
      }),
      temperature: 0,
    });
    const parsed = extractJsonObject(response.text);
    if (!parsed) {
      logWarn('[Loops] Action screen returned no JSON');
      return null;
    }
    const items = Array.isArray(parsed.items) ? parsed.items : [];
    const out = [...rejected];
    for (const raw of items) {
      if (!raw || typeof raw !== 'object') continue;
      const item = raw as Record<string, unknown>;
      const index = typeof item.index === 'number' ? item.index : -1;
      if (index < 0 || index >= out.length) continue;
      out[index] = {
        keep: fieldsOnly || item.keep === true,
        owner: item.owner === 'other' ? 'other' : 'me',
        counterpart:
          typeof item.counterpart === 'string' && item.counterpart.trim()
            ? item.counterpart.trim()
            : null,
        dueAt: parseDue(item.due),
      };
    }
    return out;
  } catch (error) {
    logWarn('[Loops] Action screen failed', error);
    return null;
  }
}

export interface LoopJudgeDeps {
  llm?: MemoryLLMClientLike;
  jev?: typeof runLoopActionJev;
  /** Optional settings prompt. Empty leaves the built-in rules unchanged. */
  capturePrompt?: string | null;
}

function withCaptureOverride(prompt: string, capturePrompt?: string | null): string {
  const extra = capturePrompt?.trim();
  if (!extra) return prompt;
  return `${prompt} Employee override (apply on top of these rules; still reject vague items): ${extra}`;
}

/**
 * Jev decides keep/owner (specific output, standalone context, involves the user); the
 * LLM only extracts counterpart + due for survivors. Without Jev the strict LLM screen
 * decides everything. Returns null when neither could judge.
 */
export async function judgeMeetingActions(
  meeting: MeetingContext,
  actions: string[],
  profile: WelcomeProfile | null,
  deps: LoopJudgeDeps = {}
): Promise<ActionScreen[] | null> {
  if (actions.length === 0) return [];
  const decisions = await (deps.jev ?? runLoopActionJev)({
    source: {
      kind: 'meeting',
      title: meeting.title,
      date: new Date(meeting.startedAt).toISOString(),
      summary: meeting.summary ?? null,
      attendees: meeting.attendees,
    },
    candidates: actions.map((text) => ({ text })),
    profile,
    capturePrompt: deps.capturePrompt,
  });
  if (!decisions) {
    return screenMeetingActions(meeting, actions, profile, deps.llm, {
      capturePrompt: deps.capturePrompt,
    });
  }

  const out = decisions.map<ActionScreen>((d) => ({
    keep: false,
    owner: d.owner,
    counterpart: null,
    dueAt: null,
  }));
  const kept = decisions.flatMap((d, i) => (d.keep ? [i] : []));
  if (kept.length === 0) return out;
  const fields = await screenMeetingActions(
    meeting,
    kept.map((i) => actions[i]),
    profile,
    deps.llm,
    { fieldsOnly: true, capturePrompt: deps.capturePrompt }
  );
  kept.forEach((i, k) => {
    out[i] = {
      keep: true,
      owner: decisions[i].owner,
      counterpart: fields?.[k]?.counterpart ?? null,
      dueAt: fields?.[k]?.dueAt ?? null,
    };
  });
  return out;
}

/**
 * Collapse paraphrases of one commitment, then drop any that match a loop we already have.
 * First occurrence wins inside the batch.
 */
export function omitDuplicateLoopCandidates<T extends { title: string; notes?: string | null }>(
  candidates: T[],
  existing: Array<{ title: string; notes?: string | null }> = []
): T[] {
  const wrapped = candidates.map((candidate, index) => ({
    candidate,
    fingerprint: `loop-candidate:${index}`,
    title: candidate.title,
    summary: candidate.notes || '',
    source: 'meeting',
    rankScore: candidates.length - index,
  }));
  const collapsed = collapseSameAskItems(wrapped);
  return omitSameAskAs(
    collapsed,
    existing.map((item) => ({ title: item.title, summary: item.notes || '' }))
  ).map((item) => item.candidate);
}

export async function extractMeetingLoops(
  meeting: MeetingSession,
  profile: WelcomeProfile | null,
  deps: LoopJudgeDeps = {}
): Promise<LoopUpsertInput[]> {
  const actions = omitDuplicateLoopCandidates(
    (meeting.notes?.actionItems || [])
      .map((a) => String(a).trim())
      .filter((text) => text && !prescreenAction(text))
      .map((title) => ({ title, notes: null }))
  ).map((item) => item.title);
  if (actions.length === 0) return [];
  const screened = await judgeMeetingActions(
    { ...meeting, summary: meeting.notes?.summary ?? null },
    actions,
    profile,
    deps
  );
  // Err toward silence: an unscreened action item is not captured.
  if (!screened) return [];
  return actions
    .map((text, i) => ({ text, screen: screened[i] }))
    .filter(({ screen }) => screen.keep)
    .slice(0, MAX_LOOPS_PER_MEETING)
    .map(({ text, screen }) => ({
      fingerprint: meetingActionFingerprint(meeting.id, text),
      title: text,
      notes: null,
      origin: 'meeting' as const,
      sourceRef: { meetingId: meeting.id, label: meeting.title || 'Meeting' },
      owner: screen.owner,
      counterpart: screen.counterpart,
      dueAt: screen.dueAt,
      autoCaptured: true,
    }));
}

/**
 * Matter falls back to the signal's timestamp when there is no real deadline, so a
 * past `dueAt` is indistinguishable from "when it happened" — only trust future ones.
 */
export function matterDeadline(item: MatterItem, now = Date.now()): number | null {
  return item.dueAt != null && item.dueAt > now ? item.dueAt : null;
}

/** Matter's placeholder advice on meeting signals — not a real next step. */
const GENERIC_SUGGESTION = /^(complete|review|handle|address),?\s+(delegate|or)\b/i;

export function matterItemToLoop(item: MatterItem, autoCaptured: boolean): LoopUpsertInput {
  const meetingId = item.source === 'meeting' ? item.sourceRef.externalId || null : null;
  const suggestion = item.suggestedAction?.trim();
  return {
    fingerprint: item.fingerprint,
    title: item.title,
    notes:
      (suggestion && !GENERIC_SUGGESTION.test(suggestion) ? suggestion : null) ||
      item.summary ||
      null,
    origin: item.source === 'meeting' ? 'meeting' : 'matter',
    sourceRef: {
      matterItemId: item.id,
      meetingId,
      url: item.sourceRef.url || null,
      label: item.sourceRef.label || null,
    },
    owner: 'me',
    dueAt: matterDeadline(item),
    priority: item.severity === 'critical' ? 'high' : 'normal',
    autoCaptured,
  };
}

/**
 * Jev gate for Matter candidates that already passed `selectMatterLoopCandidates`.
 * Without Jev, the strict LLM screen decides. If neither can judge, capture nothing —
 * a non-empty signal is not automatically a loop.
 */
export async function judgeMatterCandidates(
  items: MatterItem[],
  profile: WelcomeProfile | null,
  deps: LoopJudgeDeps = {}
): Promise<MatterItem[]> {
  if (items.length === 0) return [];
  const decisions = await (deps.jev ?? runLoopActionJev)({
    source: { kind: 'matter', title: 'Matter scan', date: new Date().toISOString() },
    candidates: items.map((item) => ({
      text: item.title,
      detail: [item.suggestedAction, item.summary].filter(Boolean).join(' — '),
    })),
    profile,
    capturePrompt: deps.capturePrompt,
  });
  const kept = !decisions
    ? await screenMatterWithLlm(items, profile, deps)
    : items.filter((_, i) => decisions[i]?.keep);
  return omitDuplicateLoopCandidates(
    kept.map((item) => ({ title: item.title, notes: item.summary, item }))
  ).map((entry) => entry.item);
}

async function screenMatterWithLlm(
  items: MatterItem[],
  profile: WelcomeProfile | null,
  deps: LoopJudgeDeps
): Promise<MatterItem[]> {
  const screened = await screenMeetingActions(
    { title: 'Matter scan', startedAt: Date.now() },
    items.map((item) =>
      [item.title, item.suggestedAction, item.summary].filter(Boolean).join(' — ')
    ),
    profile,
    deps.llm,
    { capturePrompt: deps.capturePrompt }
  );
  if (!screened) return [];
  return items.filter((_, i) => screened[i]?.keep);
}

/**
 * Matter items worth auto-tracking as loops after a scan. Meeting-sourced signals are
 * skipped: meeting capture screens those same action items (same fingerprint) directly.
 */
export function selectMatterLoopCandidates(
  items: MatterItem[],
  runtime: LoopsRuntimeConfig
): MatterItem[] {
  return items.filter((item) => {
    if (item.status !== 'active' && item.status !== 'resurfaced') return false;
    if (item.source === 'meeting') return false;
    if (item.severity === 'healthy') return false;
    const suggestion = item.suggestedAction?.trim();
    if (!suggestion || GENERIC_SUGGESTION.test(suggestion)) return false;
    if (prescreenAction(item.title)) return false;
    return (
      (item.orbit === 'now' || item.orbit === 'today') &&
      item.confidence >= runtime.matterConfidenceThreshold
    );
  });
}
