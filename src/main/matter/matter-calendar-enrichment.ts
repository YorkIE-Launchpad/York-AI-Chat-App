/**
 * Calendar meeting helpers for Matter: vague-title detection, attendee /
 * Slack / Hub parsing, channel scoring, and the prep-note markers. The prep
 * pipeline itself lives in `./meeting-prep`.
 */

import type { MCPManager } from '../mcp/mcp-manager';
import type { MeetingService } from '../meetings/meeting-service';
import type { AppConfig } from '../config/config-store';
import { envelopeBody, extractUrl, parseJsonLoose } from './meeting-prep/connectors';
import { MEETING_PREP_MARKER } from '../../shared/matter';

export { MEETING_PREP_MARKER };

/** @deprecated Scan-time auto-enrich removed; kept for tests/compat. */
export const MAX_VAGUE_ENRICHMENTS_PER_SCAN = 0;

/** Exact / near-exact titles that need people/context to be useful. */
const VAGUE_EXACT = new Set([
  'sync',
  'catch up',
  'catchup',
  'meeting',
  'zoom',
  'zoom meeting',
  'zoom call',
  'google meet',
  'google meeting',
  'teams meeting',
  'ms teams',
  'webex',
  'chat',
  'connect',
  'check in',
  'check-in',
  'checkin',
  '1:1',
  '1-1',
  '1 / 1',
  'one on one',
  'one-on-one',
  'call',
  'huddle',
  'quick chat',
  'quick sync',
  'quick call',
  'standup',
  'stand up',
  'stand-up',
  'weekly sync',
  'biweekly sync',
  'bi-weekly sync',
  'monthly sync',
  'status',
  'status update',
  'touch base',
  'touchbase',
  'coffee chat',
  'intro',
  'introduction',
  'follow up',
  'follow-up',
  'followup',
  'discussion',
  'discuss',
  'talk',
  'conversation',
  'meet',
  'internal sync',
  'internal meeting',
  'team sync',
  'team meeting',
  'team chat',
]);

const VAGUE_PREFIX_RE =
  /^(?:quick|weekly|bi-?weekly|monthly|internal|team)?\s*(?:sync|meeting|chat|call|huddle|connect|catch[\s-]?up|check[\s-]?in|standup|stand[\s-]?up|follow[\s-]?up|touch[\s-]?base|zoom(?:\s+(?:meeting|call))?|google\s+meet(?:ing)?|teams(?:\s+meeting)?|webex|discuss(?:ion)?|talk|conversation|intro(?:duction)?|status(?:\s+update)?|meet)\b/i;

const ONE_ON_ONE_PREFIX_RE = /^(?:1[:\-/]1|one[\s-]on[\s-]one)\b/i;

const FILLER_RE = /^(?:with|w\/|and|&)\s+(?:me|us|team|everyone|all)\b/i;
const FILLER_ONLY_RE = /^(?:me|us|team|everyone|all|the|a|an|my|our)$/i;

const NOISE_CHANNELS = new Set([
  'general',
  'virtual-water-cooler',
  'virtual_water_cooler',
  'random',
  'social',
  'announcements',
  'watercooler',
  'water-cooler',
]);

const SKIP_BROWSE_HOST_RE =
  /(?:^|\.)(?:google\.com|googleapis\.com|googleusercontent\.com|youtube\.com|youtu\.be|zoom\.us|zoom\.com|meet\.google\.com|calendar\.google\.com|mail\.google\.com|docs\.google\.com|drive\.google\.com|slack\.com|atlassian\.net|jira\.com|figma\.com|notion\.so)$/i;

export const YORK_EMAIL_RE = /@york\.ie$/i;

export const DELIVERY_TITLE_RE =
  /\b(sprint|jira|release|launchpad|qa|bug|blocker|standup|retro|grooming|backlog|deploy|delivery|milestone|epic)\b/i;

export type EnrichmentSource =
  | 'slack'
  | 'gmail'
  | 'channel'
  | 'meeting'
  | 'hub'
  | 'drive'
  | 'jira'
  | 'launchpad'
  | 'confluence'
  | 'web';

export interface CalendarAttendee {
  name: string;
  email: string;
}

export interface EnrichmentHit {
  source: EnrichmentSource;
  label: string;
  detail: string;
  url?: string;
}

export interface ConnectorPrepStatus {
  id: string;
  label: string;
  status: 'checked' | 'skipped' | 'empty';
  reason?: string;
}

export interface VagueMeetingEnrichment {
  title: string;
  summary: string;
  whyHint: string;
  suggestedAction: string;
  prepNote: string;
  topicHint: string | null;
  hits: EnrichmentHit[];
  connectors: ConnectorPrepStatus[];
  kind?: 'recurring' | 'one_off';
}

export type CalendarMeetingEnrichment = VagueMeetingEnrichment;

function normalizeTitle(title: string): string {
  return title.trim().toLowerCase().replace(/[–—]/g, '-').replace(/\s+/g, ' ');
}

/**
 * True when the invite title is too generic to prep from (needs attendees / context).
 * Specific titles like "1:1 with Ada" or "Sync — Launchpad QA" are not vague.
 */
export function isVagueMeetingTitle(title: string): boolean {
  const t = normalizeTitle(title);
  if (!t || t.length <= 2) return true;
  if (VAGUE_EXACT.has(t)) return true;

  let rest = t;
  if (ONE_ON_ONE_PREFIX_RE.test(rest)) {
    rest = rest
      .replace(ONE_ON_ONE_PREFIX_RE, '')
      .replace(/^[\s:/\-–—|]+/, '')
      .trim();
  } else if (VAGUE_PREFIX_RE.test(rest)) {
    rest = rest
      .replace(VAGUE_PREFIX_RE, '')
      .replace(/^[\s:/\-–—|]+/, '')
      .trim();
  } else {
    // Not a known generic pattern — treat as specific enough.
    return false;
  }

  rest = rest
    .replace(FILLER_RE, '')
    .replace(/^[\s:/\-–—|]+/, '')
    .trim();
  if (!rest || FILLER_ONLY_RE.test(rest)) return true;
  if (VAGUE_EXACT.has(rest)) return true;
  if (rest.length <= 2) return true;
  return false;
}

export function isMeetingPrepNote(raw: string | null | undefined): boolean {
  return Boolean(raw?.trim().startsWith(MEETING_PREP_MARKER));
}

/** Prefer existing prep note when a scan would overwrite with invite payload. */
export function preserveMeetingPrepRawDetails(
  existingRaw: string | null | undefined,
  incomingRaw: string | null | undefined
): string | null {
  const existing = existingRaw ?? null;
  const incoming = incomingRaw ?? null;
  if (isMeetingPrepNote(existing) && !isMeetingPrepNote(incoming)) {
    return existing;
  }
  return incoming;
}

/** Parse `Attendees: Name <email>, …` lines from Calendar get_event body. */
export function parseEventAttendees(text: string): CalendarAttendee[] {
  if (!text?.trim()) return [];
  const lineMatch = text.match(/Attendees:\s*([^\n]+)/i);
  const blob = lineMatch?.[1]?.trim() || '';
  if (!blob) {
    // Fallback: scrape emails from whole body.
    const emails = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
    return [...new Set(emails.map((e) => e.toLowerCase()))].map((email) => ({
      name: email.split('@')[0] || email,
      email,
    }));
  }

  const out: CalendarAttendee[] = [];
  const seen = new Set<string>();
  // Split on commas that are not inside <…>
  const parts = blob.split(/,(?![^<]*>)/);
  for (const part of parts) {
    const chunk = part.trim();
    if (!chunk) continue;
    const angled = chunk.match(/^(.*?)\s*<([^>]+)>\s*$/);
    let name = '';
    let email = '';
    if (angled) {
      name = angled[1].trim().replace(/^["']|["']$/g, '');
      email = angled[2].trim().toLowerCase();
    } else if (/^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(chunk)) {
      email = chunk.toLowerCase();
      name = email.split('@')[0] || email;
    } else {
      name = chunk;
    }
    const key = email || name.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ name: name || email, email });
  }
  return out;
}

export function displayName(attendee: CalendarAttendee): string {
  const n = attendee.name?.trim();
  if (n && !n.includes('@')) return n.split(/\s+/)[0] || n;
  if (attendee.email) {
    const local = attendee.email.split('@')[0] || '';
    return local.replace(/[._]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) || attendee.email;
  }
  return 'Someone';
}

function genericLead(originalTitle: string): string {
  const t = normalizeTitle(originalTitle);
  if (/1[:\-/]1|one[\s-]on[\s-]one/.test(t)) return '1:1';
  if (/\bcatch[\s-]?up\b/.test(t)) return 'Catch-up';
  if (/\bsync\b/.test(t)) return 'Sync';
  if (/\bchat\b/.test(t)) return 'Chat';
  if (/\bhuddle\b/.test(t)) return 'Huddle';
  if (/\bcall\b/.test(t)) return 'Call';
  if (/\bcheck[\s-]?in\b/.test(t)) return 'Check-in';
  return 'Meeting';
}

export function cleanTopicHint(raw: string): string | null {
  let t = raw
    .replace(/<[^>]+>/g, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return null;
  // Drop Re:/Fwd:
  t = t.replace(/^(re|fw|fwd)\s*:\s*/i, '').trim();
  if (t.length < 3) return null;
  if (isVagueMeetingTitle(t)) return null;
  if (t.length > 40) t = `${t.slice(0, 37)}…`;
  return t;
}

/**
 * Deterministic Matter title from attendees + optional topic cue.
 */
export function buildEnrichedMeetingTitle(input: {
  originalTitle: string;
  attendees: CalendarAttendee[];
  topicHint?: string | null;
}): string {
  const lead = genericLead(input.originalTitle);
  const names = input.attendees.map(displayName).filter(Boolean);
  const primary = names.slice(0, 2);
  const extra = names.length > 2 ? ` +${names.length - 2}` : '';
  const people = primary.length ? ` w/ ${primary.join(', ')}${extra}` : '';
  const topic = input.topicHint?.trim();
  let title = topic ? `${lead}${people} — ${topic}` : `${lead}${people || ''}`.trim();
  if (!people && !topic) {
    title = input.originalTitle.trim() || lead;
  }
  if (title.length > 90) title = `${title.slice(0, 87)}…`;
  return title;
}

/** Strip Slack mention IDs / opaque tokens from prep-facing text. */
export function cleanSlackPrepText(text: string): string {
  return text
    .replace(/<@([A-Z0-9]+)(?:\|([^>]+))?>/gi, (_m, _id, name) => (name ? `@${name}` : '@someone'))
    .replace(/<#([A-Z0-9]+)(?:\|([^>]+))?>/gi, (_m, _id, name) => (name ? `#${name}` : '#channel'))
    .replace(/<!subteam\^[^|>]+(?:\|([^>]+))?>/gi, (_m, name) => (name ? `@${name}` : '@group'))
    .replace(/<(https?:[^|>]+)(?:\|([^>]+))?>/gi, (_m, url, label) => label || url)
    .replace(/\b[UW][A-Z0-9]{8,}\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function pickHubString(obj: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (typeof value === 'boolean') return value ? 'true' : 'false';
  }
  return '';
}

/** Unwrap Hub MCP envelopes (`{ body }`, `{ success, data }`, nested JSON strings). */
export function unwrapHubJson(text: string): unknown {
  let cur: unknown = parseJsonLoose(text);
  if (cur == null) return null;
  for (let depth = 0; depth < 5; depth++) {
    if (cur == null || typeof cur !== 'object' || Array.isArray(cur)) break;
    const obj = cur as Record<string, unknown>;
    if (typeof obj.body === 'string') {
      const nested = parseJsonLoose(obj.body);
      cur = nested ?? obj.body;
      continue;
    }
    if (obj.body != null && typeof obj.body === 'object') {
      cur = obj.body;
      continue;
    }
    if (obj.data != null && typeof obj.data === 'object') {
      cur = obj.data;
      continue;
    }
    break;
  }
  return cur;
}

function collectHubLeaveRows(root: unknown): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const seen = new Set<unknown>();
  const visit = (node: unknown, depth: number) => {
    if (node == null || depth > 5 || seen.has(node)) return;
    if (typeof node === 'object') seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) {
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          out.push(item as Record<string, unknown>);
        } else {
          visit(item, depth + 1);
        }
      }
      return;
    }
    if (typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    for (const key of [
      'leaves',
      'leave',
      'leaveRequests',
      'leave_requests',
      'wfh',
      'wfhs',
      'wfhRequests',
      'wfh_requests',
      'entries',
      'items',
      'calendar',
      'results',
    ]) {
      if (key in obj) visit(obj[key], depth + 1);
    }
  };
  visit(root, 0);
  return out;
}

function formatHubLeaveRow(row: Record<string, unknown>): string | null {
  const email = pickHubString(row, [
    'email',
    'employee_email',
    'employeeEmail',
    'userEmail',
    'user_email',
  ]);
  const name = pickHubString(row, [
    'employee_name',
    'employeeName',
    'name',
    'fullName',
    'full_name',
    'displayName',
  ]);
  const kindRaw =
    pickHubString(row, ['leaveType', 'leave_type', 'wfhType', 'wfh_type', 'type', 'kind']) ||
    (pickHubString(row, ['isWfh', 'is_wfh', 'wfh']) === 'true' ? 'WFH' : '');
  if (!name && !email && !kindRaw) return null;
  const kind = (kindRaw || 'Leave').replace(/_/g, ' ');
  const start = pickHubString(row, ['startDate', 'start_date', 'from', 'date', 'start']);
  const end = pickHubString(row, ['endDate', 'end_date', 'to', 'end']);
  const status = pickHubString(row, ['status', 'state']);
  const who = name || email || 'Teammate';
  const when = start && end && start !== end ? `${start} → ${end}` : start || end || '';
  return [who, kind, when, status].filter(Boolean).join(' · ');
}

/**
 * Turn Hub leave/WFH calendar JSON into a short human line for prep notes.
 * Prefer rows matching attendee emails when provided.
 */
export function summarizeHubLeaveCalendar(
  text: string,
  attendeeEmails: string[] = []
): string | null {
  const root = unwrapHubJson(text);
  if (root == null) {
    const trimmed = envelopeBody(text).replace(/\s+/g, ' ').trim();
    if (!trimmed || trimmed.startsWith('{') || trimmed.startsWith('[')) return null;
    return trimmed.slice(0, 220);
  }

  const rows = collectHubLeaveRows(root);
  if (!rows.length) return 'No leave/WFH entries in Hub for this window.';

  const emailSet = new Set(attendeeEmails.map((e) => e.toLowerCase()).filter(Boolean));
  const formatRows = (filterEmails: boolean): string[] => {
    const lines: string[] = [];
    for (const row of rows) {
      const email = pickHubString(row, [
        'email',
        'employee_email',
        'employeeEmail',
        'userEmail',
        'user_email',
      ]).toLowerCase();
      if (filterEmails && emailSet.size > 0 && email && !emailSet.has(email)) continue;
      if (filterEmails && emailSet.size > 0 && !email) continue;
      const line = formatHubLeaveRow(row);
      if (!line) continue;
      lines.push(line);
      if (lines.length >= 5) break;
    }
    return lines;
  };

  const attendeeLines = formatRows(true);
  const lines = attendeeLines.length ? attendeeLines : formatRows(false);
  if (!lines.length) return 'No leave/WFH entries in Hub for this window.';
  const prefix = attendeeLines.length > 0 ? 'Attendees out / WFH: ' : 'Team leave / WFH: ';
  return `${prefix}${lines.join('; ')}`;
}

/** Turn Hub employee JSON into a short human line (name · title · squad). */
export function summarizeHubEmployee(text: string, emailHint?: string): string | null {
  const root = unwrapHubJson(text);
  if (root == null) {
    const trimmed = envelopeBody(text).replace(/\s+/g, ' ').trim();
    if (!trimmed || trimmed.startsWith('{') || trimmed.startsWith('[')) return null;
    return trimmed.slice(0, 160);
  }

  let obj: Record<string, unknown> | null = null;
  if (Array.isArray(root)) {
    const match =
      (emailHint
        ? root.find((item) => {
            if (!item || typeof item !== 'object') return false;
            const email = pickHubString(item as Record<string, unknown>, [
              'email',
              'employee_email',
              'employeeEmail',
            ]).toLowerCase();
            return email === emailHint.toLowerCase();
          })
        : null) || root.find((item) => item && typeof item === 'object');
    obj = (match as Record<string, unknown>) || null;
  } else if (typeof root === 'object') {
    const record = root as Record<string, unknown>;
    for (const key of ['employees', 'items', 'results', 'data', 'people']) {
      const arr = record[key];
      if (Array.isArray(arr) && arr.length) {
        const first =
          (emailHint
            ? arr.find((item) => {
                if (!item || typeof item !== 'object') return false;
                const email = pickHubString(item as Record<string, unknown>, [
                  'email',
                  'employee_email',
                  'employeeEmail',
                ]).toLowerCase();
                return email === emailHint.toLowerCase();
              })
            : null) || arr.find((item) => item && typeof item === 'object');
        if (first && typeof first === 'object') {
          obj = first as Record<string, unknown>;
          break;
        }
      }
    }
    if (!obj) obj = record;
  }
  if (!obj) return null;

  const name = pickHubString(obj, [
    'name',
    'fullName',
    'full_name',
    'employee_name',
    'employeeName',
    'displayName',
  ]);
  const title = pickHubString(obj, [
    'title',
    'jobTitle',
    'job_title',
    'designation',
    'role',
    'position',
  ]);
  const squad = pickHubString(obj, [
    'squad',
    'squadName',
    'squad_name',
    'team',
    'teamName',
    'department',
  ]);
  const status = pickHubString(obj, ['status', 'employmentStatus', 'employment_status']);
  const bits = [name, title, squad, status].filter(Boolean);
  if (!bits.length) {
    const email = pickHubString(obj, ['email', 'employee_email', 'employeeEmail']) || emailHint;
    return email ? `Hub profile for ${email}` : null;
  }
  return bits.join(' · ');
}

export function extractBrowseUrls(text: string, limit = 3): string[] {
  if (!text?.trim()) return [];
  const matches = text.match(/https?:\/\/[^\s"'<>]+/gi) || [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of matches) {
    const cleaned = raw.replace(/[),.;\]]+$/g, '');
    try {
      const u = new URL(cleaned);
      if (!['http:', 'https:'].includes(u.protocol)) continue;
      if (SKIP_BROWSE_HOST_RE.test(u.hostname)) continue;
      const key = `${u.hostname}${u.pathname}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(u.toString());
      if (out.length >= limit) break;
    } catch {
      /* ignore */
    }
  }
  return out;
}

export interface ParsedSlackSearchMessage {
  channel: string;
  channelLabel: string;
  ts: string;
  user: string;
  text: string;
  link?: string;
}

export interface ParsedSlackHistoryMessage {
  ts: string;
  user: string;
  text: string;
  link?: string;
}

/**
 * Parse Slack search envelope body lines.
 * Accepts `channel [ts] user: text`, DM names with spaces, and `C123|#eng [ts] …`.
 */
export function parseSlackSearchBody(body: string): ParsedSlackSearchMessage[] {
  const lines = body.split('\n');
  const out: ParsedSlackSearchMessage[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const m = line.match(/^(.+?)\s+\[([^\]]+)\]\s+([^:]+):\s*(.*)$/);
    if (!m) continue;
    let link: string | undefined;
    const next = lines[i + 1]?.trim() || '';
    if (/^Link:\s*/i.test(next)) {
      link = next.replace(/^Link:\s*/i, '').trim();
      i += 1;
    } else {
      link = extractUrl(line);
    }
    const rawChannel = m[1].trim();
    let channel = rawChannel;
    let channelLabel = rawChannel.replace(/^#/, '');
    const pipe = rawChannel.indexOf('|');
    if (pipe >= 0) {
      const idPart = rawChannel.slice(0, pipe).trim();
      const namePart = rawChannel
        .slice(pipe + 1)
        .trim()
        .replace(/^#/, '');
      channel = idPart || namePart;
      channelLabel = namePart || idPart;
    }
    out.push({
      channel,
      channelLabel,
      ts: m[2],
      user: m[3].trim(),
      text: (m[4] || '').trim(),
      link,
    });
  }
  return out;
}

/** Parse `get_channel_history` / `get_thread` body lines: `[ts] user: text`. */
export function parseSlackHistoryBody(body: string, limit = 4): ParsedSlackHistoryMessage[] {
  const lines = body.split('\n');
  const out: ParsedSlackHistoryMessage[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const m = line.match(/^\[([^\]]+)\]\s+([^:]+):\s*(.*)$/);
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
      ts: m[1],
      user: m[2].trim(),
      text: (m[3] || '').trim(),
      link,
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** Title tokens for Slack/Gmail/channel scoring (≥3 chars, drop vague fillers). */
export function titleSearchTokens(title: string): string[] {
  const stop = new Set([
    'with',
    'the',
    'and',
    'for',
    'from',
    'w/',
    'sync',
    'meeting',
    'call',
    'chat',
    'zoom',
    'catch',
    'up',
    'check',
    'in',
  ]);
  return title
    .toLowerCase()
    .replace(/[^\w\s-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !stop.has(t) && !VAGUE_EXACT.has(t))
    .slice(0, 5);
}

export function scoreChannelName(
  channelName: string,
  attendees: CalendarAttendee[],
  extraTokens: string[] = []
): number {
  const name = channelName.replace(/^#/, '').toLowerCase();
  if (!name || NOISE_CHANNELS.has(name)) return 0;
  let score = 0;
  for (const a of attendees) {
    const local = (a.email.split('@')[0] || '').toLowerCase().replace(/[._]/g, '');
    const parts = [
      local,
      ...displayName(a).toLowerCase().split(/\s+/),
      ...(a.name || '').toLowerCase().split(/\s+/),
    ].filter((p) => p.length >= 3);
    for (const p of [...new Set(parts)]) {
      if (name.includes(p)) score += p.length >= 5 ? 3 : 2;
    }
  }
  for (const token of extraTokens) {
    const t = token.toLowerCase().replace(/^#/, '');
    if (t.length < 3) continue;
    if (name.includes(t) || t.includes(name)) score += t.length >= 5 ? 4 : 2;
  }
  return score;
}

/**
 * On-click meeting prep for a calendar event. Delegates to the recurring /
 * one-off pipeline in `./meeting-prep` (lazy import avoids a module cycle).
 */
export async function enrichCalendarMeeting(options: {
  mcpManager: MCPManager;
  meetingService: MeetingService | null;
  originalTitle: string;
  when: string;
  attendees: CalendarAttendee[];
  eventUrl?: string;
  inviteBody?: string;
  eventId?: string | null;
  config?: AppConfig | null;
  selfEmail?: string | null;
}): Promise<CalendarMeetingEnrichment> {
  const { runMeetingPrep } = await import('./meeting-prep');
  const result = await runMeetingPrep(options);
  const title = isVagueMeetingTitle(options.originalTitle)
    ? buildEnrichedMeetingTitle({
        originalTitle: options.originalTitle,
        attendees: options.attendees,
        topicHint: result.brief.purpose ? cleanTopicHint(result.brief.purpose) : null,
      })
    : options.originalTitle.trim();
  return {
    title,
    summary: result.summary,
    whyHint:
      result.kind === 'recurring'
        ? 'Recurring meeting: prior action items checked against Slack, email, and delivery tools.'
        : 'One-off meeting: attendees and recent exchanges researched across connectors.',
    suggestedAction: result.suggestedAction,
    prepNote: result.prepNote,
    topicHint: result.brief.purpose || null,
    hits: result.evidence.map((e) => ({
      source: e.source === 'calendar' || e.source === 'chat' ? 'meeting' : e.source,
      label: e.title,
      detail: e.excerpt,
      url: e.url,
    })),
    connectors: result.connectors,
    kind: result.kind,
  };
}

/** @deprecated Use enrichCalendarMeeting — kept for callers/tests. */
export async function enrichVagueCalendarMeeting(
  options: Parameters<typeof enrichCalendarMeeting>[0]
): Promise<VagueMeetingEnrichment> {
  return enrichCalendarMeeting(options);
}
