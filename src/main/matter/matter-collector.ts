/**
 * Matter collector — fans out to connected MCP sources + local meetings.
 * Emits one signal per concrete item (event, email, message, issue), never count rollups.
 */

import type { WelcomeProfile } from '../../shared/welcome-actions';
import type {
  MatterCategory,
  MatterConfigurableSource,
  MatterOrbit,
  MatterSeverity,
  MatterSource,
  MatterSourceRef,
  MatterSourcesConfig,
} from '../../shared/matter';
import { normalizeMatterContentText } from '../../shared/matter';
import type { MCPManager } from '../mcp/mcp-manager';
import type { MeetingService } from '../meetings/meeting-service';
import { log, logWarn } from '../utils/logger';
import {
  DEFAULT_GMAIL_MCP_SERVER_ID,
  DEFAULT_GOOGLE_CALENDAR_MCP_SERVER_ID,
  DEFAULT_HUB_MCP_SERVER_ID,
  DEFAULT_JIRA_MCP_SERVER_ID,
  DEFAULT_LAUNCHPAD_MCP_SERVER_ID,
  DEFAULT_SLACK_MCP_SERVER_ID,
} from '../../shared/mcp-defaults';
import {
  DEFAULT_JIRA_SITE_ORIGIN,
  jiraBrowseUrl,
  jiraSiteOriginFromUrl,
} from '../../shared/jira-urls';
import {
  MAX_VAGUE_ENRICHMENTS_PER_SCAN,
  enrichVagueCalendarMeeting,
  isVagueMeetingTitle,
  parseEventAttendees,
} from './matter-calendar-enrichment';

export {
  MEETING_PREP_MARKER,
  isVagueMeetingTitle,
  parseEventAttendees,
  buildEnrichedMeetingTitle,
  buildMeetingPrepNote,
} from './matter-calendar-enrichment';

const MAX_PER_SOURCE = 8;
const RAW_CAP = 4000;

/** Exact / near-exact titles that are personal holds, not collaborative meetings. */
const PERSONAL_HOLD_EXACT = new Set([
  'break',
  'block',
  'blocked',
  'hold',
  'focus',
  'focus time',
  'focus block',
  'deep work',
  'heads down',
  'lunch',
  'coffee',
  'gym',
  'commute',
  'personal',
  'ooo',
  'o.o.o',
  'o.o.o.',
  'out of office',
  'pto',
  'vacation',
  'busy',
  'dnd',
  'do not disturb',
  'no meeting',
  'no meetings',
  'unavailable',
  'wfh',
  'working from home',
]);

/**
 * True for personal calendar holds (Break, block, focus, OOO, …).
 * Keeps real meetings like "1:1 with Ada" or "Unblock checkout".
 */
export function isPersonalCalendarHold(title: string): boolean {
  const t = title.trim().toLowerCase().replace(/[–—]/g, '-').replace(/\s+/g, ' ');
  if (!t) return true;
  if (PERSONAL_HOLD_EXACT.has(t)) return true;
  // Short phrase holds: "Focus until 3", "OOO half day", "Blocked 2-4"
  if (t.length <= 40) {
    if (/^(focus|ooo|out of office|blocked?|hold|break|lunch|pto)\b/.test(t)) {
      return true;
    }
  }
  return false;
}

/** True when RRULE BYDAY covers all weekdays (order-independent). */
function rruleCoversAllWeekdays(byday: string): boolean {
  const days = new Set(
    byday
      .split(',')
      .map((d) => d.trim().toUpperCase())
      .filter(Boolean)
  );
  return ['MO', 'TU', 'WE', 'TH', 'FR'].every((d) => days.has(d));
}

/**
 * True for daily recurring series (standup/sync/etc.) that should not clutter Matter.
 * Independent of personal holds — drops even for real-looking meeting titles.
 * Detects FREQ=DAILY, weekday-every-day WEEKLY RRULEs, connector "daily" keyword,
 * or common daily title patterns.
 */
export function isDailySeriesMeeting(title: string, rawText?: string | null): boolean {
  const blob = `${rawText || ''}`;
  if (/FREQ=DAILY\b/i.test(blob)) return true;

  // Weekday standups often use FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR instead of FREQ=DAILY.
  const weeklyByDay = blob.match(/FREQ=WEEKLY\b[^;\n]*;BYDAY=([A-Za-z,]+)/i);
  if (weeklyByDay && rruleCoversAllWeekdays(weeklyByDay[1])) return true;
  const byDayWeekly = blob.match(/BYDAY=([A-Za-z,]+)[^;\n]*;FREQ=WEEKLY\b/i);
  if (byDayWeekly && rruleCoversAllWeekdays(byDayWeekly[1])) return true;

  // Connector get_event adds "daily" to keywords when FREQ=DAILY (also useful if RRULE text is missing).
  if (/"daily"|'daily'|"keywords"\s*:\s*\[[^\]]*\bdaily\b/i.test(blob)) return true;
  if (/\bkeywords\b[^\n]*\bdaily\b/i.test(blob)) return true;

  const t = title.trim().toLowerCase().replace(/[–—]/g, '-').replace(/\s+/g, ' ');
  if (!t) return false;
  if (/^daily(\s+series)?$/.test(t)) return true;
  if (
    /\bdaily\s+(stand[\s-]?up|sync|scrum|check[\s-]?in|huddle|call|meeting|series|status)\b/.test(t)
  ) {
    return true;
  }
  // Short titles that are clearly a daily cadence ritual
  if (t.length <= 48 && /^(daily)\b/.test(t)) return true;
  return false;
}

/** Date-only bound: YYYY-MM-DD with no time / T separator. */
function isDateOnlyBound(value: string): boolean {
  const v = value.trim();
  if (!v) return false;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return true;
  // Reject timed ISO (contains T or space+time)
  if (/T|\d{1,2}:\d{2}/.test(v)) return false;
  return /^\d{4}-\d{2}-\d{2}/.test(v) && !/[T ]\d/.test(v);
}

/**
 * True for Google all-day (date-only) calendar events.
 * Independent of personal holds — drops even for real-looking titles.
 */
export function isAllDayCalendarEvent(when: string, rawText?: string | null): boolean {
  const range = (when || '').trim();
  if (range.includes('→')) {
    const [start, end] = range.split('→').map((p) => p.trim());
    if (start && end && isDateOnlyBound(start) && isDateOnlyBound(end)) return true;
  } else if (range && isDateOnlyBound(range)) {
    return true;
  }

  const blob = `${rawText || ''}`;
  // Detail lines like "Title (2026-08-12 → 2026-08-13)" or start.date style
  const paren = blob.match(/\((\d{4}-\d{2}-\d{2})\s*→\s*(\d{4}-\d{2}-\d{2})\)/);
  if (paren && isDateOnlyBound(paren[1]) && isDateOnlyBound(paren[2])) return true;
  if (/"date"\s*:\s*"\d{4}-\d{2}-\d{2}"/.test(blob) && !/"dateTime"\s*:/.test(blob)) return true;
  return false;
}

export interface RawMatterSignal {
  fingerprint: string;
  source: MatterSource;
  title: string;
  summary: string;
  rawExcerpt: string;
  rawDetails?: string;
  severityHint: MatterSeverity;
  orbitHint: MatterOrbit;
  categoryHint: MatterCategory;
  whyHint?: string;
  suggestedAction?: string;
  sourceRef?: MatterSourceRef;
  muteKeys: string[];
  /** When the action is due (e.g. event start). */
  dueAt?: number;
  /** When the item should expire / drop (e.g. event end). */
  expiresAt?: number;
  /** @deprecated Use dueAt — kept for call sites during migration. */
  occurredAt?: number;
}

export interface CollectSignalsResult {
  signals: RawMatterSignal[];
  sourcesChecked: string[];
  sourcesSkipped: string[];
}

function truncate(value: unknown, max = RAW_CAP): string {
  const text =
    typeof value === 'string'
      ? value
      : (() => {
          try {
            return JSON.stringify(value);
          } catch {
            return String(value);
          }
        })();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Slack / JSON / schema noise that must never become a Matter title. */
export function looksLikeJunkTitle(text: string): boolean {
  const t = text.trim();
  if (!t || t.length < 2) return true;
  if (/^[[\]{}:,;]+$/.test(t)) return true;
  if (/^"[^"]+"\s*:/.test(t)) return true; // "expected":
  if (/^'[^']+'\s*:/.test(t)) return true;
  // JSON key fragments: "path": [  or path: {
  if (/^["']?\w+["']?\s*:\s*[[{]/.test(t)) return true;
  if (/^"[^"]*"\s*,?\s*$/.test(t)) return true; // "nan",
  if (/^(true|false|null|nan|undefined)\s*,?$/i.test(t)) return true;
  if (
    /^(expected|received|message|path|code|type|error|projectId|statusCode|issues)\b/i.test(t) &&
    t.length < 48
  ) {
    return true;
  }
  // Mostly JSON punctuation / keys
  if ((t.match(/"/g) || []).length >= 2 && /":\s*[[{"']/.test(t) && t.length < 100) return true;
  if (/^<[CWDGU][A-Z0-9]+>/.test(t) && t.length < 24) return true;
  return false;
}

function cleanDisplayText(text: string): string {
  return text
    .replace(/<@([A-Z0-9]+)>/gi, '@user')
    .replace(/<#([A-Z0-9]+)(?:\|([^>]+))?>/gi, (_m, _id, name) => (name ? `#${name}` : '#channel'))
    .replace(/<(https?:[^|>]+)(?:\|([^>]+))?>/gi, (_m, url, label) => label || url)
    .replace(/\b[CDG][A-Z0-9]{9,}\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function humanTitle(text: string, fallback = 'Untitled item'): string {
  const cleaned = cleanDisplayText(text).slice(0, 160);
  if (!cleaned || looksLikeJunkTitle(cleaned)) return fallback;
  return cleaned;
}

function pickString(obj: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

function hashKey(input: string): string {
  let h = 0;
  for (let i = 0; i < input.length; i++) h = (Math.imul(31, h) + input.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

/** Prefer a stable Hub request id from free-text or JSON-ish lines. */
export function extractHubRequestId(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const id = pickString(parsed as Record<string, unknown>, [
        'id',
        'requestId',
        'request_id',
        'hubRequestId',
      ]);
      if (id) return id;
    }
  } catch {
    // not JSON
  }
  const uuid = trimmed.match(
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i
  );
  if (uuid) return uuid[0].toLowerCase();
  const hashNum = trimmed.match(/#(\d{2,})\b/);
  if (hashNum) return hashNum[1];
  const labeled = trimmed.match(/\b(?:request|req|id)\s*[:=#]\s*([A-Za-z0-9_-]{4,})\b/i);
  if (labeled) return labeled[1];
  return null;
}

export function hubRequestFingerprint(line: string): string {
  const id = extractHubRequestId(line);
  if (id) return `hub:request:${id}`;
  return `hub:request:${hashKey(normalizeMatterContentText(line))}`;
}

/** Prefer stable Launchpad entity id from raw payload. */
export function extractLaunchpadEntityId(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = pickString(raw as Record<string, unknown>, [
    'id',
    'projectId',
    'releaseId',
    'featureId',
    'versionId',
  ]);
  return id || null;
}

export function launchpadItemFingerprint(input: {
  stableName: string;
  raw: unknown;
}): string {
  const id = extractLaunchpadEntityId(input.raw);
  if (id) return `launchpad:item:${id}`;
  return `launchpad:item:${hashKey(normalizeMatterContentText(input.stableName))}`;
}

/** True when copy clearly asks the person to do something (not FYI / unread triage). */
function looksLikeActionNeeded(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (
    /\b(fyi|for your information|no action|nntr|circle back later|just sharing)\b/i.test(t) &&
    !/\b(please|can you|need you|action required)\b/i.test(t)
  ) {
    return false;
  }
  return (
    /\?/.test(t) ||
    /\b(please|pls|kindly)\b/i.test(t) ||
    /\b(can you|could you|would you|will you)\b/i.test(t) ||
    /\b(need you|needs you|need your|waiting on you|blocked on you)\b/i.test(t) ||
    /\b(action required|please review|please approve|please confirm|sign off|respond by|due by)\b/i.test(
      t
    ) ||
    /\b(asap|urgent|blocker|blocked|overdue|escalat)/i.test(t) ||
    /\b(approve|reject|review|confirm|reply|respond|schedule|reschedule|send me|update the)\b/i.test(
      t
    )
  );
}

function toolResultText(result: unknown): string {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  if (typeof result === 'object') {
    const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
    if (Array.isArray(content)) {
      return content
        .map((c) => (typeof c?.text === 'string' ? c.text : ''))
        .filter(Boolean)
        .join('\n');
    }
  }
  return truncate(result);
}

function parseJsonLoose(text: string): unknown | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function envelopeBody(text: string): string {
  const parsed = parseJsonLoose(text);
  if (parsed && typeof parsed === 'object' && parsed !== null && 'body' in parsed) {
    const body = (parsed as { body?: unknown }).body;
    if (typeof body === 'string') return body;
  }
  return text;
}

function extractUrl(text: string): string | undefined {
  const match = text.match(/https?:\/\/[^\s"'<>]+/i);
  return match?.[0]?.replace(/[),.;]+$/, '');
}

function signal(input: {
  fingerprint: string;
  source: MatterSource;
  title: string;
  summary: string;
  raw: unknown;
  severityHint?: MatterSeverity;
  orbitHint?: MatterOrbit;
  categoryHint?: MatterCategory;
  whyHint?: string;
  suggestedAction?: string;
  sourceRef?: MatterSourceRef;
  muteKeys?: string[];
  dueAt?: number;
  expiresAt?: number;
  /** @deprecated Use dueAt */
  occurredAt?: number;
}): RawMatterSignal {
  const rawDetails = truncate(input.raw);
  const url = input.sourceRef?.url || extractUrl(rawDetails);
  const title = humanTitle(input.title, `${input.source} item`);
  const summary = cleanDisplayText(input.summary).slice(0, 400) || title;
  const dueAt = input.dueAt ?? input.occurredAt;
  return {
    fingerprint: input.fingerprint,
    source: input.source,
    title,
    summary,
    rawExcerpt: rawDetails.slice(0, 800),
    rawDetails,
    severityHint: input.severityHint || 'signal',
    orbitHint: input.orbitHint || 'today',
    categoryHint: input.categoryHint || 'comms',
    whyHint: input.whyHint,
    suggestedAction: input.suggestedAction,
    sourceRef: {
      ...input.sourceRef,
      ...(url ? { url } : {}),
    },
    muteKeys: input.muteKeys || [`source:${input.source}`],
    dueAt,
    expiresAt: input.expiresAt,
    occurredAt: dueAt,
  };
}

function isServerConnected(mcpManager: MCPManager, serverId: string): boolean {
  try {
    return mcpManager.getServerStatus().some((s) => s.id === serverId && s.connected);
  } catch {
    return false;
  }
}

function findToolName(
  mcpManager: MCPManager,
  serverId: string,
  candidates: string[]
): string | null {
  try {
    const tools = mcpManager.getTools().filter((t) => t.serverId === serverId);
    for (const hint of candidates) {
      const lower = hint.toLowerCase();
      const match = tools.find((t) => {
        const original = (t.originalName || '').toLowerCase();
        const name = t.name.toLowerCase();
        return original === lower || original.includes(lower) || name.includes(lower);
      });
      if (match) return match.name;
    }
  } catch {
    /* ignore */
  }
  return null;
}

async function safeCallTool(
  mcpManager: MCPManager,
  toolName: string,
  args: Record<string, unknown>
): Promise<string | null> {
  try {
    const result = await mcpManager.callTool(toolName, args);
    const text = toolResultText(result);
    return text || null;
  } catch (error) {
    logWarn(`[Matter] Tool ${toolName} failed:`, error);
    return null;
  }
}

function parseIsoMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

// ── Calendar: one signal per event ──────────────────────────────────────────

function parseCalendarLines(body: string): Array<{ id: string; title: string; when: string }> {
  const lines = body
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const out: Array<{ id: string; title: string; when: string }> = [];
  for (const line of lines) {
    // id: Title (start → end)
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.+?)\s*\(([^)]+)\)\s*$/);
    if (m) {
      out.push({ id: m[1], title: m[2].trim(), when: m[3].trim() });
      continue;
    }
    const m2 = line.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
    if (m2 && !/^No events/i.test(m2[1])) {
      out.push({
        id: `line-${out.length}-${m2[1].slice(0, 24)}`,
        title: m2[1].trim(),
        when: m2[2].trim(),
      });
    }
  }
  return out;
}

type CalendarDraft = {
  id: string;
  title: string;
  when: string;
  htmlLink?: string;
  raw: unknown;
  detailBody: string;
  startMs?: number;
  endMs?: number | null;
  hoursUntil: number;
};

async function collectCalendar(
  mcpManager: MCPManager,
  _profile: WelcomeProfile | null,
  meetingService: MeetingService | null = null
): Promise<RawMatterSignal[]> {
  const tool = findToolName(mcpManager, DEFAULT_GOOGLE_CALENDAR_MCP_SERVER_ID, [
    'list_events',
    'search_events',
  ]);
  if (!tool) return [];

  const now = new Date();
  const week = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const text = await safeCallTool(mcpManager, tool, {
    time_min: now.toISOString(),
    time_max: week.toISOString(),
    limit: 20,
  });
  if (!text) return [];

  const body = envelopeBody(text);
  // Only near-term events that need prep / attendance decision — not the whole week dump.
  const events = parseCalendarLines(body).slice(0, 20);
  if (!events.length) return [];

  const getTool = findToolName(mcpManager, DEFAULT_GOOGLE_CALENDAR_MCP_SERVER_ID, ['get_event']);
  const drafts = (
    await Promise.all(
      events.map(async (ev): Promise<CalendarDraft | null> => {
        let htmlLink: string | undefined;
        let startIso: string | undefined;
        let raw: unknown = ev;
        let detailBody = '';
        if (getTool && !ev.id.startsWith('line-')) {
          const detailText = await safeCallTool(mcpManager, getTool, { event_id: ev.id });
          if (detailText) {
            const parsed = parseJsonLoose(detailText) as Record<string, unknown> | null;
            const nested = parsed && typeof parsed === 'object' ? parsed : null;
            htmlLink = extractUrl(detailText);
            const bodyStr = typeof nested?.body === 'string' ? nested.body : detailText;
            detailBody = bodyStr;
            const whenMatch = bodyStr.match(/\(([^)]+→[^)]+)\)/);
            startIso = whenMatch?.[1]?.split('→')[0]?.trim() || ev.when.split('→')[0]?.trim();
            if (typeof nested?.title === 'string' && nested.title.trim()) {
              ev.title = nested.title.trim();
            }
            raw = nested || detailText;
          }
        }
        const startMs = parseIsoMs(startIso) ?? parseIsoMs(ev.when.split('→')[0]?.trim());
        // Prefer event end from "start → end" range when present.
        const endFromWhen = (() => {
          const range = startIso && startIso.includes('→') ? startIso : ev.when;
          const parts = range.split('→');
          if (parts.length >= 2) return parseIsoMs(parts[1]?.trim());
          return null;
        })();
        const hoursUntil = startMs != null ? (startMs - Date.now()) / 36e5 : 999;
        // Action bar: only meetings starting within ~6h (prep / show up), not passive week list
        if (hoursUntil < 0 || hoursUntil > 6) return null;
        // Drop personal holds (Break, block, focus, OOO, …) — not action radar material
        if (isPersonalCalendarHold(ev.title)) return null;
        // Daily / all-day drops are independent of personal holds (real titles still drop).
        const rawText = detailBody || (typeof raw === 'string' ? raw : truncate(raw));
        if (isDailySeriesMeeting(ev.title, rawText)) return null;
        if (isAllDayCalendarEvent(ev.when, rawText)) return null;

        return {
          id: ev.id,
          title: ev.title,
          when: ev.when,
          htmlLink,
          raw,
          detailBody: rawText,
          startMs: startMs ?? undefined,
          endMs: endFromWhen,
          hoursUntil,
        };
      })
    )
  ).filter((d): d is CalendarDraft => !!d);

  const signals: RawMatterSignal[] = [];
  let enrichLeft = MAX_VAGUE_ENRICHMENTS_PER_SCAN;

  for (const draft of drafts.slice(0, MAX_PER_SOURCE)) {
    const orbit: MatterOrbit = draft.hoursUntil <= 2 ? 'now' : 'today';
    const severity: MatterSeverity =
      draft.hoursUntil <= 1 ? 'critical' : draft.hoursUntil <= 3 ? 'warning' : 'signal';

    let title = draft.title;
    let summary = draft.when;
    let raw: unknown = draft.raw;
    let whyHint = 'Starts soon — prep or confirm you still need to attend.';
    let suggestedAction = 'Open the event and prep or decline.';

    if (isVagueMeetingTitle(draft.title) && enrichLeft > 0) {
      enrichLeft -= 1;
      try {
        const attendees = parseEventAttendees(draft.detailBody);
        const enriched = await enrichVagueCalendarMeeting({
          mcpManager,
          meetingService,
          originalTitle: draft.title,
          when: draft.when,
          attendees,
          eventUrl: draft.htmlLink,
        });
        title = enriched.title;
        summary = enriched.summary;
        whyHint = enriched.whyHint;
        suggestedAction = enriched.suggestedAction;
        raw = enriched.prepNote;
      } catch (error) {
        logWarn('[Matter] Vague calendar enrichment failed:', error);
      }
    }

    signals.push(
      signal({
        fingerprint: `calendar:event:${draft.id}`,
        source: 'calendar',
        title,
        summary,
        raw,
        severityHint: severity,
        orbitHint: orbit,
        categoryHint: 'time',
        whyHint,
        suggestedAction,
        sourceRef: {
          connectorId: DEFAULT_GOOGLE_CALENDAR_MCP_SERVER_ID,
          externalId: draft.id,
          label: 'Calendar',
          url: draft.htmlLink,
        },
        muteKeys: [`calendar:event:${draft.id}`, 'source:calendar'],
        dueAt: draft.startMs,
        expiresAt: draft.endMs ?? draft.startMs,
      })
    );
  }

  return signals;
}

// ── Slack: one signal per matching message ──────────────────────────────────

function parseSlackMessages(
  body: string
): Array<{ channel: string; ts: string; user: string; text: string; link?: string }> {
  const lines = body.split('\n');
  const out: Array<{
    channel: string;
    ts: string;
    user: string;
    text: string;
    link?: string;
  }> = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    // channel [ts] user: text
    const m = line.match(/^(\S+)\s+\[([^\]]+)\]\s+([^:]+):\s*(.*)$/);
    if (!m) continue;
    let link: string | undefined;
    const next = lines[i + 1]?.trim() || '';
    if (/^Link:\s*/i.test(next)) {
      link = next.replace(/^Link:\s*/i, '').trim();
      i += 1;
    } else {
      link = extractUrl(line);
    }
    out.push({
      channel: m[1],
      ts: m[2],
      user: m[3].trim(),
      text: (m[4] || '').trim(),
      link,
    });
  }
  return out;
}

async function collectSlack(
  mcpManager: MCPManager,
  profile: WelcomeProfile | null
): Promise<RawMatterSignal[]> {
  const tool = findToolName(mcpManager, DEFAULT_SLACK_MCP_SERVER_ID, [
    'search_messages',
    'search_public_and_private',
    'search_public',
    'conversations_history',
    'conversations_replies',
  ]);
  if (!tool) return [];

  const me = profile?.name?.split(/\s+/)[0] || '';
  const after = new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10);
  // Prefer DMs / asks — not every mention. Further filtered for action language below.
  const query = me ? `(is:dm OR to:@me OR ${me}) after:${after}` : `is:dm after:${after}`;
  const text = await safeCallTool(mcpManager, tool, {
    query,
    limit: 15,
  });
  if (!text) return [];

  const body = envelopeBody(text);
  const messages = parseSlackMessages(body)
    .filter((msg) => looksLikeActionNeeded(msg.text))
    .slice(0, MAX_PER_SOURCE);
  if (!messages.length) return [];

  return messages.map((msg) => {
    const channelLabel = /^[CGD][A-Z0-9]{8,}$/i.test(msg.channel)
      ? 'channel'
      : msg.channel.replace(/^#/, '');
    const userLabel = /^[UW][A-Z0-9]{8,}$/i.test(msg.user) ? 'Someone' : msg.user;
    const preview = cleanDisplayText(msg.text).slice(0, 100) || '(no text)';
    const title = humanTitle(`${userLabel} in #${channelLabel}: ${preview}`, 'Slack ask');
    return signal({
      fingerprint: `slack:msg:${msg.channel}:${msg.ts}`,
      source: 'slack',
      title,
      summary: cleanDisplayText(msg.text).slice(0, 280) || `Ask from ${userLabel}`,
      raw: msg,
      severityHint: 'warning',
      orbitHint: 'today',
      categoryHint: 'comms',
      whyHint: 'Someone is asking you to reply or take action in Slack.',
      suggestedAction: 'Reply in Slack or mark handled.',
      sourceRef: {
        connectorId: DEFAULT_SLACK_MCP_SERVER_ID,
        externalId: `${msg.channel}:${msg.ts}`,
        label: 'Slack',
        url: msg.link,
      },
      muteKeys: [`slack:channel:${msg.channel}`, 'source:slack'],
      occurredAt: parseIsoMs(msg.ts) || Number(msg.ts) * 1000 || undefined,
    });
  });
}

// ── Gmail: only emails that clearly need action (not inbox unread triage) ───

async function collectGmail(
  mcpManager: MCPManager,
  _profile: WelcomeProfile | null
): Promise<RawMatterSignal[]> {
  const searchTool = findToolName(mcpManager, DEFAULT_GMAIL_MCP_SERVER_ID, [
    'search_emails',
    'list_messages',
  ]);
  if (!searchTool) return [];

  // Unreads alone are not Matter — person will triage in Gmail. Pull action-shaped mail only.
  const searchText = await safeCallTool(mcpManager, searchTool, {
    query:
      'newer_than:14d (subject:(action required OR approval OR urgent OR invoice OR blocked OR "please review" OR "please approve") OR ("can you" OR "could you" OR "need your" OR "waiting on you" OR "please reply" OR "please confirm")) -category:promotions -category:social',
    limit: 10,
  });
  if (!searchText) return [];

  const body = envelopeBody(searchText);
  const ids = body
    .split(/\n/)
    .map((l) => l.trim())
    .filter((l) => /^[a-zA-Z0-9_-]{6,}$/.test(l))
    .slice(0, MAX_PER_SOURCE);

  if (!ids.length) {
    const parsed = parseJsonLoose(searchText);
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (typeof item === 'string') ids.push(item);
        else if (item && typeof item === 'object' && 'id' in item) {
          ids.push(String((item as { id: unknown }).id));
        }
      }
    }
  }

  if (!ids.length) return [];

  const getTool = findToolName(mcpManager, DEFAULT_GMAIL_MCP_SERVER_ID, [
    'get_email',
    'get_message',
  ]);

  const signals: RawMatterSignal[] = [];
  for (const id of ids.slice(0, MAX_PER_SOURCE)) {
    let subject = `Email ${id.slice(0, 10)}…`;
    let from = '';
    let snippet = '';
    let raw: unknown = { id };
    let url = `https://mail.google.com/mail/u/0/#all/${id}`;

    if (getTool) {
      const detail = await safeCallTool(mcpManager, getTool, { message_id: id });
      if (detail) {
        raw = parseJsonLoose(detail) || detail;
        const env = typeof raw === 'object' && raw ? (raw as Record<string, unknown>) : null;
        if (typeof env?.title === 'string' && env.title.trim()) subject = env.title.trim();
        if (typeof env?.summary === 'string' && env.summary.trim()) {
          const summaryLine = env.summary.trim();
          const fromPart = summaryLine.match(/From:\s*([^|]+)/i)?.[1]?.trim();
          if (fromPart) from = fromPart;
          snippet = summaryLine;
        }
        const detailBody = typeof env?.body === 'string' ? env.body : detail;
        if (!from) {
          from = detailBody.match(/From:\s*(.+)/i)?.[1]?.trim() || '';
        }
        if (!snippet || snippet === subject) {
          snippet =
            (typeof env?.summary === 'string' ? env.summary : detailBody)
              .split('\n')
              .map((l) => l.trim())
              .find((l) => l.length > 12) || '';
        }
        url = extractUrl(detail) || url;
      }
    }

    const blob = `${subject}\n${snippet}\n${from}`;
    if (!looksLikeActionNeeded(blob)) continue;

    signals.push(
      signal({
        fingerprint: `gmail:msg:${id}`,
        source: 'gmail',
        title: subject,
        summary:
          [from && `From ${from}`, snippet && snippet !== subject ? snippet : '']
            .filter(Boolean)
            .join(' — ')
            .slice(0, 400) || 'Email needs your action',
        raw,
        severityHint: /urgent|asap|action required|blocked|overdue/i.test(blob)
          ? 'warning'
          : 'signal',
        orbitHint: 'today',
        categoryHint: 'comms',
        whyHint: 'This email asks you to reply, approve, or take an action.',
        suggestedAction: 'Open in Gmail and complete the ask.',
        sourceRef: {
          connectorId: DEFAULT_GMAIL_MCP_SERVER_ID,
          externalId: id,
          label: 'Gmail',
          url,
        },
        muteKeys: [`gmail:msg:${id}`, 'source:gmail'],
      })
    );
  }

  return signals;
}

// ── Jira: one signal per issue ──────────────────────────────────────────────

function extractJiraIssues(text: string): Array<Record<string, unknown>> {
  const parsed = parseJsonLoose(text);
  const bag: unknown[] = [];
  const walk = (node: unknown, depth = 0) => {
    if (!node || depth > 6) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    if (typeof node === 'object') {
      const obj = node as Record<string, unknown>;
      if (typeof obj.key === 'string' && /^[A-Z][A-Z0-9]+-\d+$/i.test(obj.key)) {
        bag.push(obj);
        return;
      }
      for (const v of Object.values(obj)) walk(v, depth + 1);
    }
  };
  walk(parsed);
  if (bag.length) return bag as Array<Record<string, unknown>>;

  // Plain-text keys: PROJ-123 Title
  const issues: Array<Record<string, unknown>> = [];
  for (const line of text.split('\n')) {
    const m = line.match(/\b([A-Z][A-Z0-9]+-\d+)\b\s*[:-]?\s*(.*)$/i);
    if (m) issues.push({ key: m[1].toUpperCase(), summary: m[2]?.trim() || m[1] });
  }
  return issues;
}

async function collectJira(
  mcpManager: MCPManager,
  profile: WelcomeProfile | null
): Promise<RawMatterSignal[]> {
  const tool = findToolName(mcpManager, DEFAULT_JIRA_MCP_SERVER_ID, [
    'searchJiraIssuesUsingJql',
    'search',
    'jql_search',
  ]);
  if (!tool) return [];

  const email = profile?.email || '';
  // Only work that still needs the assignee's action — not a full backlog dump.
  const jql = email
    ? `assignee = "${email}" AND statusCategory != Done AND (statusCategory = "To Do" OR status ~ "Block" OR priority in (Highest, High) OR updated >= -3d) ORDER BY priority DESC, updated DESC`
    : 'assignee = currentUser() AND statusCategory != Done AND (statusCategory = "To Do" OR status ~ "Block" OR priority in (Highest, High) OR updated >= -3d) ORDER BY priority DESC, updated DESC';

  const text = await safeCallTool(mcpManager, tool, {
    jql,
    maxResults: 10,
    fields: ['summary', 'status', 'priority', 'updated', 'issuetype'],
  });
  if (!text) return [];

  const issues = extractJiraIssues(text).slice(0, MAX_PER_SOURCE);
  return issues
    .map((issue) => {
      const key = String(issue.key || '');
      const fields =
        issue.fields && typeof issue.fields === 'object'
          ? (issue.fields as Record<string, unknown>)
          : issue;
      const summary =
        (typeof fields.summary === 'string' && fields.summary) ||
        (typeof issue.summary === 'string' && issue.summary) ||
        key;
      const statusObj = fields.status as { name?: string } | string | undefined;
      const status =
        typeof statusObj === 'string' ? statusObj : statusObj?.name || String(fields.status || '');
      const priorityObj = fields.priority as { name?: string } | string | undefined;
      const priority =
        typeof priorityObj === 'string'
          ? priorityObj
          : priorityObj?.name || String(fields.priority || '');
      const critical = /highest|blocker|critical|p0|p1/i.test(priority) || /block/i.test(status);
      // Skip parked / waiting-on-others if language is clear
      if (/waiting for|deferred|icebox|backlog/i.test(status) && !critical) return null;
      // Never use REST `self` links — they open the API, not the board.
      const self =
        typeof issue.self === 'string'
          ? issue.self
          : typeof (fields as { self?: unknown }).self === 'string'
            ? ((fields as { self: string }).self as string)
            : undefined;
      const siteOrigin = (self && jiraSiteOriginFromUrl(self)) || DEFAULT_JIRA_SITE_ORIGIN;
      const browse = key ? jiraBrowseUrl(key, siteOrigin) : undefined;

      return signal({
        fingerprint: `jira:issue:${key}`,
        source: 'jira',
        title: `${key}: ${summary}`,
        summary: [status && `Status: ${status}`, priority && `Priority: ${priority}`]
          .filter(Boolean)
          .join(' · '),
        raw: issue,
        severityHint: critical ? 'critical' : 'warning',
        orbitHint: critical ? 'now' : 'today',
        categoryHint: 'delivery',
        whyHint: 'Assigned to you and still needs your next move.',
        suggestedAction: 'Update status, unblock, or complete the next step.',
        sourceRef: {
          connectorId: DEFAULT_JIRA_MCP_SERVER_ID,
          externalId: key,
          label: 'Jira',
          url: browse,
        },
        muteKeys: [`jira:${key}`, 'source:jira'],
      });
    })
    .filter((s): s is RawMatterSignal => !!s);
}

// ── Hub: only pending requests that need the user (not OOO awareness) ───────

async function collectHub(
  mcpManager: MCPManager,
  profile: WelcomeProfile | null
): Promise<RawMatterSignal[]> {
  const signals: RawMatterSignal[] = [];
  const reqTool = findToolName(mcpManager, DEFAULT_HUB_MCP_SERVER_ID, [
    'list_pending_hub_requests',
    'list_hub_requests',
  ]);
  if (reqTool) {
    const text = await safeCallTool(mcpManager, reqTool, {});
    if (text) {
      const lines = envelopeBody(text)
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 8 && l.length < 160)
        .slice(0, 5);
      for (const line of lines) {
        if (looksLikeJunkTitle(line)) continue;
        if (/^No pending|none|0 request/i.test(line)) continue;
        signals.push(
          signal({
            fingerprint: hubRequestFingerprint(line),
            source: 'hub',
            title: humanTitle(line, 'Hub request'),
            summary: 'Pending Hub request waiting on you',
            raw: line,
            severityHint: 'warning',
            orbitHint: 'today',
            categoryHint: 'people',
            whyHint: 'A Hub request needs your approve / reject / follow-up.',
            suggestedAction: 'Open Hub and act on the request.',
            sourceRef: { connectorId: DEFAULT_HUB_MCP_SERVER_ID, label: 'Hub' },
            muteKeys: ['source:hub'],
          })
        );
      }
    }
  }

  void profile;
  return signals.slice(0, MAX_PER_SOURCE);
}

// ── Launchpad: one signal per release/feature entity ────────────────────────

function extractLaunchpadEntities(
  text: string
): Array<{
  title: string;
  summary: string;
  raw: unknown;
  risky: boolean;
  stableName: string;
}> {
  const parsed = parseJsonLoose(text);
  const items: Array<{
    title: string;
    summary: string;
    raw: unknown;
    risky: boolean;
    stableName: string;
  }> = [];
  const seen = new Set<string>();

  const pushEntity = (
    stableName: string,
    title: string,
    summary: string,
    raw: unknown,
    risky: boolean
  ) => {
    const cleanName = humanTitle(stableName, '');
    if (!cleanName || looksLikeJunkTitle(cleanName)) return;
    const externalId = extractLaunchpadEntityId(raw);
    const key = (externalId || cleanName).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    items.push({
      title: humanTitle(title, cleanName),
      summary: cleanDisplayText(summary).slice(0, 280),
      raw,
      risky,
      stableName: cleanName,
    });
  };

  const walk = (node: unknown, depth = 0) => {
    if (!node || depth > 8 || items.length >= MAX_PER_SOURCE) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    if (typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;

    // Skip Zod / schema validation noise objects
    if (
      ('expected' in obj && 'received' in obj) ||
      (typeof obj.message === 'string' &&
        /expected number|received nan|invalid_type/i.test(obj.message) &&
        !pickString(obj, ['name', 'title', 'version']))
    ) {
      return;
    }

    const name = pickString(obj, [
      'name',
      'title',
      'label',
      'version',
      'releaseName',
      'featureName',
      'projectName',
      'displayName',
    ]);
    const status = pickString(obj, ['status', 'state', 'phase', 'health']);
    const summary = pickString(obj, ['summary', 'description', 'message', 'notes']);
    const looksEntity =
      !!name &&
      ('id' in obj ||
        'status' in obj ||
        'state' in obj ||
        'releaseDate' in obj ||
        'projectId' in obj ||
        'version' in obj ||
        'features' in obj);

    if (looksEntity) {
      pushEntity(
        name,
        status ? `${name} — ${status}` : name,
        summary || status || 'Launchpad delivery item',
        obj,
        /risk|block|fail|crit|error|overdue|nan/i.test(`${status} ${summary} ${name}`)
      );
      return; // don't explode nested fields into titles
    }

    for (const value of Object.values(obj)) walk(value, depth + 1);
  };

  walk(parsed);
  if (items.length) return items.slice(0, MAX_PER_SOURCE);

  // Fallback: only human-readable lines (never JSON keys)
  const body = envelopeBody(text);
  for (const line of body.split('\n')) {
    const trimmed = line.replace(/^[-*•]\s*/, '').trim();
    if (looksLikeJunkTitle(trimmed) || trimmed.length < 8 || trimmed.length > 140) continue;
    if (/^Error|Found \d|No /i.test(trimmed)) continue;
    pushEntity(
      trimmed,
      trimmed,
      'Launchpad delivery item',
      trimmed,
      /risk|block|fail|crit|overdue/i.test(trimmed)
    );
    if (items.length >= MAX_PER_SOURCE) break;
  }
  return items;
}

async function collectLaunchpad(mcpManager: MCPManager): Promise<RawMatterSignal[]> {
  const tool = findToolName(mcpManager, DEFAULT_LAUNCHPAD_MCP_SERVER_ID, [
    'list_releases',
    'get_active_release',
    'list_features',
    'get_release',
  ]);
  if (!tool) return [];
  const text = await safeCallTool(mcpManager, tool, {});
  if (!text) return [];

  const entities = extractLaunchpadEntities(text).filter((e) => e.risky);
  if (!entities.length) {
    return [];
  }

  return entities.map((entity) =>
    signal({
      fingerprint: launchpadItemFingerprint({
        stableName: entity.stableName,
        raw: entity.raw,
      }),
      source: 'launchpad',
      title: entity.title,
      summary: entity.summary || 'Launchpad delivery item',
      raw: entity.raw,
      severityHint: entity.risky ? 'warning' : 'signal',
      orbitHint: 'today',
      categoryHint: 'delivery',
      whyHint: 'Delivery item from R&D Launchpad.',
      suggestedAction: 'Check status in Launchpad.',
      sourceRef: {
        connectorId: DEFAULT_LAUNCHPAD_MCP_SERVER_ID,
        label: 'Launchpad',
        url: extractUrl(truncate(entity.raw)),
      },
      muteKeys: ['source:launchpad'],
    })
  );
}

// ── Meetings: one signal per open action item ───────────────────────────────

function collectMeetings(meetingService: MeetingService | null): RawMatterSignal[] {
  if (!meetingService) return [];
  try {
    const listed = meetingService.list().slice(0, 12);
    const signals: RawMatterSignal[] = [];
    for (const item of listed) {
      const meeting = meetingService.get(item.id);
      const actions = meeting?.notes?.actionItems || [];
      if (!meeting || actions.length === 0) continue;
      for (const action of actions.slice(0, 4)) {
        const text = String(action).trim();
        if (!text) continue;
        signals.push(
          signal({
            fingerprint: `meeting:action:${meeting.id}:${hashKey(text)}`,
            source: 'meeting',
            title: text.slice(0, 140),
            summary: `From meeting: ${meeting.title || 'Untitled'}`,
            raw: {
              meetingId: meeting.id,
              title: meeting.title,
              action: text,
              summary: meeting.notes?.summary,
            },
            severityHint: 'warning',
            orbitHint: 'today',
            categoryHint: 'time',
            whyHint: 'Open action from a captured meeting.',
            suggestedAction: 'Complete, delegate, or dismiss this action.',
            sourceRef: {
              externalId: meeting.id,
              label: meeting.title || 'Meeting',
            },
            muteKeys: [`meeting:${meeting.id}`, 'source:meeting'],
          })
        );
        if (signals.length >= MAX_PER_SOURCE) return signals;
      }
    }
    return signals;
  } catch (error) {
    logWarn('[Matter] Meeting collect failed:', error);
    return [];
  }
}

function fuseConflicts(signals: RawMatterSignal[]): RawMatterSignal[] {
  const calSoon = signals.find(
    (s) => s.source === 'calendar' && (s.orbitHint === 'now' || s.severityHint === 'critical')
  );
  const jiraCrit = signals.find((s) => s.source === 'jira' && s.severityHint === 'critical');
  if (!calSoon || !jiraCrit) return signals;
  return [
    ...signals,
    signal({
      fingerprint: `fused:${calSoon.fingerprint}:${jiraCrit.fingerprint}`,
      source: 'fused',
      title: `Conflict: ${calSoon.title} vs ${jiraCrit.title.split(':')[0]}`,
      summary: `Upcoming "${calSoon.title}" overlaps critical issue ${jiraCrit.title}.`,
      raw: { calendar: calSoon, jira: jiraCrit },
      severityHint: 'critical',
      orbitHint: 'now',
      categoryHint: 'delivery',
      whyHint: 'A hard calendar commitment collides with a critical delivery blocker.',
      suggestedAction: 'Protect a focus block or renegotiate the meeting.',
      sourceRef: { label: 'Fused signal' },
      muteKeys: ['fused:calendar-jira'],
    }),
  ];
}

const SOURCE_SERVER: Record<MatterConfigurableSource, string | null> = {
  calendar: DEFAULT_GOOGLE_CALENDAR_MCP_SERVER_ID,
  slack: DEFAULT_SLACK_MCP_SERVER_ID,
  gmail: DEFAULT_GMAIL_MCP_SERVER_ID,
  jira: DEFAULT_JIRA_MCP_SERVER_ID,
  hub: DEFAULT_HUB_MCP_SERVER_ID,
  meeting: null,
  launchpad: DEFAULT_LAUNCHPAD_MCP_SERVER_ID,
};

/** MCP server ids required by currently enabled Matter sources (excludes meetings). */
export function getEnabledMatterServerIds(sources: MatterSourcesConfig): string[] {
  const ids: string[] = [];
  for (const key of Object.keys(sources) as MatterConfigurableSource[]) {
    if (!sources[key]) continue;
    const serverId = SOURCE_SERVER[key];
    if (serverId) ids.push(serverId);
  }
  return ids;
}

export async function collectMatterSignals(options: {
  mcpManager: MCPManager | null;
  meetingService: MeetingService | null;
  profile: WelcomeProfile | null;
  sources: MatterSourcesConfig;
}): Promise<CollectSignalsResult> {
  const { mcpManager, meetingService, profile, sources } = options;
  const sourcesChecked: string[] = [];
  const sourcesSkipped: string[] = [];
  const signals: RawMatterSignal[] = [];

  const run = async (
    key: MatterConfigurableSource,
    fn: () => Promise<RawMatterSignal[]> | RawMatterSignal[]
  ) => {
    if (!sources[key]) {
      sourcesSkipped.push(key);
      return;
    }
    const serverId = SOURCE_SERVER[key];
    if (serverId && (!mcpManager || !isServerConnected(mcpManager, serverId))) {
      sourcesSkipped.push(key);
      return;
    }
    if (key === 'meeting' && !meetingService) {
      sourcesSkipped.push(key);
      return;
    }
    try {
      const batch = await fn();
      if (batch.length) {
        sourcesChecked.push(key);
        signals.push(...batch);
      } else {
        sourcesChecked.push(key);
      }
    } catch (error) {
      logWarn(`[Matter] Source ${key} failed:`, error);
      sourcesSkipped.push(key);
    }
  };

  if (!mcpManager) {
    for (const key of Object.keys(sources) as MatterConfigurableSource[]) {
      if (key !== 'meeting') sourcesSkipped.push(key);
    }
  } else {
    await Promise.all([
      run('calendar', () => collectCalendar(mcpManager, profile, meetingService)),
      run('slack', () => collectSlack(mcpManager, profile)),
      run('gmail', () => collectGmail(mcpManager, profile)),
      run('jira', () => collectJira(mcpManager, profile)),
      run('hub', () => collectHub(mcpManager, profile)),
      run('launchpad', () => collectLaunchpad(mcpManager)),
    ]);
  }

  await run('meeting', () => collectMeetings(meetingService));

  const fused = fuseConflicts(signals);
  log(
    `[Matter] Collected ${fused.length} specific signals (checked=${sourcesChecked.join(',') || 'none'}; skipped=${sourcesSkipped.join(',') || 'none'})`
  );
  return { signals: fused, sourcesChecked, sourcesSkipped };
}
