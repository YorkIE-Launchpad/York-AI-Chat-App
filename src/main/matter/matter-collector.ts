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
import { formatMeetingWhen } from '../../shared/matter-time';
import type { MCPManager } from '../mcp/mcp-manager';
import type { MeetingService } from '../meetings/meeting-service';
import { log, logWarn } from '../utils/logger';
import {
  DEFAULT_GMAIL_MCP_SERVER_ID,
  DEFAULT_GOOGLE_CALENDAR_MCP_SERVER_ID,
  DEFAULT_HUB_MCP_NAME,
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
  parseEventAttendees,
  parseSlackSearchBody,
  type ParsedSlackSearchMessage,
} from './matter-calendar-enrichment';

export {
  MEETING_PREP_MARKER,
  isVagueMeetingTitle,
  parseEventAttendees,
  parseSlackSearchBody,
  buildEnrichedMeetingTitle,
  buildMeetingPrepNote,
  enrichCalendarMeeting,
} from './matter-calendar-enrichment';
export type { ParsedSlackSearchMessage } from './matter-calendar-enrichment';

export { calendarOrbitSeverity } from '../../shared/matter-time';

const MAX_PER_SOURCE = 12;
/** Upcoming calendar meetings for the week (Noise filters apply separately). */
const MAX_CALENDAR_PER_SCAN = 25;
/** Slack unreads: cap per bucket so other Matter sources still get radar slots. */
const MAX_SLACK_DMS_PER_SCAN = 8;
const MAX_SLACK_CHANNELS_PER_SCAN = 6;
const SLACK_SEARCH_LIMIT = 20;
/** Hub inboxes (kudos, drafts, approvals, announcements) share this cap. */
const MAX_HUB_PER_SCAN = 16;
const HUB_ENVELOPE_STATUS_TEXT = /^(ok|okay|success|true|done|created|updated)$/i;
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

const SLACK_EMOJI: Record<string, string> = {
  clipboard: '📋',
  calendar: '📅',
  email: '✉️',
  warning: '⚠️',
  fire: '🔥',
  tada: '🎉',
  eyes: '👀',
  wave: '👋',
  thumbsup: '👍',
  '+1': '👍',
  white_check_mark: '✅',
  x: '❌',
  slack: '💬',
};

function cleanDisplayText(text: string): string {
  return text
    .replace(/<@([A-Z0-9]+)>/gi, '@user')
    .replace(/<#([A-Z0-9]+)(?:\|([^>]+))?>/gi, (_m, _id, name) => (name ? `#${name}` : '#channel'))
    .replace(/<(https?:[^|>]+)(?:\|([^>]+))?>/gi, (_m, url, label) => label || url)
    .replace(/:([a-z0-9_+-]+):/gi, (_m, name: string) => SLACK_EMOJI[name.toLowerCase()] || '')
    .replace(/\b[UWCGD][A-Z0-9]{8,}\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Slack user/channel IDs that must never appear in Matter titles. */
export function isSlackOpaqueId(value: string): boolean {
  return /^[UWCGD][A-Z0-9]{8,}$/i.test(value.trim());
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

export interface HubInboxRecord {
  id: string | null;
  title: string;
  summary: string;
  unread: boolean;
  raw: unknown;
}

function hubRecordIsRead(obj: Record<string, unknown>): boolean {
  if (obj.read === true || obj.isRead === true || obj.is_read === true || obj.seen === true) {
    return true;
  }
  if (obj.unread === false || obj.isUnread === false || obj.is_unread === false) {
    return true;
  }
  const status = pickString(obj, ['status', 'state', 'readStatus', 'read_status']);
  return Boolean(status && /^(read|seen|dismissed|archived)$/i.test(status));
}

function isEnvelopeStatusText(text: string): boolean {
  return HUB_ENVELOPE_STATUS_TEXT.test(text.trim());
}

function isHubApiEnvelope(obj: Record<string, unknown>): boolean {
  return 'data' in obj && ('success' in obj || 'statusCode' in obj || 'timestamp' in obj);
}

function looksLikeHubServerName(name: string): boolean {
  const key = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  return (
    key === 'hub' ||
    key === 'yorkiehub' ||
    name.trim().toLowerCase() === DEFAULT_HUB_MCP_NAME.toLowerCase()
  );
}

/** Connected Hub MCP id — default catalog id or a migrated connector with the Hub name. */
export function resolveHubServerId(mcpManager: MCPManager): string | null {
  try {
    const connected = mcpManager.getServerStatus().filter((s) => s.connected);
    const exact = connected.find((s) => s.id === DEFAULT_HUB_MCP_SERVER_ID);
    if (exact) return exact.id;
    const named = connected.find((s) => looksLikeHubServerName(s.name));
    if (named) return named.id;
  } catch {
    /* ignore */
  }
  return null;
}

function unwrapHubSource(parsed: unknown): unknown {
  if (!parsed || typeof parsed !== 'object') return parsed;
  const obj = parsed as Record<string, unknown>;
  if ('body' in obj) {
    const body = obj.body;
    if (typeof body === 'string') {
      const nested = parseJsonLoose(body);
      return nested != null ? unwrapHubSource(nested) : body;
    }
    if (body != null) return unwrapHubSource(body);
  }
  if (
    'data' in obj &&
    obj.data != null &&
    ('success' in obj || 'statusCode' in obj || 'timestamp' in obj)
  ) {
    return unwrapHubSource(obj.data);
  }
  if (!Array.isArray(obj)) {
    for (const key of [
      'items',
      'results',
      'notifications',
      'kudos',
      'announcements',
      'requests',
      'timesheets',
      'drafts',
      'leaveRequests',
    ]) {
      if (Array.isArray(obj[key])) return obj[key];
    }
  }
  return parsed;
}

function synthesizeHubTitle(obj: Record<string, unknown>, fallback: string): string {
  const explicit = pickString(obj, ['title', 'subject', 'headline', 'name']);
  if (explicit && !looksLikeJunkTitle(explicit) && !isEnvelopeStatusText(explicit)) {
    return humanTitle(explicit, fallback);
  }
  const employee = pickString(obj, [
    'employee_name',
    'employeeName',
    'employee',
    'sender_name',
    'senderName',
    'from_name',
    'fromName',
    'author_name',
    'authorName',
  ]);
  const leaveType = pickString(obj, ['leaveType', 'leave_type', 'wfhType', 'wfh_type']);
  const type = pickString(obj, ['type', 'kind', 'category']);
  const status = pickString(obj, ['status', 'state']);
  const week = pickString(obj, ['week', 'week_start', 'weekStart', 'period', 'weekOf']);
  const message = pickString(obj, ['message', 'description', 'body', 'comment']);
  const senderEmail = pickString(obj, ['sender_email', 'senderEmail', 'from']);

  if (
    leaveType ||
    /^(SICK|PRIVILEGE|MATERNITY|PATERNITY|UNPAID|FESTIVAL|FLOATING_VACATION)$/i.test(type)
  ) {
    const kind = leaveType || type;
    const who = employee || 'Teammate';
    return humanTitle(`${who} — ${kind} leave pending`, fallback);
  }
  if (week && status) {
    const who = employee ? `${employee} — ` : '';
    return humanTitle(`${who}Timesheet ${status} (${week})`, fallback);
  }
  if (employee && status && /draft|submitted|pending|review/i.test(status)) {
    return humanTitle(`${employee} — timesheet ${status}`, fallback);
  }
  if (employee || senderEmail) {
    const who = employee || senderEmail;
    if (message && !isEnvelopeStatusText(message)) {
      return humanTitle(`${who} sent kudos`, fallback);
    }
    if (status) return humanTitle(`${who} — ${status}`, fallback);
  }
  if (message && !isEnvelopeStatusText(message) && !looksLikeJunkTitle(message)) {
    return humanTitle(message, fallback);
  }
  if (type && !isEnvelopeStatusText(type) && !looksLikeJunkTitle(type)) {
    return humanTitle(type, fallback);
  }
  return fallback;
}

function looksLikeHubInboxRecord(obj: Record<string, unknown>): boolean {
  if (isHubApiEnvelope(obj)) return false;
  const id = pickString(obj, [
    'id',
    'notificationId',
    'notification_id',
    'requestId',
    'request_id',
    'uuid',
    'kudosId',
    'kudos_id',
    'timesheetId',
  ]);
  const title = pickString(obj, ['title', 'subject', 'headline', 'name']);
  const message = pickString(obj, ['message', 'body', 'description']);
  const employee = pickString(obj, [
    'employee_name',
    'employeeName',
    'employee',
    'employee_email',
    'employeeEmail',
    'sender_name',
    'senderName',
    'sender_email',
  ]);
  const leaveType = pickString(obj, ['leaveType', 'leave_type']);
  const status = pickString(obj, ['status', 'state']);
  const type = pickString(obj, ['type', 'kind', 'category']);
  const week = pickString(obj, ['week', 'week_start', 'weekStart']);

  if (title && !isEnvelopeStatusText(title) && (id || message || employee || status)) return true;
  if (employee && (leaveType || status || id || type)) return true;
  if (leaveType && (id || status || employee)) return true;
  if (id && (status || message || type || week)) return true;
  if (week && status) return true;
  if (message && !isEnvelopeStatusText(message) && (id || employee || type)) return true;
  return false;
}

function collectHubObjects(node: unknown, out: Record<string, unknown>[], depth = 0): void {
  if (!node || depth > 6 || out.length >= 40) return;
  if (Array.isArray(node)) {
    for (const item of node) collectHubObjects(item, out, depth + 1);
    return;
  }
  if (typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  if (isHubApiEnvelope(obj)) {
    for (const value of Object.values(obj)) collectHubObjects(value, out, depth + 1);
    return;
  }
  if (looksLikeHubInboxRecord(obj)) {
    out.push(obj);
    return;
  }
  for (const value of Object.values(obj)) collectHubObjects(value, out, depth + 1);
}

/** Parse Hub MCP envelope/JSON/line output into one record per notification or inbox item. */
export function extractHubInboxRecords(text: string): HubInboxRecord[] {
  const parsed = parseJsonLoose(text);
  const source = parsed != null ? unwrapHubSource(parsed) : parsed;

  const objects: Record<string, unknown>[] = [];
  if (typeof source !== 'string') {
    collectHubObjects(source, objects);
  }
  if (objects.length) {
    return objects.map((obj) => {
      const title = synthesizeHubTitle(obj, 'Hub notification');
      const summary =
        pickString(obj, [
          'summary',
          'description',
          'body',
          'message',
          'status',
          'employee_name',
          'employeeName',
        ]) || title;
      const id =
        pickString(obj, [
          'id',
          'notificationId',
          'notification_id',
          'requestId',
          'request_id',
          'uuid',
          'kudosId',
          'kudos_id',
          'timesheetId',
        ]) || extractHubRequestId(title);
      return {
        id,
        title,
        summary: cleanDisplayText(summary).slice(0, 280),
        unread: !hubRecordIsRead(obj),
        raw: obj,
      };
    });
  }

  const body = typeof source === 'string' ? source : envelopeBody(text);
  const records: HubInboxRecord[] = [];
  for (const line of body.split('\n')) {
    const trimmed = line.replace(/^[-*•]\s*/, '').trim();
    if (looksLikeJunkTitle(trimmed) || trimmed.length < 8 || trimmed.length > 180) continue;
    if (/^No (pending|notifications?|announcements?|requests?)|none|0 request/i.test(trimmed)) {
      continue;
    }
    records.push({
      id: extractHubRequestId(trimmed),
      title: humanTitle(trimmed, 'Hub notification'),
      summary: trimmed,
      unread: true,
      raw: trimmed,
    });
  }
  return records;
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

export function launchpadItemFingerprint(input: { stableName: string; raw: unknown }): string {
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

function formatAttendeeSummary(detailBody: string): string | null {
  const attendees = parseEventAttendees(detailBody);
  if (!attendees.length) return null;
  const names = attendees
    .map((a) => (a.name && !a.name.includes('@') ? a.name.split(/\s+/)[0] : a.name || a.email))
    .filter(Boolean);
  if (!names.length) return null;
  const shown = names.slice(0, 4);
  const extra = names.length > 4 ? ` +${names.length - 4}` : '';
  return `w/ ${shown.join(', ')}${extra}`;
}

export interface CalendarMeetingDraft {
  fingerprint: string;
  eventId: string;
  title: string;
  when: string;
  startMs: number | null;
  endMs: number | null;
  summary: string;
  htmlLink: string | null;
  rawDetails: string | null;
  suggestedAction: string | null;
}

type StructuredCalendarListEvent = {
  id?: unknown;
  title?: unknown;
  when?: unknown;
  start?: unknown;
  end?: unknown;
  htmlLink?: unknown;
  attendeesLine?: unknown;
  recurrence?: unknown;
  recurringEventId?: unknown;
};

function parseStructuredCalendarEvents(text: string): StructuredCalendarListEvent[] | null {
  const parsed = parseJsonLoose(text);
  if (!parsed || typeof parsed !== 'object') return null;
  const events = (parsed as { events?: unknown }).events;
  if (!Array.isArray(events) || events.length === 0) return null;
  return events as StructuredCalendarListEvent[];
}

function draftFromCalendarFields(input: {
  id: string;
  title: string;
  when: string;
  startIso?: string;
  endIso?: string;
  htmlLink?: string | null;
  detailBody?: string;
}): CalendarMeetingDraft | null {
  const startMs =
    parseIsoMs(input.startIso) ?? parseIsoMs(input.when.split('→')[0]?.trim()) ?? null;
  const endMs =
    parseIsoMs(input.endIso) ??
    (() => {
      const parts = input.when.split('→');
      if (parts.length >= 2) return parseIsoMs(parts[1]?.trim()) ?? null;
      return null;
    })();
  const hoursUntil = startMs != null ? (startMs - Date.now()) / 36e5 : 999;
  if (hoursUntil < -0.25) return null;
  if (isPersonalCalendarHold(input.title)) return null;
  const rawText = input.detailBody || '';
  if (isDailySeriesMeeting(input.title, rawText)) return null;
  if (isAllDayCalendarEvent(input.when, rawText)) return null;

  const attendeeLine = formatAttendeeSummary(rawText);
  const whenLabel = formatMeetingWhen(startMs, endMs, input.when);
  const summary = [whenLabel, attendeeLine].filter(Boolean).join(' · ');

  return {
    fingerprint: `calendar:event:${input.id}`,
    eventId: input.id,
    title: input.title,
    when: whenLabel,
    startMs,
    endMs,
    summary,
    htmlLink: input.htmlLink?.trim() || null,
    rawDetails: rawText || null,
    suggestedAction: 'Click Prep to gather Slack, email, and related context.',
  };
}

/**
 * Fetch upcoming Google Calendar meetings for the Matter Calendar panel.
 * Not radar signals — peer list with its own refresh cadence.
 *
 * Uses a single list_events call (structured `events` when available). Avoids
 * fan-out get_event calls that blocked the Matter UI during refresh.
 */
export async function collectCalendarMeetings(
  mcpManager: MCPManager
): Promise<CalendarMeetingDraft[]> {
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
    limit: 40,
  });
  if (!text) return [];

  const structured = parseStructuredCalendarEvents(text);
  if (structured) {
    const drafts = structured
      .map((ev): CalendarMeetingDraft | null => {
        const id = typeof ev.id === 'string' ? ev.id.trim() : '';
        const title = typeof ev.title === 'string' ? ev.title.trim() : '';
        if (!id || !title) return null;
        const when = typeof ev.when === 'string' ? ev.when.trim() : '';
        const start = typeof ev.start === 'string' ? ev.start.trim() : '';
        const end = typeof ev.end === 'string' ? ev.end.trim() : '';
        const htmlLink = typeof ev.htmlLink === 'string' ? ev.htmlLink : null;
        const attendeesLine = typeof ev.attendeesLine === 'string' ? ev.attendeesLine : '';
        const recurrence = Array.isArray(ev.recurrence)
          ? ev.recurrence.filter((r): r is string => typeof r === 'string')
          : [];
        const recurringEventId =
          typeof ev.recurringEventId === 'string' ? ev.recurringEventId.trim() : '';
        const detailBody = [
          when ? `${title} (${when})` : title,
          htmlLink ? `Link: ${htmlLink}` : '',
          attendeesLine,
          recurringEventId ? `RecurringEventId: ${recurringEventId}` : '',
          recurrence.length ? `Recurrence:\n${recurrence.join('\n')}` : '',
        ]
          .filter(Boolean)
          .join('\n\n');
        return draftFromCalendarFields({
          id,
          title,
          when: when || [start, end].filter(Boolean).join(' → '),
          startIso: start || undefined,
          endIso: end || undefined,
          htmlLink,
          detailBody,
        });
      })
      .filter((d): d is CalendarMeetingDraft => !!d);
    return drafts.slice(0, MAX_CALENDAR_PER_SCAN);
  }

  // Fallback for connectors that only return line summaries (no structured events).
  const body = envelopeBody(text);
  const events = parseCalendarLines(body).slice(0, 40);
  if (!events.length) return [];

  const drafts = events
    .map((ev) =>
      draftFromCalendarFields({
        id: ev.id,
        title: ev.title,
        when: ev.when,
        startIso: ev.when.split('→')[0]?.trim(),
        endIso: ev.when.split('→')[1]?.trim(),
      })
    )
    .filter((d): d is CalendarMeetingDraft => !!d);

  return drafts.slice(0, MAX_CALENDAR_PER_SCAN);
}

// ── Slack: one signal per unread DM / channel message ───────────────────────

function slackMessageToSignal(msg: ParsedSlackSearchMessage): RawMatterSignal {
  const isDm = /^D/i.test(msg.channel);
  const label = (msg.channelLabel || '').trim();
  const place = isDm
    ? label && !isSlackOpaqueId(label) && !/^D/i.test(label)
      ? `DM with ${label}`
      : 'DM'
    : label && !isSlackOpaqueId(label)
      ? `#${label}`
      : '#channel';
  const userLabel = !msg.user || isSlackOpaqueId(msg.user) ? 'Someone' : msg.user;
  const preview = cleanDisplayText(msg.text).slice(0, 100) || '(no text)';
  const title = humanTitle(`${userLabel} in ${place}: ${preview}`, 'Slack unread');
  return signal({
    fingerprint: `slack:msg:${msg.channel}:${msg.ts}`,
    source: 'slack',
    title,
    summary: cleanDisplayText(msg.text).slice(0, 280) || `Unread from ${userLabel}`,
    raw: msg,
    severityHint: 'signal',
    orbitHint: 'today',
    categoryHint: 'comms',
    whyHint: 'Unread Slack message — open or mark handled.',
    suggestedAction: 'Open in Slack or mark handled.',
    sourceRef: {
      connectorId: DEFAULT_SLACK_MCP_SERVER_ID,
      externalId: `${msg.channel}:${msg.ts}`,
      label: 'Slack',
      url: msg.link,
    },
    muteKeys: [`slack:channel:${msg.channel}`, 'source:slack'],
  });
}

function parseSlackUserDisplayName(text: string): string | null {
  const body = envelopeBody(text);
  const parsed = parseJsonLoose(body) ?? parseJsonLoose(text);
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  const profile =
    obj.profile && typeof obj.profile === 'object' ? (obj.profile as Record<string, unknown>) : {};
  const name =
    pickString(obj, ['real_name', 'display_name', 'name']) ||
    pickString(profile, ['display_name', 'real_name', 'name']);
  if (!name || isSlackOpaqueId(name)) return null;
  return name;
}

async function resolveSlackPeople(
  mcpManager: MCPManager,
  messages: ParsedSlackSearchMessage[]
): Promise<ParsedSlackSearchMessage[]> {
  const tool = findToolName(mcpManager, DEFAULT_SLACK_MCP_SERVER_ID, ['get_user']);
  const cache = new Map<string, string>();
  const resolve = async (value: string): Promise<string> => {
    const id = value.trim();
    if (!id || !/^[UW]/i.test(id) || !isSlackOpaqueId(id)) return value;
    if (cache.has(id)) return cache.get(id)!;
    if (!tool) {
      cache.set(id, id);
      return id;
    }
    const text = await safeCallTool(mcpManager, tool, { user_id: id });
    const name = text ? parseSlackUserDisplayName(text) : null;
    const resolved = name || id;
    cache.set(id, resolved);
    return resolved;
  };
  const out: ParsedSlackSearchMessage[] = [];
  for (const msg of messages) {
    out.push({
      ...msg,
      channelLabel: await resolve(msg.channelLabel),
      user: await resolve(msg.user),
    });
  }
  return out;
}

async function collectSlack(mcpManager: MCPManager): Promise<RawMatterSignal[]> {
  const tool = findToolName(mcpManager, DEFAULT_SLACK_MCP_SERVER_ID, [
    'search_messages',
    'search_public_and_private',
    'search_public',
    'conversations_history',
    'conversations_replies',
  ]);
  if (!tool) return [];

  const queries = ['is:unread is:dm', 'is:unread -is:dm'] as const;
  const seen = new Set<string>();
  const dms: ParsedSlackSearchMessage[] = [];
  const channels: ParsedSlackSearchMessage[] = [];

  for (const query of queries) {
    const text = await safeCallTool(mcpManager, tool, {
      query,
      limit: SLACK_SEARCH_LIMIT,
      sort: 'timestamp',
    });
    if (!text) continue;
    const bucket = query.includes('is:dm') && !query.includes('-is:dm') ? dms : channels;
    for (const msg of parseSlackSearchBody(envelopeBody(text))) {
      const key = `${msg.channel}:${msg.ts}`;
      if (seen.has(key)) continue;
      seen.add(key);
      bucket.push(msg);
    }
  }

  const messages = await resolveSlackPeople(mcpManager, [
    ...dms.slice(0, MAX_SLACK_DMS_PER_SCAN),
    ...channels.slice(0, MAX_SLACK_CHANNELS_PER_SCAN),
  ]);
  return messages.map(slackMessageToSignal);
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
    maxResults: 12,
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

// ── Hub: kudos, drafts, pending inboxes (approvals, requests, announcements) ─

type HubInboxKind =
  | 'kudos'
  | 'timesheet_draft'
  | 'leave'
  | 'timesheet'
  | 'request'
  | 'announcement';

function hubInboxFingerprint(kind: HubInboxKind, record: HubInboxRecord): string {
  if (record.id) return `hub:${kind}:${record.id}`;
  if (kind === 'request') return hubRequestFingerprint(record.title);
  return `hub:${kind}:${hashKey(normalizeMatterContentText(`${record.title}\n${record.summary}`))}`;
}

async function collectHubInbox(
  mcpManager: MCPManager,
  options: {
    serverId: string;
    kind: HubInboxKind;
    tools: string[];
    args?: Record<string, unknown>;
    category: MatterCategory;
    severity: MatterSeverity;
    orbitHint: MatterOrbit;
    whyHint: string;
    suggestedAction: string;
    limit: number;
    unreadOnly?: boolean;
  }
): Promise<RawMatterSignal[]> {
  const tool = findToolName(mcpManager, options.serverId, options.tools);
  if (!tool) return [];
  const text = await safeCallTool(mcpManager, tool, options.args || {});
  if (!text) return [];

  const records = extractHubInboxRecords(text).filter((record) => {
    if (options.unreadOnly && !record.unread) return false;
    return true;
  });

  return records.slice(0, options.limit).map((record) =>
    signal({
      fingerprint: hubInboxFingerprint(options.kind, record),
      source: 'hub',
      title: record.title,
      summary: record.summary || `Hub ${options.kind} waiting on you`,
      raw: record.raw,
      severityHint: options.severity,
      orbitHint: options.orbitHint,
      categoryHint: options.category,
      whyHint: options.whyHint,
      suggestedAction: options.suggestedAction,
      sourceRef: {
        connectorId: options.serverId,
        externalId: record.id,
        label: 'Hub',
        url: extractUrl(truncate(record.raw)),
      },
      muteKeys: [`hub:${options.kind}`, 'source:hub'],
    })
  );
}

async function collectHubKudos(
  mcpManager: MCPManager,
  serverId: string,
  email: string
): Promise<RawMatterSignal[]> {
  const shared = {
    serverId,
    kind: 'kudos' as const,
    category: 'people' as const,
    severity: 'signal' as const,
    orbitHint: 'week' as const,
    whyHint: 'Kudos received in Hub — open or acknowledge.',
    suggestedAction: 'Open Hub and view the kudos.',
    limit: 6,
  };
  if (email) {
    const received = await collectHubInbox(mcpManager, {
      ...shared,
      tools: ['list_employee_kudos'],
      args: { type: 'received', user_email: email },
    });
    if (received.length) return received;
  }
  const filtered = await collectHubInbox(mcpManager, {
    ...shared,
    tools: ['list_kudos'],
    args: email ? { recipient: email, limit: 8 } : { limit: 8 },
  });
  if (filtered.length || !email) return filtered;
  return collectHubInbox(mcpManager, {
    ...shared,
    tools: ['list_kudos'],
    args: { limit: 8 },
  });
}

async function collectHub(
  mcpManager: MCPManager,
  profile: WelcomeProfile | null
): Promise<RawMatterSignal[]> {
  const serverId = resolveHubServerId(mcpManager);
  if (!serverId) return [];
  const email = profile?.email || '';

  // Action inboxes first so the per-scan cap keeps drafts/approvals over kudos.
  // Do not call list_hub_requests here — product-feedback board, not an action inbox.
  const batches = await Promise.all([
    collectHubInbox(mcpManager, {
      serverId,
      kind: 'timesheet_draft',
      tools: ['list_my_timesheet_drafts'],
      args: { limit: 8 },
      category: 'admin',
      severity: 'warning',
      orbitHint: 'today',
      whyHint: 'Unsubmitted Hub timesheet draft waiting on you.',
      suggestedAction: 'Review and submit your timesheet in Hub.',
      limit: 6,
    }),
    collectHubInbox(mcpManager, {
      serverId,
      kind: 'leave',
      tools: ['list_pending_leave_wfh_requests', 'list_pending_wfh_requests'],
      args: { limit: 12 },
      category: 'people',
      severity: 'warning',
      orbitHint: 'today',
      whyHint: 'Leave or WFH request waiting on your approval.',
      suggestedAction: 'Approve or reject in Hub.',
      limit: 6,
    }),
    collectHubInbox(mcpManager, {
      serverId,
      kind: 'timesheet',
      tools: ['list_pending_timesheet_reviews'],
      args: { limit: 12 },
      category: 'admin',
      severity: 'warning',
      orbitHint: 'today',
      whyHint: 'Timesheet review waiting on you.',
      suggestedAction: 'Review and approve in Hub.',
      limit: 6,
    }),
    collectHubKudos(mcpManager, serverId, email),
    collectHubInbox(mcpManager, {
      serverId,
      kind: 'announcement',
      tools: ['list_announcements'],
      args: { limit: 8 },
      category: 'people',
      severity: 'signal',
      orbitHint: 'week',
      whyHint: 'Org announcement from Hub that may need your attention.',
      suggestedAction: 'Read the announcement in Hub.',
      limit: 4,
    }),
  ]);

  const seen = new Set<string>();
  const signals: RawMatterSignal[] = [];
  for (const batch of batches) {
    for (const item of batch) {
      if (seen.has(item.fingerprint)) continue;
      seen.add(item.fingerprint);
      signals.push(item);
      if (signals.length >= MAX_HUB_PER_SCAN) return signals;
    }
  }
  return signals;
}

// ── Launchpad: one signal per release/feature entity ────────────────────────

function extractLaunchpadEntities(text: string): Array<{
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
export function getEnabledMatterServerIds(
  sources: MatterSourcesConfig,
  mcpManager?: MCPManager | null
): string[] {
  const ids: string[] = [];
  for (const key of Object.keys(sources) as MatterConfigurableSource[]) {
    if (!sources[key]) continue;
    if (key === 'hub') {
      ids.push((mcpManager ? resolveHubServerId(mcpManager) : null) ?? DEFAULT_HUB_MCP_SERVER_ID);
      continue;
    }
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
    if (key === 'hub') {
      if (!mcpManager || !resolveHubServerId(mcpManager)) {
        sourcesSkipped.push(key);
        return;
      }
    } else {
      const serverId = SOURCE_SERVER[key];
      if (serverId && (!mcpManager || !isServerConnected(mcpManager, serverId))) {
        sourcesSkipped.push(key);
        return;
      }
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
      // Calendar is meetings-panel only — not a signal source.
      if (key !== 'meeting' && key !== 'calendar') sourcesSkipped.push(key);
    }
  } else {
    await Promise.all([
      run('slack', () => collectSlack(mcpManager)),
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
