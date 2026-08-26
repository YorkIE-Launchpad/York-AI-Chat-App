/**
 * Calendar meeting prep enrichment for Matter — on-click fan-out across
 * connected MCPs (Slack, Gmail, Hub, Drive, Jira, Launchpad, Confluence),
 * local meetings, and domain webfetch from invite links.
 */

import type { MCPManager } from '../mcp/mcp-manager';
import type { MeetingService } from '../meetings/meeting-service';
import { fetchWebPage } from '../tools/web-fetch';
import { logWarn } from '../utils/logger';
import {
  DEFAULT_CONFLUENCE_MCP_SERVER_ID,
  DEFAULT_GMAIL_MCP_SERVER_ID,
  DEFAULT_GOOGLE_DRIVE_MCP_SERVER_ID,
  DEFAULT_HUB_MCP_SERVER_ID,
  DEFAULT_HUB_MCP_NAME,
  DEFAULT_JIRA_MCP_SERVER_ID,
  DEFAULT_LAUNCHPAD_MCP_SERVER_ID,
  DEFAULT_SLACK_MCP_SERVER_ID,
} from '../../shared/mcp-defaults';
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

const YORK_EMAIL_RE = /@york\.ie$/i;

const DELIVERY_TITLE_RE =
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
}

export type CalendarMeetingEnrichment = VagueMeetingEnrichment;

function normalizeTitle(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ');
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
    rest = rest.replace(ONE_ON_ONE_PREFIX_RE, '').replace(/^[\s:/\-–—|]+/, '').trim();
  } else if (VAGUE_PREFIX_RE.test(rest)) {
    rest = rest.replace(VAGUE_PREFIX_RE, '').replace(/^[\s:/\-–—|]+/, '').trim();
  } else {
    // Not a known generic pattern — treat as specific enough.
    return false;
  }

  rest = rest.replace(FILLER_RE, '').replace(/^[\s:/\-–—|]+/, '').trim();
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

function displayName(attendee: CalendarAttendee): string {
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

function cleanTopicHint(raw: string): string | null {
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

function sectionLines(heading: string, hits: EnrichmentHit[], empty: string): string[] {
  if (!hits.length) return [`### ${heading}`, empty];
  return [
    `### ${heading}`,
    ...hits.map((h) => {
      const link = h.url ? ` ([link](${h.url}))` : '';
      return `- ${h.label}: ${h.detail}${link}`;
    }),
  ];
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

const OPEN_LOOP_RE =
  /\b(action|todo|follow[\s-]?up|open|blocker|need|pending|owe|promise|will\s+send|let'?s\s+|assigned|due)\b/i;

export function buildMeetingPrepNote(input: {
  originalTitle: string;
  when: string;
  attendees: CalendarAttendee[];
  hits: EnrichmentHit[];
  enrichedTitle: string;
  eventUrl?: string;
  connectors?: ConnectorPrepStatus[];
}): string {
  const attendeeLine =
    input.attendees.length > 0
      ? input.attendees
          .map((a) => (a.email ? `${a.name} <${a.email}>` : a.name))
          .join(', ')
      : 'None listed';

  const bySource = (source: EnrichmentHit['source']) =>
    input.hits.filter((h) => h.source === source);

  const slackHits = bySource('slack').map((h) => ({
    ...h,
    label: cleanSlackPrepText(h.label),
    detail: cleanSlackPrepText(h.detail),
  }));
  const channelHits = bySource('channel').map((h) => ({
    ...h,
    label: cleanSlackPrepText(h.label),
    detail: cleanSlackPrepText(h.detail),
  }));
  const gmailHits = bySource('gmail');
  const meetingHits = bySource('meeting');

  const openLoops: string[] = [];
  for (const h of meetingHits) {
    if (/action item/i.test(h.detail) || OPEN_LOOP_RE.test(h.detail)) {
      openLoops.push(`- ${h.label}: ${h.detail.slice(0, 160)}`);
    }
  }
  for (const h of [...slackHits, ...gmailHits, ...channelHits]) {
    if (!OPEN_LOOP_RE.test(`${h.label} ${h.detail}`)) continue;
    openLoops.push(`- ${h.label}: ${h.detail.slice(0, 140)}`);
    if (openLoops.length >= 6) break;
  }

  const agendaSeeds = [
    ...meetingHits.flatMap((h) =>
      h.detail
        .split(/;\s*/)
        .map((p) => p.trim())
        .filter((p) => /action item|topic/i.test(p) || OPEN_LOOP_RE.test(p))
        .slice(0, 2)
    ),
    ...slackHits.slice(0, 3).map((h) => h.detail.slice(0, 100)),
    ...gmailHits.slice(0, 2).map((h) => `${h.label}: ${h.detail.slice(0, 80)}`),
    ...channelHits.slice(0, 2).map((h) => h.detail.slice(0, 100)),
  ].filter(Boolean);

  const agendaLines =
    agendaSeeds.length > 0
      ? [...new Set(agendaSeeds)].slice(0, 6).map((line, i) => `${i + 1}. ${line}`)
      : [
          '1. Confirm goal from the invite only (no recent Slack/email/Zoom notes found).',
          '2. Align on next steps and owners.',
        ];

  const checked = (input.connectors || []).filter(
    (c) => c.status === 'checked' || c.status === 'empty'
  );
  const skipped = (input.connectors || []).filter((c) => c.status === 'skipped');

  const sources = input.hits
    .filter((h) => h.url)
    .map((h) => `- [${cleanSlackPrepText(h.label)}](${h.url})`);
  if (input.eventUrl) {
    sources.unshift(`- [Calendar event](${input.eventUrl})`);
  }

  const purpose =
    input.enrichedTitle !== input.originalTitle
      ? input.enrichedTitle
      : input.originalTitle || 'From invite title only';

  return [
    MEETING_PREP_MARKER,
    '',
    `**Meeting:** ${input.originalTitle || '(untitled)'}`,
    '',
    `**When:** ${input.when || 'unknown'}`,
    '',
    `**Attendees:** ${attendeeLine}`,
    '',
    `**Likely purpose:** ${purpose}`,
    '',
    ...sectionLines(
      'Recent Slack (DMs / people)',
      slackHits,
      '- No recent Slack DMs or person hits with attendees.'
    ),
    '',
    ...sectionLines(
      'Mutual / project channels',
      channelHits,
      '- No matching mutual or project channels found.'
    ),
    '',
    ...sectionLines('Email', gmailHits, '- No recent email with attendees.'),
    '',
    ...sectionLines(
      'Prior Zoom meetings',
      meetingHits,
      '- No prior local Zoom meeting notes found.'
    ),
    '',
    ...sectionLines('Hub', bySource('hub'), '- No Hub people / leave / project context found.'),
    '',
    ...sectionLines('Drive', bySource('drive'), '- No related Drive files found.'),
    '',
    ...sectionLines(
      'Delivery (Jira / Launchpad / Confluence)',
      [...bySource('jira'), ...bySource('launchpad'), ...bySource('confluence')],
      '- No delivery tickets/pages pulled (not implied or disconnected).'
    ),
    '',
    ...sectionLines('Domain / links', bySource('web'), '- No external pages fetched from the invite.'),
    '',
    '### Open loops / action items',
    ...(openLoops.length ? openLoops.slice(0, 6) : ['- None grounded in sources (invite-only).']),
    '',
    '### Suggested agenda',
    ...agendaLines,
    '',
    '### Connectors',
    `- Checked: ${checked.length ? checked.map((c) => c.label).join(', ') : 'none'}`,
    `- Skipped: ${
      skipped.length
        ? skipped.map((c) => `${c.label}${c.reason ? ` (${c.reason})` : ''}`).join(', ')
        : 'none'
    }`,
    '',
    '### Sources',
    ...(sources.length ? sources : ['- Calendar event (invite only)']),
  ].join('\n');
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
  const prefix =
    attendeeLines.length > 0
      ? 'Attendees out / WFH: '
      : 'Team leave / WFH: ';
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

function extractUrl(text: string): string | undefined {
  const match = text.match(/https?:\/\/[^\s"'<>]+/i);
  return match?.[0]?.replace(/[),.;]+$/, '');
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

function htmlToPlainSnippet(fetched: string, max = 280): string {
  const bodyMatch = fetched.match(/\n\n([\s\S]*)$/);
  const body = bodyMatch?.[1] || fetched;
  const text = body
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&\w+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '(no readable text)';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
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
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
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

function isServerConnected(mcpManager: MCPManager, serverId: string): boolean {
  try {
    return mcpManager.getServerStatus().some((s) => s.id === serverId && s.connected);
  } catch {
    return false;
  }
}

function resolveHubServerIdLocal(mcpManager: MCPManager): string | null {
  try {
    const connected = mcpManager.getServerStatus().filter((s) => s.connected);
    const exact = connected.find((s) => s.id === DEFAULT_HUB_MCP_SERVER_ID);
    if (exact) return exact.id;
    const named = connected.find((s) => {
      const n = (s.name || '').toLowerCase();
      return (
        n.includes('hub') ||
        n === DEFAULT_HUB_MCP_NAME.toLowerCase() ||
        n.includes('york ie hub')
      );
    });
    if (named) return named.id;
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
    logWarn(`[Matter] Enrich tool ${toolName} failed:`, error);
    return null;
  }
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
export function parseSlackHistoryBody(
  body: string,
  limit = 4
): ParsedSlackHistoryMessage[] {
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

function attendeeSearchTokens(attendees: CalendarAttendee[]): string[] {
  const tokens: string[] = [];
  for (const a of attendees) {
    if (a.email) tokens.push(a.email);
    const first = displayName(a);
    if (first && first.length >= 2) tokens.push(first);
    if (a.name && a.name.includes(' ')) {
      const last = a.name.trim().split(/\s+/).pop();
      if (last && last.length >= 3) tokens.push(last);
    }
  }
  return [...new Set(tokens.map((t) => t.trim()).filter(Boolean))].slice(0, 6);
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

/** Format a prior Zoom/local meeting for prep notes (action items + topics). */
export function formatPriorMeetingHit(input: {
  id: string;
  title?: string;
  status?: string;
  startedAt?: number;
  summary?: string;
  notes?: {
    summary?: string;
    actionItems?: string[];
    keyTopics?: string[];
  } | null;
}): EnrichmentHit {
  const label = input.title || input.id;
  const when =
    typeof input.startedAt === 'number' && input.startedAt > 0
      ? new Date(input.startedAt).toISOString().slice(0, 10)
      : '';
  const parts: string[] = [];
  if (when) parts.push(when);
  const summary = input.notes?.summary || input.summary;
  if (summary?.trim()) parts.push(summary.trim().slice(0, 120));
  const topics = (input.notes?.keyTopics || []).filter(Boolean).slice(0, 3);
  if (topics.length) parts.push(`Topics: ${topics.join('; ')}`);
  const actions = (input.notes?.actionItems || []).filter(Boolean).slice(0, 4);
  if (actions.length) parts.push(`Action items: ${actions.join('; ')}`);
  if (!parts.length) {
    parts.push(`Prior meeting · ${input.status || 'done'}`);
  }
  return {
    source: 'meeting',
    label: when ? `${label} · ${when}` : label,
    detail: parts.join(' · ').slice(0, 320),
  };
}

function slackHitLabel(msg: ParsedSlackSearchMessage): string {
  const isDm = /^D/i.test(msg.channel);
  const label = (msg.channelLabel || '').trim();
  const place = isDm
    ? label && !/^D/i.test(label) && !/^[CGD][A-Z0-9]{8,}$/i.test(label)
      ? `DM · ${label}`
      : 'DM'
    : label && !/^[CGD][A-Z0-9]{8,}$/i.test(label)
      ? `#${label.replace(/^#/, '')}`
      : '#channel';
  return `${place} · ${msg.user || 'someone'}`;
}

function extractHubProjectNameTokens(text: string, titleTokens: string[]): string[] {
  const body = envelopeBody(text);
  const candidates: string[] = [];
  const json = parseJsonLoose(body) || parseJsonLoose(text);
  const walk = (node: unknown, depth = 0): void => {
    if (depth > 6 || node == null) return;
    if (Array.isArray(node)) {
      for (const item of node.slice(0, 40)) walk(item, depth + 1);
      return;
    }
    if (typeof node !== 'object') return;
    const rec = node as Record<string, unknown>;
    for (const key of ['title', 'name', 'projectName', 'clientName', 'client']) {
      const v = rec[key];
      if (typeof v === 'string' && v.trim().length >= 3) candidates.push(v.trim());
    }
    for (const v of Object.values(rec).slice(0, 30)) walk(v, depth + 1);
  };
  if (json) walk(json);
  if (!candidates.length) {
    for (const line of body.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.length > 80) continue;
      const m = trimmed.match(/^[-*]?\s*(?:\[)?([^\]|:]+)(?:\]|:|\s{2,})/);
      if (m?.[1]) candidates.push(m[1].trim());
    }
  }
  const lowerTitle = titleTokens.map((t) => t.toLowerCase());
  const scored = candidates
    .map((name) => {
      const lower = name.toLowerCase();
      const hit = lowerTitle.some((t) => lower.includes(t) || t.includes(lower.split(/\s+/)[0] || ''));
      return { name, hit };
    })
    .filter((c) => c.hit || titleTokens.length === 0)
    .slice(0, 8);
  const preferred = scored.filter((c) => c.hit);
  const pick = (preferred.length ? preferred : scored).slice(0, 5);
  const tokens: string[] = [];
  for (const { name } of pick) {
    tokens.push(name);
    for (const part of name.toLowerCase().split(/[\s/_-]+/)) {
      if (part.length >= 3) tokens.push(part);
    }
  }
  return [...new Set(tokens)].slice(0, 12);
}

function impliesDeliveryWork(title: string, attendees: CalendarAttendee[]): boolean {
  if (DELIVERY_TITLE_RE.test(title)) return true;
  return attendees.some((a) => a.email && !YORK_EMAIL_RE.test(a.email));
}

function markConnector(
  list: ConnectorPrepStatus[],
  id: string,
  label: string,
  status: ConnectorPrepStatus['status'],
  reason?: string
): void {
  const existing = list.find((c) => c.id === id);
  if (existing) {
    existing.status = status;
    if (reason) existing.reason = reason;
    return;
  }
  list.push({ id, label, status, reason });
}

/**
 * Full meeting prep fan-out for on-click Matter Prep (any title).
 */
export async function enrichCalendarMeeting(options: {
  mcpManager: MCPManager;
  meetingService: MeetingService | null;
  originalTitle: string;
  when: string;
  attendees: CalendarAttendee[];
  eventUrl?: string;
  inviteBody?: string;
}): Promise<CalendarMeetingEnrichment> {
  const {
    mcpManager,
    meetingService,
    originalTitle,
    when,
    attendees,
    eventUrl,
    inviteBody = '',
  } = options;
  const hits: EnrichmentHit[] = [];
  const connectors: ConnectorPrepStatus[] = [];
  let topicHint: string | null = null;
  const tokens = attendeeSearchTokens(attendees);
  const titleTokens = titleSearchTokens(originalTitle);
  const after = new Date(Date.now() - 14 * 864e5).toISOString().slice(0, 10);
  const delivery = impliesDeliveryWork(originalTitle, attendees);
  const emails = attendees.map((a) => a.email).filter(Boolean).slice(0, 4);
  /** Prefer non-self-looking attendees for person-targeted Slack/Gmail deepen. */
  const focusAttendees = attendees
    .filter((a) => a.email || a.name)
    .slice(0, 4)
    .sort((a, b) => {
      const aExt = a.email && !YORK_EMAIL_RE.test(a.email) ? 0 : 1;
      const bExt = b.email && !YORK_EMAIL_RE.test(b.email) ? 0 : 1;
      return aExt - bExt;
    })
    .slice(0, 2);

  const tasks: Array<Promise<void>> = [];

  // Slack: DM + person + title search, then deepen up to 2 threads
  if (isServerConnected(mcpManager, DEFAULT_SLACK_MCP_SERVER_ID)) {
    const slackTool = findToolName(mcpManager, DEFAULT_SLACK_MCP_SERVER_ID, [
      'search_messages',
      'search_public_and_private',
      'search_public',
    ]);
    const threadTool = findToolName(mcpManager, DEFAULT_SLACK_MCP_SERVER_ID, ['get_thread']);
    const userTool = findToolName(mcpManager, DEFAULT_SLACK_MCP_SERVER_ID, ['get_user']);
    if (slackTool && (focusAttendees.length || originalTitle.trim().length > 2)) {
      markConnector(connectors, 'slack', 'Slack', 'checked');
      tasks.push(
        (async () => {
          const handleByEmail = new Map<string, string>();
          if (userTool) {
            for (const a of focusAttendees) {
              if (!a.email) continue;
              const profile = await safeCallTool(mcpManager, userTool, {
                user_id: a.email,
                email: a.email,
              });
              if (!profile) continue;
              const raw = parseJsonLoose(envelopeBody(profile)) || parseJsonLoose(profile);
              const rec =
                typeof raw === 'object' && raw ? (raw as Record<string, unknown>) : null;
              const handle =
                (typeof rec?.name === 'string' && rec.name) ||
                (typeof rec?.real_name === 'string' && rec.real_name) ||
                '';
              if (handle) handleByEmail.set(a.email.toLowerCase(), handle);
            }
          }

          const queries: string[] = [];
          for (const a of focusAttendees) {
            const handle = a.email ? handleByEmail.get(a.email.toLowerCase()) : '';
            const person = [handle, displayName(a), a.email].filter(Boolean);
            const orPerson = [...new Set(person)].slice(0, 3).join(' OR ');
            if (orPerson) {
              queries.push(`is:im (${orPerson}) after:${after}`);
              queries.push(`(${orPerson}) after:${after}`);
            }
          }
          if (originalTitle.trim().length > 2) {
            queries.push(`"${originalTitle.trim().slice(0, 40)}" after:${after}`);
          }
          if (!queries.length && tokens.length) {
            queries.push(`${tokens.slice(0, 3).join(' OR ')} after:${after}`);
          }

          const threadCandidates: Array<{
            channelId: string;
            threadTs: string;
            preview: string;
            link?: string;
          }> = [];
          const seenMsg = new Set<string>();

          for (const query of queries.slice(0, 5)) {
            const text = await safeCallTool(mcpManager, slackTool, { query, limit: 8 });
            if (!text) continue;
            const msgs = parseSlackSearchBody(envelopeBody(text)).slice(0, 3);
            for (const msg of msgs) {
              const key = `${msg.channel}:${msg.ts}`;
              if (seenMsg.has(key)) continue;
              seenMsg.add(key);
              const preview = cleanSlackPrepText(msg.text).slice(0, 140) || '(no text)';
              hits.push({
                source: 'slack',
                label: slackHitLabel(msg),
                detail: preview,
                url: msg.link,
              });
              if (!topicHint) topicHint = cleanTopicHint(msg.text);
              if (
                threadTool &&
                msg.ts &&
                msg.channel &&
                /^[CDG][A-Z0-9]/i.test(msg.channel) &&
                threadCandidates.length < 4
              ) {
                threadCandidates.push({
                  channelId: msg.channel,
                  threadTs: msg.ts,
                  preview,
                  link: msg.link,
                });
              }
            }
          }

          for (const cand of threadCandidates.slice(0, 2)) {
            const threadText = await safeCallTool(mcpManager, threadTool!, {
              channel_id: cand.channelId,
              thread_ts: cand.threadTs,
            });
            if (!threadText) continue;
            const replies = parseSlackHistoryBody(envelopeBody(threadText), 4);
            if (!replies.length) continue;
            const detail = cleanSlackPrepText(
              replies.map((r) => `${r.user}: ${r.text.slice(0, 80)}`).join(' · ')
            ).slice(0, 220);
            hits.push({
              source: 'slack',
              label: `Thread · ${cand.threadTs}`,
              detail: detail || cand.preview,
              url: cand.link || replies.find((r) => r.link)?.link,
            });
            if (!topicHint && replies[0]?.text) topicHint = cleanTopicHint(replies[0].text);
          }
        })()
      );
    } else {
      markConnector(
        connectors,
        'slack',
        'Slack',
        tokens.length || originalTitle.trim() ? 'empty' : 'skipped',
        slackTool ? 'no attendees/title' : 'no tool'
      );
    }
  } else {
    markConnector(connectors, 'slack', 'Slack', 'skipped', 'disconnected');
  }

  // Gmail — people + subject + commitment-ish, deepen up to 4 bodies
  if (isServerConnected(mcpManager, DEFAULT_GMAIL_MCP_SERVER_ID)) {
    const searchTool = findToolName(mcpManager, DEFAULT_GMAIL_MCP_SERVER_ID, [
      'search_emails',
      'list_messages',
    ]);
    if (searchTool && emails.length) {
      markConnector(connectors, 'gmail', 'Gmail', 'checked');
      tasks.push(
        (async () => {
          const fromTo = emails.map((e) => `from:${e} OR to:${e}`).join(' OR ');
          const subjectCue =
            titleTokens.length > 0
              ? `newer_than:14d subject:(${titleTokens.slice(0, 3).join(' ')})`
              : originalTitle.trim().length > 3
                ? `newer_than:14d subject:(${originalTitle.trim().slice(0, 40)})`
                : '';
          const queries = [
            `newer_than:14d (${fromTo})`,
            subjectCue,
            `newer_than:14d (from:me OR to:me) (${emails.slice(0, 2).join(' OR ')})`,
          ].filter(Boolean) as string[];

          const idOrder: string[] = [];
          const seenIds = new Set<string>();
          for (const query of queries.slice(0, 3)) {
            const searchText = await safeCallTool(mcpManager, searchTool, {
              query,
              limit: 6,
            });
            if (!searchText) continue;
            for (const line of envelopeBody(searchText).split(/\n/)) {
              const id = line.trim();
              if (!/^[a-zA-Z0-9_-]{6,}$/.test(id) || seenIds.has(id)) continue;
              seenIds.add(id);
              idOrder.push(id);
            }
          }

          const getTool = findToolName(mcpManager, DEFAULT_GMAIL_MCP_SERVER_ID, [
            'get_email',
            'get_message',
          ]);
          for (const id of idOrder.slice(0, 4)) {
            let subject = `Email ${id.slice(0, 8)}…`;
            let snippet = '';
            const url = `https://mail.google.com/mail/u/0/#all/${id}`;
            if (getTool) {
              const detail = await safeCallTool(mcpManager, getTool, {
                message_id: id,
                id,
              });
              if (detail) {
                const raw = parseJsonLoose(detail) || detail;
                const env =
                  typeof raw === 'object' && raw ? (raw as Record<string, unknown>) : null;
                if (typeof env?.title === 'string' && env.title.trim()) {
                  subject = env.title.trim();
                }
                const bodyText =
                  (typeof env?.body === 'string' && env.body) ||
                  (typeof env?.summary === 'string' && env.summary) ||
                  '';
                if (bodyText) {
                  snippet = bodyText
                    .replace(/<[^>]+>/g, ' ')
                    .replace(/\s+/g, ' ')
                    .trim()
                    .slice(0, 300);
                }
              }
            }
            hits.push({
              source: 'gmail',
              label: subject,
              detail: snippet || 'Recent thread with attendees',
              url,
            });
            if (!topicHint) topicHint = cleanTopicHint(subject);
          }
        })()
      );
    } else {
      markConnector(
        connectors,
        'gmail',
        'Gmail',
        emails.length ? 'empty' : 'skipped',
        emails.length ? 'no tool' : 'no attendee emails'
      );
    }
  } else {
    markConnector(connectors, 'gmail', 'Gmail', 'skipped', 'disconnected');
  }

  // Mutual / project Slack channels (top 2–3)
  if (isServerConnected(mcpManager, DEFAULT_SLACK_MCP_SERVER_ID) && attendees.length) {
    const listTool = findToolName(mcpManager, DEFAULT_SLACK_MCP_SERVER_ID, ['list_channels']);
    const histTool = findToolName(mcpManager, DEFAULT_SLACK_MCP_SERVER_ID, [
      'get_channel_history',
      'conversations_history',
    ]);
    const slackSearchTool = findToolName(mcpManager, DEFAULT_SLACK_MCP_SERVER_ID, [
      'search_messages',
      'search_public_and_private',
      'search_public',
    ]);
    if (listTool) {
      tasks.push(
        (async () => {
          let projectTokens: string[] = [];
          const hubId = resolveHubServerIdLocal(mcpManager);
          if (hubId) {
            const projTool = findToolName(mcpManager, hubId, [
              'list_projects',
              'list_project_summaries',
            ]);
            if (projTool) {
              const projText = await safeCallTool(mcpManager, projTool, {
                active: true,
                limit: 40,
              });
              if (projText) {
                projectTokens = extractHubProjectNameTokens(projText, titleTokens);
                if (projectTokens.length) {
                  hits.push({
                    source: 'hub',
                    label: 'Projects',
                    detail: `Matched: ${projectTokens.slice(0, 4).join(', ')}`,
                  });
                }
              }
            }
          }

          const extraTokens = [...titleTokens, ...projectTokens];
          const text = await safeCallTool(mcpManager, listTool, { limit: 100 });
          if (!text) return;
          const lines = envelopeBody(text)
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean);
          const scored: Array<{ name: string; id: string; score: number }> = [];
          for (const line of lines) {
            const pipe = line.match(/^([CG][A-Z0-9]+)\|\#?([A-Za-z0-9_-]+)/i);
            const m =
              pipe ||
              line.match(/^#?([A-Za-z0-9_-]+)\s*(?:\(([^)]+)\))?\s*:\s*(.*)$/) ||
              line.match(/^#?([A-Za-z0-9_-]+)\s*$/);
            if (!m) continue;
            const channelName = pipe ? pipe[2] : m[1];
            const channelId = pipe ? pipe[1] : m[2] || channelName;
            const score = scoreChannelName(channelName, attendees, extraTokens);
            if (score <= 0) continue;
            scored.push({ name: channelName, id: channelId, score });
          }
          scored.sort((a, b) => b.score - a.score);
          const top = scored.slice(0, 3);
          for (const ch of top) {
            let detail = `Matched channel (score ${ch.score})`;
            if (histTool) {
              const hist = await safeCallTool(mcpManager, histTool, {
                channel_id: ch.id,
                limit: 6,
              });
              if (hist) {
                const msgs = parseSlackHistoryBody(envelopeBody(hist), 3);
                if (msgs.length) {
                  detail =
                    cleanSlackPrepText(
                      msgs.map((msg) => msg.text.slice(0, 100)).join(' · ')
                    ) || detail;
                  if (!topicHint && msgs[0]?.text) topicHint = cleanTopicHint(msgs[0].text);
                } else {
                  const bodyPreview =
                    envelopeBody(hist).split('\n').find((l) => l.trim()) || '';
                  if (bodyPreview) detail = cleanSlackPrepText(bodyPreview).slice(0, 160);
                }
              }
            }
            hits.push({
              source: 'channel',
              label: `#${ch.name}`,
              detail,
            });
          }

          const best = top[0];
          if (best && slackSearchTool && (titleTokens[0] || originalTitle.trim().length > 2)) {
            const cue = titleTokens[0] || originalTitle.trim().slice(0, 30);
            const inChan = await safeCallTool(mcpManager, slackSearchTool, {
              query: `in:#${best.name} ${cue} after:${after}`,
              limit: 5,
            });
            if (inChan) {
              const msgs = parseSlackSearchBody(envelopeBody(inChan)).slice(0, 2);
              for (const msg of msgs) {
                hits.push({
                  source: 'channel',
                  label: `#${best.name} · search`,
                  detail: cleanSlackPrepText(msg.text).slice(0, 140) || '(no text)',
                  url: msg.link,
                });
              }
            }
          }
        })()
      );
    }
  }

  // Prior Zoom / local meetings — search then deepen via get()
  if (meetingService) {
    markConnector(connectors, 'meeting', 'Meetings', 'checked');
    tasks.push(
      (async () => {
        try {
          const searchQueries = [
            originalTitle.trim().slice(0, 60),
            ...focusAttendees.flatMap((a) =>
              [displayName(a), a.email].filter((x) => x && x.length >= 2)
            ),
            ...tokens.slice(0, 2),
          ].filter(Boolean) as string[];

          const foundIds = new Set<string>();
          const found: Array<{ id: string; title: string; status: string; summary?: string }> =
            [];
          for (const q of searchQueries.slice(0, 4)) {
            for (const m of meetingService.search(q, 3)) {
              if (foundIds.has(m.id)) continue;
              foundIds.add(m.id);
              found.push(m);
              if (found.length >= 4) break;
            }
            if (found.length >= 4) break;
          }

          for (const m of found.slice(0, 2)) {
            const full = meetingService.get(m.id);
            const hit = formatPriorMeetingHit(
              full
                ? {
                    id: full.id,
                    title: full.notes?.title || full.title,
                    status: full.status,
                    startedAt: full.startedAt,
                    summary: full.notes?.summary || m.summary,
                    notes: full.notes,
                  }
                : {
                    id: m.id,
                    title: m.title,
                    status: m.status,
                    summary: m.summary,
                  }
            );
            hits.push(hit);
            if (!topicHint && m.title && !isVagueMeetingTitle(m.title)) {
              topicHint = cleanTopicHint(m.title);
            }
          }
        } catch (error) {
          logWarn('[Matter] Prior meeting search failed:', error);
        }
      })()
    );
  } else {
    markConnector(connectors, 'meeting', 'Meetings', 'skipped', 'unavailable');
  }

  // Hub people / leave
  const hubId = resolveHubServerIdLocal(mcpManager);
  if (hubId) {
    markConnector(connectors, 'hub', 'Hub', 'checked');
    tasks.push(
      (async () => {
        const leaveTool = findToolName(mcpManager, hubId, [
          'get_leave_wfh_calendar',
          'list_leave_wfh',
        ]);
        if (leaveTool) {
          const leaveText = await safeCallTool(mcpManager, leaveTool, {});
          if (leaveText) {
            const summary = summarizeHubLeaveCalendar(leaveText, emails);
            if (summary) {
              hits.push({
                source: 'hub',
                label: 'Leave / WFH',
                detail: summary.slice(0, 320),
              });
            }
          }
        }
        const empTool = findToolName(mcpManager, hubId, [
          'list_employees',
          'search_employees',
          'get_employee',
        ]);
        if (empTool) {
          for (const email of emails.slice(0, 3)) {
            const empText = await safeCallTool(mcpManager, empTool, {
              email,
              query: email,
              search: email,
              limit: 3,
            });
            if (!empText) continue;
            const summary = summarizeHubEmployee(empText, email);
            if (!summary) continue;
            hits.push({
              source: 'hub',
              label: email,
              detail: summary.slice(0, 200),
            });
          }
        }
      })()
    );
  } else {
    markConnector(connectors, 'hub', 'Hub', 'skipped', 'disconnected');
  }

  // Drive
  if (isServerConnected(mcpManager, DEFAULT_GOOGLE_DRIVE_MCP_SERVER_ID)) {
    const searchTool = findToolName(mcpManager, DEFAULT_GOOGLE_DRIVE_MCP_SERVER_ID, [
      'search_files',
      'list_files',
    ]);
    if (searchTool && originalTitle.trim().length > 2) {
      markConnector(connectors, 'drive', 'Drive', 'checked');
      tasks.push(
        (async () => {
          const text = await safeCallTool(mcpManager, searchTool, {
            query: originalTitle.trim().slice(0, 60),
            q: originalTitle.trim().slice(0, 60),
            limit: 5,
          });
          if (!text) return;
          const lines = envelopeBody(text)
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean)
            .slice(0, 3);
          for (const line of lines) {
            hits.push({
              source: 'drive',
              label: line.slice(0, 80),
              detail: 'Drive search hit',
              url: extractUrl(line),
            });
          }
        })()
      );
    } else {
      markConnector(connectors, 'drive', 'Drive', 'empty', 'no tool or title');
    }
  } else {
    markConnector(connectors, 'drive', 'Drive', 'skipped', 'disconnected');
  }

  // Jira / Launchpad / Confluence — only when delivery-ish
  if (delivery) {
    if (isServerConnected(mcpManager, DEFAULT_JIRA_MCP_SERVER_ID)) {
      const jiraTool = findToolName(mcpManager, DEFAULT_JIRA_MCP_SERVER_ID, [
        'searchJiraIssuesUsingJql',
        'search_issues',
      ]);
      if (jiraTool) {
        markConnector(connectors, 'jira', 'Jira', 'checked');
        tasks.push(
          (async () => {
            const jql = `text ~ "${originalTitle.replace(/"/g, '').slice(0, 40)}" ORDER BY updated DESC`;
            const text = await safeCallTool(mcpManager, jiraTool, { jql, maxResults: 3, limit: 3 });
            if (!text) return;
            const lines = envelopeBody(text)
              .split('\n')
              .map((l) => l.trim())
              .filter(Boolean)
              .slice(0, 3);
            for (const line of lines) {
              hits.push({
                source: 'jira',
                label: line.slice(0, 80),
                detail: 'Jira search hit',
                url: extractUrl(line),
              });
            }
          })()
        );
      } else {
        markConnector(connectors, 'jira', 'Jira', 'empty', 'no tool');
      }
    } else {
      markConnector(connectors, 'jira', 'Jira', 'skipped', 'disconnected');
    }

    if (isServerConnected(mcpManager, DEFAULT_LAUNCHPAD_MCP_SERVER_ID)) {
      const lpTool = findToolName(mcpManager, DEFAULT_LAUNCHPAD_MCP_SERVER_ID, [
        'list_projects',
        'search',
        'list_releases',
      ]);
      if (lpTool) {
        markConnector(connectors, 'launchpad', 'Launchpad', 'checked');
        tasks.push(
          (async () => {
            const text = await safeCallTool(mcpManager, lpTool, {
              query: originalTitle.slice(0, 40),
              limit: 5,
            });
            if (!text) return;
            const line = envelopeBody(text).split('\n').find((l) => l.trim());
            if (line) {
              hits.push({
                source: 'launchpad',
                label: line.slice(0, 80),
                detail: 'Launchpad hit',
              });
            }
          })()
        );
      } else {
        markConnector(connectors, 'launchpad', 'Launchpad', 'empty', 'no tool');
      }
    } else {
      markConnector(connectors, 'launchpad', 'Launchpad', 'skipped', 'disconnected');
    }

    if (isServerConnected(mcpManager, DEFAULT_CONFLUENCE_MCP_SERVER_ID)) {
      const confTool = findToolName(mcpManager, DEFAULT_CONFLUENCE_MCP_SERVER_ID, [
        'searchConfluenceUsingCql',
        'search',
      ]);
      if (confTool) {
        markConnector(connectors, 'confluence', 'Confluence', 'checked');
        tasks.push(
          (async () => {
            const cql = `text ~ "${originalTitle.replace(/"/g, '').slice(0, 40)}"`;
            const text = await safeCallTool(mcpManager, confTool, { cql, limit: 3 });
            if (!text) return;
            const line = envelopeBody(text).split('\n').find((l) => l.trim());
            if (line) {
              hits.push({
                source: 'confluence',
                label: line.slice(0, 80),
                detail: 'Confluence hit',
                url: extractUrl(line),
              });
            }
          })()
        );
      } else {
        markConnector(connectors, 'confluence', 'Confluence', 'empty', 'no tool');
      }
    } else {
      markConnector(connectors, 'confluence', 'Confluence', 'skipped', 'disconnected');
    }
  } else {
    markConnector(connectors, 'jira', 'Jira', 'skipped', 'not implied');
    markConnector(connectors, 'launchpad', 'Launchpad', 'skipped', 'not implied');
    markConnector(connectors, 'confluence', 'Confluence', 'skipped', 'not implied');
  }

  // Domain browse from invite links
  const browseUrls = extractBrowseUrls(`${inviteBody}\n${originalTitle}`);
  if (browseUrls.length) {
    markConnector(connectors, 'web', 'Domain browse', 'checked');
    tasks.push(
      (async () => {
        for (const url of browseUrls.slice(0, 2)) {
          try {
            const fetched = await fetchWebPage(url);
            hits.push({
              source: 'web',
              label: new URL(url).hostname,
              detail: htmlToPlainSnippet(fetched),
              url,
            });
          } catch (error) {
            logWarn('[Matter] Domain browse failed:', url, error);
          }
        }
      })()
    );
  } else {
    markConnector(connectors, 'web', 'Domain browse', 'skipped', 'no external links');
  }

  await Promise.all(tasks);

  // Dedupe hits
  const seen = new Set<string>();
  const uniqueHits: EnrichmentHit[] = [];
  for (const h of hits) {
    const key = `${h.source}:${h.label}:${h.detail.slice(0, 40)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueHits.push(h);
  }

  // Mark empty vs checked when no hits for a connector
  for (const c of connectors) {
    if (c.status !== 'checked') continue;
    const hasHit =
      c.id === 'web'
        ? uniqueHits.some((h) => h.source === 'web')
        : c.id === 'slack'
          ? uniqueHits.some((h) => h.source === 'slack' || h.source === 'channel')
          : uniqueHits.some((h) => h.source === c.id);
    if (!hasHit) {
      c.status = 'empty';
      c.reason = c.reason || 'no hits';
    }
  }

  const title = isVagueMeetingTitle(originalTitle)
    ? buildEnrichedMeetingTitle({
        originalTitle,
        attendees,
        topicHint,
      })
    : originalTitle.trim() || buildEnrichedMeetingTitle({ originalTitle, attendees, topicHint });

  const topCue =
    topicHint ||
    uniqueHits.find((h) => h.source === 'gmail' || h.source === 'slack')?.label ||
    null;
  const summaryParts = [
    when,
    attendees.length
      ? `w/ ${attendees
          .slice(0, 3)
          .map(displayName)
          .join(', ')}${attendees.length > 3 ? ` +${attendees.length - 3}` : ''}`
      : null,
    topCue ? topCue.slice(0, 80) : null,
  ].filter(Boolean);

  const prepNote = buildMeetingPrepNote({
    originalTitle,
    when,
    attendees,
    hits: uniqueHits,
    enrichedTitle: title,
    eventUrl,
    connectors,
  });

  return {
    title,
    summary: summaryParts.join(' · ').slice(0, 400),
    whyHint: 'Prep gathered from connected Slack, email, Hub, and related sources.',
    suggestedAction: 'Review the prep note, then join or decline.',
    prepNote,
    topicHint,
    hits: uniqueHits,
    connectors,
  };
}

/** @deprecated Use enrichCalendarMeeting — kept for callers/tests. */
export async function enrichVagueCalendarMeeting(options: {
  mcpManager: MCPManager;
  meetingService: MeetingService | null;
  originalTitle: string;
  when: string;
  attendees: CalendarAttendee[];
  eventUrl?: string;
  inviteBody?: string;
}): Promise<VagueMeetingEnrichment> {
  return enrichCalendarMeeting(options);
}
