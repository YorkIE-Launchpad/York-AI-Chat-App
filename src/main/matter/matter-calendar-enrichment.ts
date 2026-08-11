/**
 * Vague calendar title detection + attendee fan-out for Matter prep notes.
 */

import type { MCPManager } from '../mcp/mcp-manager';
import type { MeetingService } from '../meetings/meeting-service';
import { logWarn } from '../utils/logger';
import {
  DEFAULT_GMAIL_MCP_SERVER_ID,
  DEFAULT_SLACK_MCP_SERVER_ID,
} from '../../shared/mcp-defaults';
import { MEETING_PREP_MARKER } from '../../shared/matter';

export { MEETING_PREP_MARKER };
export const MAX_VAGUE_ENRICHMENTS_PER_SCAN = 3;

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

export interface CalendarAttendee {
  name: string;
  email: string;
}

export interface EnrichmentHit {
  source: 'slack' | 'gmail' | 'channel' | 'meeting';
  label: string;
  detail: string;
  url?: string;
}

export interface VagueMeetingEnrichment {
  title: string;
  summary: string;
  whyHint: string;
  suggestedAction: string;
  prepNote: string;
  topicHint: string | null;
  hits: EnrichmentHit[];
}

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

export function buildMeetingPrepNote(input: {
  originalTitle: string;
  when: string;
  attendees: CalendarAttendee[];
  hits: EnrichmentHit[];
  enrichedTitle: string;
  eventUrl?: string;
}): string {
  const attendeeLine =
    input.attendees.length > 0
      ? input.attendees
          .map((a) => (a.email ? `${a.name} <${a.email}>` : a.name))
          .join(', ')
      : 'None listed';

  const bySource = (source: EnrichmentHit['source']) =>
    input.hits.filter((h) => h.source === source);

  const section = (heading: string, hits: EnrichmentHit[], empty: string) => {
    if (!hits.length) return [`### ${heading}`, empty];
    return [
      `### ${heading}`,
      ...hits.map((h) => {
        const link = h.url ? ` ([link](${h.url}))` : '';
        return `- ${h.label}: ${h.detail}${link}`;
      }),
    ];
  };

  const sources = input.hits
    .filter((h) => h.url)
    .map((h) => `- [${h.label}](${h.url})`);
  if (input.eventUrl) {
    sources.unshift(`- [Calendar event](${input.eventUrl})`);
  }

  return [
    MEETING_PREP_MARKER,
    '',
    `**Enriched title:** ${input.enrichedTitle}`,
    `**Original invite:** ${input.originalTitle || '(untitled)'}`,
    `**When:** ${input.when || 'unknown'}`,
    `**Attendees:** ${attendeeLine}`,
    '',
    ...section('Recent Slack', bySource('slack'), '- No recent Slack hits with attendees.'),
    '',
    ...section('Email', bySource('gmail'), '- No recent email with attendees.'),
    '',
    ...section(
      'Shared / related channels',
      bySource('channel'),
      '- No matching shared channels found.'
    ),
    '',
    ...section('Prior meetings', bySource('meeting'), '- No prior local meeting notes found.'),
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

function extractUrl(text: string): string | undefined {
  const match = text.match(/https?:\/\/[^\s"'<>]+/i);
  return match?.[0]?.replace(/[),.;]+$/, '');
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

function parseSlackHits(
  body: string,
  limit = 4
): Array<{ channel: string; user: string; text: string; link?: string }> {
  const lines = body.split('\n');
  const out: Array<{ channel: string; user: string; text: string; link?: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
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
      user: m[3].trim(),
      text: (m[4] || '').trim(),
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

function scoreChannelName(channelName: string, attendees: CalendarAttendee[]): number {
  const name = channelName.replace(/^#/, '').toLowerCase();
  if (!name || NOISE_CHANNELS.has(name)) return 0;
  let score = 0;
  for (const a of attendees) {
    const local = (a.email.split('@')[0] || '').toLowerCase().replace(/[._]/g, '');
    const parts = [local, ...displayName(a).toLowerCase().split(/\s+/), ...(a.name || '')
      .toLowerCase()
      .split(/\s+/)].filter((p) => p.length >= 3);
    for (const p of [...new Set(parts)]) {
      if (name.includes(p)) score += p.length >= 5 ? 3 : 2;
    }
  }
  return score;
}

/**
 * Fan out Slack / Gmail / channels / local meetings for a vague calendar invite.
 */
export async function enrichVagueCalendarMeeting(options: {
  mcpManager: MCPManager;
  meetingService: MeetingService | null;
  originalTitle: string;
  when: string;
  attendees: CalendarAttendee[];
  eventUrl?: string;
}): Promise<VagueMeetingEnrichment> {
  const { mcpManager, meetingService, originalTitle, when, attendees, eventUrl } = options;
  const hits: EnrichmentHit[] = [];
  let topicHint: string | null = null;
  const tokens = attendeeSearchTokens(attendees);
  const after = new Date(Date.now() - 14 * 864e5).toISOString().slice(0, 10);

  const tasks: Array<Promise<void>> = [];

  // Slack message search (up to 2 queries)
  if (isServerConnected(mcpManager, DEFAULT_SLACK_MCP_SERVER_ID) && tokens.length) {
    const slackTool = findToolName(mcpManager, DEFAULT_SLACK_MCP_SERVER_ID, [
      'search_messages',
      'search_public_and_private',
      'search_public',
    ]);
    if (slackTool) {
      const queries = [
        `${tokens.slice(0, 3).join(' OR ')} after:${after}`,
        originalTitle.trim().length > 2
          ? `"${originalTitle.trim().slice(0, 40)}" ${tokens[0] || ''} after:${after}`.trim()
          : '',
      ].filter(Boolean).slice(0, 2);

      for (const query of queries) {
        tasks.push(
          (async () => {
            const text = await safeCallTool(mcpManager, slackTool, { query, limit: 8 });
            if (!text) return;
            const msgs = parseSlackHits(envelopeBody(text), 3);
            for (const msg of msgs) {
              const channelLabel = /^[CGD][A-Z0-9]{8,}$/i.test(msg.channel)
                ? 'channel'
                : msg.channel.replace(/^#/, '');
              const preview = msg.text.slice(0, 140) || '(no text)';
              hits.push({
                source: 'slack',
                label: `#${channelLabel} · ${msg.user}`,
                detail: preview,
                url: msg.link,
              });
              if (!topicHint) topicHint = cleanTopicHint(msg.text);
            }
          })()
        );
      }
    }
  }

  // Gmail search by attendee emails
  const emails = attendees.map((a) => a.email).filter(Boolean).slice(0, 4);
  if (isServerConnected(mcpManager, DEFAULT_GMAIL_MCP_SERVER_ID) && emails.length) {
    const searchTool = findToolName(mcpManager, DEFAULT_GMAIL_MCP_SERVER_ID, [
      'search_emails',
      'list_messages',
    ]);
    if (searchTool) {
      tasks.push(
        (async () => {
          const fromTo = emails.map((e) => `from:${e} OR to:${e}`).join(' OR ');
          const query = `newer_than:14d (${fromTo})`;
          const searchText = await safeCallTool(mcpManager, searchTool, { query, limit: 5 });
          if (!searchText) return;
          const body = envelopeBody(searchText);
          const ids = body
            .split(/\n/)
            .map((l) => l.trim())
            .filter((l) => /^[a-zA-Z0-9_-]{6,}$/.test(l))
            .slice(0, 2);

          const getTool = findToolName(mcpManager, DEFAULT_GMAIL_MCP_SERVER_ID, [
            'get_email',
            'get_message',
          ]);
          for (const id of ids) {
            let subject = `Email ${id.slice(0, 8)}…`;
            let snippet = '';
            const url = `https://mail.google.com/mail/u/0/#all/${id}`;
            if (getTool) {
              const detail = await safeCallTool(mcpManager, getTool, { message_id: id });
              if (detail) {
                const raw = parseJsonLoose(detail) || detail;
                const env = typeof raw === 'object' && raw ? (raw as Record<string, unknown>) : null;
                if (typeof env?.title === 'string' && env.title.trim()) subject = env.title.trim();
                if (typeof env?.summary === 'string' && env.summary.trim()) {
                  snippet = env.summary.trim().slice(0, 160);
                } else if (typeof env?.body === 'string') {
                  snippet = env.body.trim().slice(0, 160);
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
    }
  }

  // Shared / related Slack channels by name score
  if (isServerConnected(mcpManager, DEFAULT_SLACK_MCP_SERVER_ID) && attendees.length) {
    const listTool = findToolName(mcpManager, DEFAULT_SLACK_MCP_SERVER_ID, ['list_channels']);
    const histTool = findToolName(mcpManager, DEFAULT_SLACK_MCP_SERVER_ID, [
      'get_channel_history',
      'conversations_history',
    ]);
    if (listTool) {
      tasks.push(
        (async () => {
          const text = await safeCallTool(mcpManager, listTool, { limit: 80 });
          if (!text) return;
          const lines = envelopeBody(text)
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean);
          let best: { name: string; id: string; score: number } | null = null;
          for (const line of lines) {
            // "name: purpose" or "name (id): …"
            const m =
              line.match(/^#?([A-Za-z0-9_-]+)\s*(?:\(([^)]+)\))?\s*:\s*(.*)$/) ||
              line.match(/^#?([A-Za-z0-9_-]+)\s*$/);
            if (!m) continue;
            const channelName = m[1];
            const score = scoreChannelName(channelName, attendees);
            if (score <= 0) continue;
            if (!best || score > best.score) {
              best = { name: channelName, id: m[2] || channelName, score };
            }
          }
          if (!best) return;
          let detail = `Matched channel name (score ${best.score})`;
          if (histTool) {
            const hist = await safeCallTool(mcpManager, histTool, {
              channel_id: best.id,
              limit: 5,
            });
            if (hist) {
              const msgs = parseSlackHits(envelopeBody(hist), 2);
              if (msgs.length) {
                detail = msgs.map((msg) => msg.text.slice(0, 100)).join(' · ') || detail;
                if (!topicHint && msgs[0]?.text) topicHint = cleanTopicHint(msgs[0].text);
              } else {
                const bodyPreview = envelopeBody(hist).split('\n').find((l) => l.trim()) || '';
                if (bodyPreview) detail = bodyPreview.slice(0, 160);
              }
            }
          }
          hits.push({
            source: 'channel',
            label: `#${best.name}`,
            detail,
          });
        })()
      );
    }
  }

  // Prior local meetings
  if (meetingService && tokens.length) {
    tasks.push(
      (async () => {
        try {
          const query = tokens.slice(0, 2).join(' ') || originalTitle;
          const found = meetingService.search(query, 2);
          for (const m of found) {
            hits.push({
              source: 'meeting',
              label: m.title || m.id,
              detail: m.summary?.slice(0, 160) || `Prior meeting · ${m.status}`,
            });
            if (!topicHint && m.title && !isVagueMeetingTitle(m.title)) {
              topicHint = cleanTopicHint(m.title);
            }
          }
        } catch (error) {
          logWarn('[Matter] Prior meeting search failed:', error);
        }
      })()
    );
  }

  await Promise.all(tasks);

  // Dedupe hits by label+detail prefix
  const seen = new Set<string>();
  const uniqueHits: EnrichmentHit[] = [];
  for (const h of hits) {
    const key = `${h.source}:${h.label}:${h.detail.slice(0, 40)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueHits.push(h);
  }

  const title = buildEnrichedMeetingTitle({
    originalTitle,
    attendees,
    topicHint,
  });
  const topCue =
    topicHint ||
    uniqueHits.find((h) => h.source === 'gmail' || h.source === 'slack')?.label ||
    null;
  const summaryParts = [
    when,
    originalTitle ? `Originally “${originalTitle}”` : null,
    topCue ? topCue.slice(0, 80) : null,
  ].filter(Boolean);

  const prepNote = buildMeetingPrepNote({
    originalTitle,
    when,
    attendees,
    hits: uniqueHits,
    enrichedTitle: title,
    eventUrl,
  });

  return {
    title,
    summary: summaryParts.join(' · ').slice(0, 400),
    whyHint: 'Vague invite — prep from recent Slack/email with attendees.',
    suggestedAction: 'Review prep note, then join or decline.',
    prepNote,
    topicHint,
    hits: uniqueHits,
  };
}
