/**
 * LLM synthesis: evidence pool → agenda-first `PrepBrief` JSON. Every claim
 * must cite evidence ids; uncited claims are dropped during validation.
 */

import type { AppConfig } from '../../config/config-store';
import { runPiAiOneShot } from '../../agent/sdk-one-shot';
import { applyBackendManagedCredentials } from '../../../shared/backend-config';
import { logWarn } from '../../utils/logger';
import { parseJsonLoose } from './connectors';
import type {
  ActionStatus,
  MeetingKind,
  MeetingPrepContext,
  PartyProfile,
  PrepActionReview,
  PrepAgendaItem,
  PrepBrief,
  PrepClaim,
  PrepEvidence,
  PrepPeopleNote,
  SeriesHistory,
} from './types';

const MEETING_PREP_MODEL = 'gpt-5.6-luna';
export const MAX_EVIDENCE_ITEMS = 40;
export const MAX_EVIDENCE_CHARS = 24_000;

const SYSTEM_PROMPT = `You are an executive assistant preparing a colleague for a meeting.
You receive the meeting invite, attendees, and an evidence list gathered from Slack, Gmail,
calendar history, meeting notes, Hub (HR/clients), Drive, Jira, Launchpad, Confluence, and the web.
Each evidence item has an id like "E3".

Write a short, decision-oriented brief. Synthesize; never list raw messages.

Rules:
- Ground everything in evidence. Every claim, agenda item, question, and risk MUST cite one or more
  evidence ids in "evidenceIds". If you cannot cite it, leave it out. Never invent facts, dates, owners.
- The invite itself is evidence (tagged "invite"); agenda items that only come from the invite cite it.
- Ignore evidence that is clearly unrelated to this meeting (social chatter, other projects).
- Agenda: 3-6 concrete topics in the order they should be discussed, most important first. Each has a
  one-line "why" explaining why it matters now. Add "minutes" (5-20) so the total fits a typical
  30-60 minute meeting, and "owner" only when evidence names one.
- Prefer specifics (names, numbers, deadlines, ticket keys) over generic items like "discuss updates".
- "bottomLine": 1-2 sentences on what this session must achieve.
- "purpose": a short phrase (max 8 words) naming what the meeting is about.

Recurring meetings ("kind": "recurring"):
- "whatChanged": what happened since the last occurrence (decisions, progress, new issues).
- "actionReview": one entry per prior action item, same order, with "index" matching the input.
  status is one of "done", "in_progress", "open", "unknown".
  "done" or "in_progress" requires evidence showing the work happened; "open" requires evidence that it
  is still pending or blocked. The item's origin meeting notes do not count as status evidence.
  With no status evidence use "unknown". Put a short explanation in "note".
- Put unresolved action items on the agenda when they matter.

One-off meetings ("kind": "one_off"):
- "peopleNotes": one line per key attendee (role, company, relationship history with us), cited.
- "contextSoFar": the key exchanges so far (asks, proposals, open questions, commitments).
- Leave "whatChanged" and "actionReview" empty.

Return ONLY a JSON object with this shape:
{
  "purpose": string,
  "bottomLine": string,
  "whatChanged": [{"text": string, "evidenceIds": [string]}],
  "contextSoFar": [{"text": string, "evidenceIds": [string]}],
  "actionReview": [{"index": number, "item": string, "owner": string?, "status": string, "note": string?, "evidenceIds": [string]}],
  "agenda": [{"topic": string, "why": string, "owner": string?, "minutes": number?, "evidenceIds": [string]}],
  "questionsToAsk": [{"text": string, "evidenceIds": [string]}],
  "risks": [{"text": string, "evidenceIds": [string]}],
  "peopleNotes": [{"name": string, "note": string, "evidenceIds": [string]}]
}`;

function evidencePriority(e: PrepEvidence): number {
  const tags = e.tags || [];
  if (tags.includes('invite')) return 0;
  if (tags.includes('previous-instance') || tags.includes('prior-meeting')) return 1;
  if (tags.some((t) => t.startsWith('action:'))) return 2;
  if (tags.some((t) => t.startsWith('party:'))) return 3;
  return 4;
}

/** Highest-signal evidence first, capped by count and characters. */
export function selectEvidenceForPrompt(
  evidence: PrepEvidence[],
  maxItems = MAX_EVIDENCE_ITEMS,
  maxChars = MAX_EVIDENCE_CHARS
): PrepEvidence[] {
  const ordered = evidence
    .map((e, i) => ({ e, i }))
    .sort((a, b) => evidencePriority(a.e) - evidencePriority(b.e) || a.i - b.i)
    .map(({ e }) => e);
  const out: PrepEvidence[] = [];
  let chars = 0;
  for (const e of ordered) {
    const size = e.excerpt.length + e.title.length + 40;
    if (out.length >= maxItems || (chars + size > maxChars && out.length > 0)) break;
    out.push(e);
    chars += size;
  }
  return out;
}

export function buildSynthesisPrompt(input: {
  ctx: MeetingPrepContext;
  kind: MeetingKind;
  evidence: PrepEvidence[];
  history: SeriesHistory | null;
  parties: PartyProfile[];
}): string {
  const { ctx, kind, evidence, history, parties } = input;
  return JSON.stringify(
    {
      today: new Date().toISOString().slice(0, 10),
      me: ctx.selfEmail,
      meeting: {
        title: ctx.title,
        when: ctx.when,
        kind,
        cadence: history?.cadence ?? null,
        lastHeld: history?.lastHeld ?? null,
        attendees: ctx.attendees.map((a) => ({ name: a.name, email: a.email })),
      },
      priorActionItems: (history?.actionItems || []).map((a, index) => ({
        index,
        item: a.text,
        owner: a.owner ?? null,
        fromDate: a.fromDate ?? history?.actionItemsFrom ?? null,
        originEvidenceId: a.originEvidenceId,
        statusEvidenceIds: a.evidenceIds,
      })),
      parties: parties.map((p) => ({
        name: p.name,
        email: p.email,
        org: p.org ?? null,
        internal: p.internal,
        evidenceIds: p.evidenceIds,
      })),
      evidence: evidence.map((e) => ({
        id: e.id,
        source: e.source,
        title: e.title,
        when: e.when ?? null,
        tags: e.tags ?? [],
        excerpt: e.excerpt,
      })),
    },
    null,
    1
  );
}

function str(value: unknown, max = 400): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

function ids(value: unknown, valid: Set<string>): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((v): v is string => typeof v === 'string' && valid.has(v)))];
}

function claims(value: unknown, valid: Set<string>, max: number): PrepClaim[] {
  if (!Array.isArray(value)) return [];
  const out: PrepClaim[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const rec = raw as Record<string, unknown>;
    const text = str(rec.text, 300);
    const evidenceIds = ids(rec.evidenceIds, valid);
    if (text && evidenceIds.length) out.push({ text, evidenceIds });
    if (out.length >= max) break;
  }
  return out;
}

const STATUSES: ActionStatus[] = ['done', 'in_progress', 'open', 'unknown'];

/**
 * Parse and enforce the brief contract: valid ids only, uncited claims
 * dropped, action statuses downgraded to `unknown` without status evidence,
 * and every prior action item represented. Returns null when unusable.
 */
export function parsePrepBrief(
  text: string,
  validIds: Set<string>,
  history: SeriesHistory | null
): PrepBrief | null {
  const json = parseJsonLoose(text);
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const rec = json as Record<string, unknown>;
  const bottomLine = str(rec.bottomLine, 400);
  const agenda: PrepAgendaItem[] = [];
  if (Array.isArray(rec.agenda)) {
    for (const raw of rec.agenda) {
      if (!raw || typeof raw !== 'object') continue;
      const a = raw as Record<string, unknown>;
      const topic = str(a.topic, 140);
      const evidenceIds = ids(a.evidenceIds, validIds);
      if (!topic || !evidenceIds.length) continue;
      const minutes =
        typeof a.minutes === 'number' && Number.isFinite(a.minutes)
          ? Math.min(60, Math.max(1, Math.round(a.minutes)))
          : undefined;
      agenda.push({
        topic,
        why: str(a.why, 240),
        owner: str(a.owner, 60) || undefined,
        minutes,
        evidenceIds,
      });
      if (agenda.length >= 6) break;
    }
  }
  if (!bottomLine || !agenda.length) return null;

  const priors = history?.actionItems || [];
  const reviewByIndex = new Map<number, Record<string, unknown>>();
  if (Array.isArray(rec.actionReview)) {
    rec.actionReview.forEach((raw, position) => {
      if (!raw || typeof raw !== 'object') return;
      const r = raw as Record<string, unknown>;
      const index = typeof r.index === 'number' ? r.index : position;
      if (index >= 0 && index < priors.length && !reviewByIndex.has(index)) {
        reviewByIndex.set(index, r);
      }
    });
  }
  const actionReview: PrepActionReview[] = priors.map((prior, index) => {
    const r = reviewByIndex.get(index);
    const evidenceIds = ids(r?.evidenceIds, validIds).filter((id) => id !== prior.originEvidenceId);
    let status = (
      STATUSES.includes(r?.status as ActionStatus) ? r?.status : 'unknown'
    ) as ActionStatus;
    if (status !== 'unknown' && !evidenceIds.length) status = 'unknown';
    return {
      item: prior.text,
      owner: prior.owner || str(r?.owner, 60) || undefined,
      status,
      note: status === 'unknown' ? undefined : str(r?.note, 200) || undefined,
      evidenceIds: status === 'unknown' ? [] : evidenceIds,
    };
  });

  const peopleNotes: PrepPeopleNote[] = [];
  if (Array.isArray(rec.peopleNotes)) {
    for (const raw of rec.peopleNotes) {
      if (!raw || typeof raw !== 'object') continue;
      const p = raw as Record<string, unknown>;
      const name = str(p.name, 80);
      const note = str(p.note, 240);
      const evidenceIds = ids(p.evidenceIds, validIds);
      if (name && note && evidenceIds.length) peopleNotes.push({ name, note, evidenceIds });
      if (peopleNotes.length >= 6) break;
    }
  }

  return {
    purpose: str(rec.purpose, 80),
    bottomLine,
    whatChanged: claims(rec.whatChanged, validIds, 5),
    contextSoFar: claims(rec.contextSoFar, validIds, 5),
    actionReview,
    agenda,
    questionsToAsk: claims(rec.questionsToAsk, validIds, 4),
    risks: claims(rec.risks, validIds, 3),
    peopleNotes,
  };
}

export async function synthesizePrepBrief(input: {
  config: AppConfig;
  ctx: MeetingPrepContext;
  kind: MeetingKind;
  evidence: PrepEvidence[];
  history: SeriesHistory | null;
  parties: PartyProfile[];
}): Promise<PrepBrief | null> {
  const selected = selectEvidenceForPrompt(input.evidence);
  const validIds = new Set(selected.map((e) => e.id));
  try {
    const creds = applyBackendManagedCredentials({ provider: 'openai', apiKey: '', baseUrl: '' });
    const oneShotConfig: AppConfig = {
      ...input.config,
      model: MEETING_PREP_MODEL,
      provider: 'openai',
      customProtocol: 'openai',
      baseUrl: creds.baseUrl || input.config.baseUrl,
      apiKey: creds.apiKey || input.config.apiKey,
    };
    const prompt = buildSynthesisPrompt({ ...input, evidence: selected });
    const result = await runPiAiOneShot(prompt, SYSTEM_PROMPT, oneShotConfig, {
      usageFeature: 'matter_prep',
      usageSessionId: 'matter_prep',
    });
    const brief = parsePrepBrief(result.text, validIds, input.history);
    if (!brief) logWarn('[Matter] Prep synthesis returned an unusable brief');
    return brief;
  } catch (error) {
    logWarn('[Matter] Prep synthesis failed:', error);
    return null;
  }
}
