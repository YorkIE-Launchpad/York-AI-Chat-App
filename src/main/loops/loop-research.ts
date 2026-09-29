/**
 * Loop research — sweeps every available source (recent chats, meeting notes,
 * calendar, Slack, Gmail, Jira, Drive, Confluence, Launchpad) for content
 * related to a loop and synthesizes a short cited note.
 */
import type { MCPManager } from '../mcp/mcp-manager';
import type { MeetingService } from '../meetings/meeting-service';
import { MemoryLLMClient, type MemoryLLMClientLike } from '../memory/memory-llm-client';
import type { ChatSearchHit } from '../../shared/chat-search';
import type { MatterItem } from '../../shared/matter';
import type { Loop, LoopResearchSource } from '../../shared/loops';
import {
  ConnectorTracker,
  isoDate,
  searchConfluence,
  searchDrive,
  searchGmail,
  searchJira,
  searchLaunchpad,
  searchSlack,
  type GatherDeps,
} from '../matter/meeting-prep/gather';
import { searchPastCalendarEvents } from '../matter/meeting-prep/series-history';
import { EvidencePool, type PrepEvidence } from '../matter/meeting-prep/types';
import { actionKeyPhrase } from '../matter/meeting-prep/verify-actions';
import { logWarn } from '../utils/logger';

const LOOKBACK_DAYS = 45;
const CALENDAR_AHEAD_DAYS = 14;
const MAX_PROMPT_EVIDENCE = 16;

export interface LoopResearchDeps {
  mcp: MCPManager | null;
  meetingService: MeetingService | null;
  matterItem: MatterItem | null;
  /** Full-text search over the user's recent in-app chats. */
  searchChats?: ((query: string, limit: number) => ChatSearchHit[]) | null;
  llm?: MemoryLLMClientLike;
}

export interface LoopResearchResult {
  note: string;
  sources: LoopResearchSource[];
  /** Deadline explicitly stated in a cited source, when one was found. */
  dueAt?: number;
}

function searchPhrases(loop: Loop): string[] {
  const main = actionKeyPhrase({ text: loop.title });
  const short = actionKeyPhrase({ text: loop.title }, 2);
  const phrases = [
    main,
    short !== main ? short : '',
    loop.counterpart ? `${loop.counterpart} ${short}`.trim() : '',
  ]
    .map((p) => p.trim())
    .filter(Boolean);
  return [...new Set(phrases)].slice(0, 3);
}

function addOriginEvidence(pool: EvidencePool, loop: Loop, deps: LoopResearchDeps): void {
  const meetingId = loop.sourceRef.meetingId;
  if (meetingId && deps.meetingService) {
    const meeting = deps.meetingService.get(meetingId);
    if (meeting?.notes) {
      pool.add({
        source: 'meeting',
        title: `Meeting: ${meeting.title || 'Untitled'}`,
        excerpt: [
          meeting.notes.summary,
          meeting.notes.actionItems.length
            ? `Action items: ${meeting.notes.actionItems.join('; ')}`
            : '',
        ]
          .filter(Boolean)
          .join(' '),
        when: isoDate(meeting.startedAt),
        tags: ['origin'],
      });
    }
  }
  const item = deps.matterItem;
  if (item) {
    pool.add({
      source: item.source === 'meeting' ? 'meeting' : 'hub',
      title: `Matter signal: ${item.title}`,
      excerpt: [item.summary, item.whyItMatters, item.rawDetails?.slice(0, 400)]
        .filter(Boolean)
        .join(' '),
      url: item.sourceRef.url || undefined,
      tags: ['origin'],
    });
  }
}

function searchRecentChats(pool: EvidencePool, deps: LoopResearchDeps, phrases: string[]): void {
  if (!deps.searchChats) return;
  const cutoff = Date.now() - LOOKBACK_DAYS * 864e5;
  const seen = new Set<string>();
  for (const phrase of phrases) {
    let hits: ChatSearchHit[] = [];
    try {
      hits = deps.searchChats(phrase, 6);
    } catch (error) {
      logWarn('[Loops] Chat search failed:', error);
      continue;
    }
    for (const hit of hits) {
      if (hit.timestamp < cutoff || seen.has(hit.sessionId) || seen.size >= 3) continue;
      seen.add(hit.sessionId);
      pool.add({
        source: 'chat',
        title: `Chat: ${hit.title || 'Untitled chat'}`,
        excerpt: hit.snippet,
        when: isoDate(hit.timestamp),
      });
    }
  }
}

function searchMeetingNotes(
  pool: EvidencePool,
  loop: Loop,
  deps: LoopResearchDeps,
  phrases: string[]
): void {
  const service = deps.meetingService;
  if (!service) return;
  const cutoff = Date.now() - LOOKBACK_DAYS * 864e5;
  const seen = new Set<string>([loop.sourceRef.meetingId || '']);
  for (const phrase of phrases) {
    for (const listed of service.search(phrase, 3)) {
      if (seen.has(listed.id) || listed.startedAt < cutoff || seen.size > 3) continue;
      seen.add(listed.id);
      const notes = service.get(listed.id)?.notes;
      const excerpt = [
        notes?.summary || listed.summary,
        notes?.actionItems?.length ? `Action items: ${notes.actionItems.join('; ')}` : '',
      ]
        .filter(Boolean)
        .join(' · ');
      if (!excerpt) continue;
      pool.add({
        source: 'meeting',
        title: `Meeting: ${notes?.title || listed.title}`,
        excerpt,
        when: isoDate(listed.startedAt),
      });
    }
  }
}

async function searchCalendar(deps: GatherDeps, phrase: string): Promise<void> {
  const until = new Date(Date.now() + CALENDAR_AHEAD_DAYS * 864e5).toISOString();
  const events = await searchPastCalendarEvents(deps, phrase, until);
  const since = Date.now() - LOOKBACK_DAYS * 864e5;
  for (const event of events
    .filter((e) => Date.parse(e.start) >= since)
    .sort(
      (a, b) =>
        Math.abs(Date.parse(a.start) - Date.now()) - Math.abs(Date.parse(b.start) - Date.now())
    )
    .slice(0, 3)) {
    const upcoming = Date.parse(event.start) > Date.now();
    deps.pool.add({
      source: 'calendar',
      title: `${upcoming ? 'Upcoming' : 'Past'} event: ${event.title || 'Untitled'}`,
      excerpt: `${event.title} on ${event.start}${event.end ? ` → ${event.end}` : ''}`,
      url: event.htmlLink || undefined,
      when: isoDate(event.start),
    });
  }
}

async function searchConnectors(deps: GatherDeps, loop: Loop, phrases: string[]): Promise<void> {
  const since = new Date(Date.now() - LOOKBACK_DAYS * 864e5).toISOString();
  const after = since.slice(0, 10);
  const tasks: Array<Promise<unknown>> = phrases.flatMap((phrase) => [
    searchSlack(deps, `${phrase} after:${after}`, { maxHits: 3, limit: 6, deepenThreads: 1 }),
    searchGmail(deps, `newer_than:${LOOKBACK_DAYS}d ${phrase}`, { maxHits: 2, limit: 4 }),
    searchJira(deps, phrase, since, { maxHits: 2, limit: 3 }),
    searchDrive(deps, phrase, { maxHits: 2, limit: 3 }),
    searchConfluence(deps, phrase, { maxHits: 2, limit: 3 }),
    searchLaunchpad(deps, phrase, { maxHits: 2, limit: 3 }),
  ]);
  if (phrases[0]) tasks.push(searchCalendar(deps, phrases[0]));
  if (loop.counterpart) {
    // Recent direct conversations with the other person, regardless of wording.
    tasks.push(
      searchSlack(deps, `is:im ${loop.counterpart} after:${after}`, { maxHits: 3, limit: 6 }),
      searchGmail(deps, `newer_than:${LOOKBACK_DAYS}d "${loop.counterpart}"`, {
        maxHits: 2,
        limit: 4,
      })
    );
  }
  await Promise.allSettled(tasks);
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

function selectEvidence(evidence: PrepEvidence[]): PrepEvidence[] {
  const origin = evidence.filter((e) => e.tags?.includes('origin'));
  const rest = evidence
    .filter((e) => !e.tags?.includes('origin'))
    .sort((a, b) => (b.when || '').localeCompare(a.when || ''));
  return [...origin, ...rest].slice(0, MAX_PROMPT_EVIDENCE);
}

/** `YYYY-MM-DD` resolves to 5pm local (matching quick-add); full ISO datetimes are kept as-is. */
export function parseStatedDeadline(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const day = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (day) {
    const ms = new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]), 17, 0, 0, 0).getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

interface SynthesizedNote {
  note: string;
  dueAt: number | null;
}

async function synthesizeNote(
  loop: Loop,
  evidence: PrepEvidence[],
  llm: MemoryLLMClientLike
): Promise<SynthesizedNote | null> {
  const response = await llm.complete({
    systemPrompt: [
      'You write a short working note that helps someone close an open to-do ("loop").',
      'Use ONLY the evidence provided. Cite evidence ids inline like [E2]. Never invent facts, people, dates, or links.',
      'Prefer the most recent evidence. Drop evidence that is not actually about this to-do.',
      'Return ONLY JSON: {"relevant":true,"note":"markdown","deadline":null,"deadlineEvidence":null}.',
      'The note has up to three short sections, omitting any with nothing to say:',
      '"**Where it stands**" (1-3 bullets on current status), "**Useful context**" (up to 4 bullets),',
      'and "**Next step**" (one concrete suggestion).',
      'deadline: only if the evidence explicitly states when THIS to-do is due ("by Friday", "due Oct 3", "before the board meeting on the 12th"),',
      "give it as YYYY-MM-DD (or a full ISO datetime if a time is stated), resolving relative dates against that evidence's date;",
      'set deadlineEvidence to the id that states it. Otherwise both are null. A message timestamp or meeting date is NOT a deadline.',
      'If nothing in the evidence is relevant, return {"relevant":false,"note":""}.',
    ].join(' '),
    userPrompt: JSON.stringify({
      todo: loop.title,
      details: loop.notes,
      counterpart: loop.counterpart,
      today: new Date().toISOString().slice(0, 10),
      dueAt: loop.dueAt ? new Date(loop.dueAt).toISOString().slice(0, 10) : null,
      evidence: evidence.map((e) => ({
        id: e.id,
        source: e.source,
        title: e.title,
        when: e.when,
        excerpt: e.excerpt,
      })),
    }),
    temperature: 0.2,
  });
  const text = stripCodeFence(response.text || '');
  const parsed = extractJsonObject(text);
  if (parsed) {
    if (parsed.relevant === false) return { note: '', dueAt: null };
    if (typeof parsed.note === 'string') {
      const backed =
        typeof parsed.deadlineEvidence === 'string' &&
        evidence.some((e) => e.id === parsed.deadlineEvidence);
      return {
        note: parsed.note.trim(),
        dueAt: backed ? parseStatedDeadline(parsed.deadline) : null,
      };
    }
  }
  // Some models ignore the JSON contract and answer in plain markdown.
  if (text && !text.startsWith('{') && /\[E\d+\]/.test(text)) return { note: text, dueAt: null };
  logWarn('[Loops] Unparseable research response:', text.slice(0, 300) || '(empty)');
  return null;
}

function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json|markdown|md)?\s*\n([\s\S]*?)\n?```$/i);
  return (fenced ? fenced[1] : trimmed).trim();
}

export async function researchLoop(
  loop: Loop,
  deps: LoopResearchDeps
): Promise<LoopResearchResult> {
  const pool = new EvidencePool();
  addOriginEvidence(pool, loop, deps);

  const phrases = searchPhrases(loop);
  searchRecentChats(pool, deps, phrases);
  searchMeetingNotes(pool, loop, deps, phrases);

  if (deps.mcp && phrases.length > 0) {
    try {
      await searchConnectors(
        { mcp: deps.mcp, pool, connectors: new ConnectorTracker() },
        loop,
        phrases
      );
    } catch (error) {
      logWarn('[Loops] Connector sweep failed:', error);
    }
  }

  const evidence = selectEvidence(pool.list());
  if (evidence.length === 0) {
    return { note: '', sources: [] };
  }

  const synthesized = await synthesizeNote(loop, evidence, deps.llm ?? new MemoryLLMClient());
  if (synthesized == null) throw new Error('Could not summarize what was found');
  const { note, dueAt } = synthesized;

  const cited = new Set(note.match(/\bE\d+\b/g) || []);
  const sources = evidence
    .filter((e) => cited.has(e.id))
    .map<LoopResearchSource>((e) => ({
      id: e.id,
      source: e.source,
      title: e.title,
      url: e.url ?? null,
    }));
  return dueAt != null ? { note, sources, dueAt } : { note, sources };
}
