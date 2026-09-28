/**
 * Connector search primitives for meeting prep. Every hit becomes a
 * `PrepEvidence` entry with a full excerpt so synthesis can cite it.
 */

import type { MCPManager } from '../../mcp/mcp-manager';
import type { MeetingService } from '../../meetings/meeting-service';
import { fetchWebPage } from '../../tools/web-fetch';
import { logWarn } from '../../utils/logger';
import {
  DEFAULT_CONFLUENCE_MCP_SERVER_ID,
  DEFAULT_GMAIL_MCP_SERVER_ID,
  DEFAULT_GOOGLE_DRIVE_MCP_SERVER_ID,
  DEFAULT_JIRA_MCP_SERVER_ID,
  DEFAULT_LAUNCHPAD_MCP_SERVER_ID,
  DEFAULT_SLACK_MCP_SERVER_ID,
} from '../../../shared/mcp-defaults';
import {
  DELIVERY_TITLE_RE,
  YORK_EMAIL_RE,
  cleanSlackPrepText,
  displayName,
  extractBrowseUrls,
  parseSlackHistoryBody,
  parseSlackSearchBody,
  scoreChannelName,
  summarizeHubLeaveCalendar,
  titleSearchTokens,
  type ParsedSlackSearchMessage,
} from '../matter-calendar-enrichment';
import {
  envelopeBody,
  extractUrl,
  findToolName,
  htmlToPlainSnippet,
  isServerConnected,
  parseJsonLoose,
  resolveHubServerId,
  safeCallTool,
} from './connectors';
import type {
  CalendarAttendee,
  ConnectorPrepStatus,
  EvidencePool,
  MeetingPrepContext,
} from './types';

/** Tracks which connectors were queried and whether they produced evidence. */
export class ConnectorTracker {
  private readonly list: ConnectorPrepStatus[] = [];
  private readonly withHits = new Set<string>();

  mark(id: string, label: string, status: ConnectorPrepStatus['status'], reason?: string): void {
    const existing = this.list.find((c) => c.id === id);
    if (existing) {
      // Never downgrade a connector that was already queried.
      if (existing.status === 'checked' && status !== 'checked') return;
      existing.status = status;
      existing.reason = reason;
      return;
    }
    this.list.push({ id, label, status, reason });
  }

  hit(id: string): void {
    this.withHits.add(id);
  }

  snapshot(): ConnectorPrepStatus[] {
    return this.list.map((c) =>
      c.status === 'checked' && !this.withHits.has(c.id)
        ? { ...c, status: 'empty' as const, reason: c.reason || 'no hits' }
        : { ...c }
    );
  }
}

export interface GatherDeps {
  mcp: MCPManager;
  pool: EvidencePool;
  connectors: ConnectorTracker;
}

const CONNECTOR_LABELS: Record<string, string> = {
  slack: 'Slack',
  gmail: 'Gmail',
  drive: 'Drive',
  jira: 'Jira',
  launchpad: 'Launchpad',
  confluence: 'Confluence',
  hub: 'Hub',
  meeting: 'Meeting notes',
  calendar: 'Calendar',
  web: 'Web',
};

const CONNECTOR_SERVERS: Record<string, string> = {
  slack: DEFAULT_SLACK_MCP_SERVER_ID,
  gmail: DEFAULT_GMAIL_MCP_SERVER_ID,
  drive: DEFAULT_GOOGLE_DRIVE_MCP_SERVER_ID,
  jira: DEFAULT_JIRA_MCP_SERVER_ID,
  launchpad: DEFAULT_LAUNCHPAD_MCP_SERVER_ID,
  confluence: DEFAULT_CONFLUENCE_MCP_SERVER_ID,
};

const TOOL_HINTS: Record<string, string[]> = {
  slackSearch: ['search_messages', 'search_public_and_private', 'search_public'],
  slackThread: ['get_thread'],
  slackUser: ['get_user'],
  slackChannels: ['list_channels'],
  slackHistory: ['get_channel_history', 'conversations_history'],
  gmailSearch: ['search_emails', 'list_messages'],
  gmailGet: ['get_email', 'get_message'],
  drive: ['search_files', 'list_files'],
  jira: ['searchJiraIssuesUsingJql', 'search_issues'],
  launchpad: ['list_projects', 'search', 'list_releases'],
  confluence: ['searchConfluenceUsingCql', 'search'],
};

/**
 * Resolve a connector tool, recording the connector as checked/skipped.
 * Returns null when the connector is disconnected or lacks the tool.
 */
export function resolveConnectorTool(
  deps: GatherDeps,
  connectorId: keyof typeof CONNECTOR_SERVERS,
  hintKey: keyof typeof TOOL_HINTS
): string | null {
  const label = CONNECTOR_LABELS[connectorId] || connectorId;
  const serverId = CONNECTOR_SERVERS[connectorId];
  if (!serverId || !isServerConnected(deps.mcp, serverId)) {
    deps.connectors.mark(connectorId, label, 'skipped', 'disconnected');
    return null;
  }
  const tool = findToolName(deps.mcp, serverId, TOOL_HINTS[hintKey]);
  if (!tool) {
    deps.connectors.mark(connectorId, label, 'skipped', 'no tool');
    return null;
  }
  deps.connectors.mark(connectorId, label, 'checked');
  return tool;
}

export function isoDate(input: string | number | Date | null | undefined): string | undefined {
  if (input == null || input === '') return undefined;
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString().slice(0, 10);
}

function slackTsDate(ts: string): string | undefined {
  const seconds = Number.parseFloat(ts);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return isoDate(seconds * 1000);
}

function slackPlace(msg: ParsedSlackSearchMessage): string {
  const isDm = /^D/i.test(msg.channel);
  const label = (msg.channelLabel || '').trim();
  const opaque = /^[CGD][A-Z0-9]{8,}$/i.test(label);
  if (isDm) return label && !opaque && !/^D/i.test(label) ? `DM with ${label}` : 'DM';
  return label && !opaque ? `#${label.replace(/^#/, '')}` : 'channel';
}

export interface SearchOptions {
  limit?: number;
  maxHits?: number;
  tags?: string[];
}

/** Slack search → evidence ids. Optionally deepens the top threads. */
export async function searchSlack(
  deps: GatherDeps,
  query: string,
  options: SearchOptions & { deepenThreads?: number } = {}
): Promise<string[]> {
  const tool = resolveConnectorTool(deps, 'slack', 'slackSearch');
  if (!tool) return [];
  const text = await safeCallTool(deps.mcp, tool, { query, limit: options.limit ?? 8 });
  if (!text) return [];
  const msgs = parseSlackSearchBody(envelopeBody(text)).slice(0, options.maxHits ?? 3);
  const ids: string[] = [];
  const threadTool =
    options.deepenThreads && options.deepenThreads > 0
      ? findToolName(deps.mcp, DEFAULT_SLACK_MCP_SERVER_ID, TOOL_HINTS.slackThread)
      : null;
  let deepened = 0;
  for (const msg of msgs) {
    let excerpt = `${msg.user}: ${cleanSlackPrepText(msg.text)}`;
    if (
      threadTool &&
      deepened < (options.deepenThreads ?? 0) &&
      /^[CDG][A-Z0-9]/i.test(msg.channel)
    ) {
      const thread = await safeCallTool(deps.mcp, threadTool, {
        channel_id: msg.channel,
        thread_ts: msg.ts,
      });
      const replies = thread ? parseSlackHistoryBody(envelopeBody(thread), 6) : [];
      if (replies.length > 1) {
        deepened += 1;
        excerpt = replies.map((r) => `${r.user}: ${cleanSlackPrepText(r.text)}`).join(' | ');
      }
    }
    const when = slackTsDate(msg.ts);
    ids.push(
      deps.pool.add({
        source: 'slack',
        title: `Slack ${slackPlace(msg)}${when ? `, ${when}` : ''}`,
        excerpt,
        url: msg.link,
        when,
        people: [msg.user],
        tags: options.tags,
      })
    );
  }
  if (ids.length) deps.connectors.hit('slack');
  return ids;
}

/** Gmail search → fetch bodies → evidence ids. */
export async function searchGmail(
  deps: GatherDeps,
  query: string,
  options: SearchOptions = {}
): Promise<string[]> {
  const tool = resolveConnectorTool(deps, 'gmail', 'gmailSearch');
  if (!tool) return [];
  const text = await safeCallTool(deps.mcp, tool, { query, limit: options.limit ?? 6 });
  if (!text) return [];
  const messageIds: string[] = [];
  for (const line of envelopeBody(text).split(/\n/)) {
    const id = line.trim().split(/\s+/)[0] || '';
    if (/^[a-zA-Z0-9_-]{6,}$/.test(id) && !messageIds.includes(id)) messageIds.push(id);
  }
  const getTool = findToolName(deps.mcp, DEFAULT_GMAIL_MCP_SERVER_ID, TOOL_HINTS.gmailGet);
  const ids: string[] = [];
  for (const messageId of messageIds.slice(0, options.maxHits ?? 3)) {
    let subject = 'Email thread';
    let excerpt = '';
    let when: string | undefined;
    if (getTool) {
      const detail = await safeCallTool(deps.mcp, getTool, {
        message_id: messageId,
        id: messageId,
      });
      const env = detail ? parseJsonLoose(detail) : null;
      const rec = env && typeof env === 'object' ? (env as Record<string, unknown>) : null;
      if (typeof rec?.title === 'string' && rec.title.trim()) subject = rec.title.trim();
      const body =
        (typeof rec?.body === 'string' && rec.body) ||
        (typeof rec?.summary === 'string' && rec.summary) ||
        (!rec && detail) ||
        '';
      excerpt = body
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (typeof rec?.occurredAt === 'number') when = isoDate(rec.occurredAt);
    }
    ids.push(
      deps.pool.add({
        source: 'gmail',
        title: `Email: ${subject}${when ? `, ${when}` : ''}`,
        excerpt: excerpt || subject,
        url: `https://mail.google.com/mail/u/0/#all/${messageId}`,
        when,
        tags: options.tags,
      })
    );
  }
  if (ids.length) deps.connectors.hit('gmail');
  return ids;
}

interface GenericRow {
  title: string;
  excerpt: string;
  url?: string;
}

/** Best-effort row extraction from Jira / Drive / Confluence / Launchpad payloads. */
export function extractGenericRows(text: string, max = 3): GenericRow[] {
  const body = envelopeBody(text);
  const json = parseJsonLoose(body) ?? parseJsonLoose(text);
  const rows: GenericRow[] = [];
  const visit = (node: unknown, depth: number): void => {
    if (rows.length >= max || depth > 5 || node == null) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    if (typeof node !== 'object') return;
    const rec = node as Record<string, unknown>;
    const fields = (rec.fields && typeof rec.fields === 'object' ? rec.fields : {}) as Record<
      string,
      unknown
    >;
    const key = typeof rec.key === 'string' ? rec.key : '';
    const name =
      [rec.title, rec.name, rec.summary, fields.summary].find(
        (v): v is string => typeof v === 'string' && v.trim().length > 0
      ) || '';
    if (name) {
      const status =
        (fields.status as { name?: string } | undefined)?.name ||
        (typeof rec.status === 'string' ? rec.status : '');
      const updated =
        (typeof fields.updated === 'string' && fields.updated) ||
        (typeof rec.updated === 'string' && rec.updated) ||
        (typeof rec.modifiedTime === 'string' && rec.modifiedTime) ||
        '';
      const url =
        [rec.url, rec.webViewLink, rec.link, rec.self].find(
          (v): v is string => typeof v === 'string' && /^https?:/.test(v)
        ) || undefined;
      rows.push({
        title: key ? `${key} ${name}` : name,
        excerpt: [status && `Status: ${status}`, updated && `Updated: ${updated.slice(0, 10)}`]
          .filter(Boolean)
          .join(' · '),
        url,
      });
      return;
    }
    for (const value of Object.values(rec)) visit(value, depth + 1);
  };
  if (json) visit(json, 0);
  if (!rows.length) {
    for (const line of body.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      rows.push({ title: trimmed.slice(0, 120), excerpt: trimmed, url: extractUrl(trimmed) });
      if (rows.length >= max) break;
    }
  }
  return rows.slice(0, max);
}

async function searchGeneric(
  deps: GatherDeps,
  connectorId: 'drive' | 'jira' | 'launchpad' | 'confluence',
  args: Record<string, unknown>,
  options: SearchOptions = {}
): Promise<string[]> {
  const tool = resolveConnectorTool(deps, connectorId, connectorId);
  if (!tool) return [];
  const text = await safeCallTool(deps.mcp, tool, args);
  if (!text) return [];
  const label = CONNECTOR_LABELS[connectorId];
  const ids = extractGenericRows(text, options.maxHits ?? 3).map((row) =>
    deps.pool.add({
      source: connectorId,
      title: `${label}: ${row.title}`,
      excerpt: row.excerpt || row.title,
      url: row.url,
      tags: options.tags,
    })
  );
  if (ids.length) deps.connectors.hit(connectorId);
  return ids;
}

function quoteless(text: string, max = 60): string {
  return text.replace(/["\\]/g, '').trim().slice(0, max);
}

export function searchJira(
  deps: GatherDeps,
  phrase: string,
  sinceIso: string | null,
  options: SearchOptions = {}
) {
  const since = sinceIso ? ` AND updated >= "${sinceIso.slice(0, 10)}"` : '';
  const jql = `text ~ "${quoteless(phrase)}"${since} ORDER BY updated DESC`;
  return searchGeneric(
    deps,
    'jira',
    { jql, maxResults: options.limit ?? 3, limit: options.limit ?? 3 },
    options
  );
}

export function searchDrive(deps: GatherDeps, phrase: string, options: SearchOptions = {}) {
  const q = quoteless(phrase);
  return searchGeneric(deps, 'drive', { query: q, q, limit: options.limit ?? 5 }, options);
}

export function searchConfluence(deps: GatherDeps, phrase: string, options: SearchOptions = {}) {
  return searchGeneric(
    deps,
    'confluence',
    { cql: `text ~ "${quoteless(phrase)}"`, limit: options.limit ?? 3 },
    options
  );
}

export function searchLaunchpad(deps: GatherDeps, phrase: string, options: SearchOptions = {}) {
  return searchGeneric(
    deps,
    'launchpad',
    { query: quoteless(phrase, 40), limit: options.limit ?? 5 },
    options
  );
}

/** Attendees other than the user and calendar resources. */
export function otherAttendees(
  attendees: CalendarAttendee[],
  selfEmail: string | null
): CalendarAttendee[] {
  const self = selfEmail?.toLowerCase() || '';
  return attendees.filter((a) => {
    const email = a.email.toLowerCase();
    if (self && email === self) return false;
    if (/resource\.calendar\.google\.com$|group\.calendar\.google\.com$/.test(email)) return false;
    return Boolean(email || a.name);
  });
}

export function impliesDeliveryWork(title: string, attendees: CalendarAttendee[]): boolean {
  if (DELIVERY_TITLE_RE.test(title)) return true;
  return attendees.some((a) => a.email && !YORK_EMAIL_RE.test(a.email));
}

function slackDate(iso: string): string {
  return iso.slice(0, 10);
}

function daysSince(iso: string): number {
  const ms = Date.now() - Date.parse(iso);
  return Math.max(1, Math.ceil(ms / 864e5));
}

/** Resolve Slack display handles for attendee emails (improves person queries). */
async function slackHandles(
  deps: GatherDeps,
  people: CalendarAttendee[]
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const userTool = isServerConnected(deps.mcp, DEFAULT_SLACK_MCP_SERVER_ID)
    ? findToolName(deps.mcp, DEFAULT_SLACK_MCP_SERVER_ID, TOOL_HINTS.slackUser)
    : null;
  if (!userTool) return out;
  for (const a of people) {
    if (!a.email) continue;
    const profile = await safeCallTool(deps.mcp, userTool, { user_id: a.email, email: a.email });
    const raw = profile ? (parseJsonLoose(envelopeBody(profile)) ?? parseJsonLoose(profile)) : null;
    const rec = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
    const handle =
      (typeof rec?.name === 'string' && rec.name) ||
      (typeof rec?.real_name === 'string' && rec.real_name) ||
      '';
    if (handle) out.set(a.email.toLowerCase(), handle);
  }
  return out;
}

/** Pick the most relevant shared Slack channel and pull its recent history. */
async function gatherChannelContext(
  deps: GatherDeps,
  ctx: MeetingPrepContext,
  people: CalendarAttendee[],
  sinceIso: string
): Promise<void> {
  if (!isServerConnected(deps.mcp, DEFAULT_SLACK_MCP_SERVER_ID) || !people.length) return;
  const listTool = findToolName(deps.mcp, DEFAULT_SLACK_MCP_SERVER_ID, TOOL_HINTS.slackChannels);
  const histTool = findToolName(deps.mcp, DEFAULT_SLACK_MCP_SERVER_ID, TOOL_HINTS.slackHistory);
  if (!listTool || !histTool) return;
  const text = await safeCallTool(deps.mcp, listTool, { limit: 100 });
  if (!text) return;
  const titleTokens = titleSearchTokens(ctx.title);
  const scored: Array<{ name: string; id: string; score: number }> = [];
  for (const line of envelopeBody(text)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)) {
    const pipe = line.match(/^([CG][A-Z0-9]+)\|#?([A-Za-z0-9_-]+)/i);
    const m =
      pipe ||
      line.match(/^#?([A-Za-z0-9_-]+)\s*(?:\(([^)]+)\))?\s*:\s*(.*)$/) ||
      line.match(/^#?([A-Za-z0-9_-]+)\s*$/);
    if (!m) continue;
    const name = pipe ? pipe[2] : m[1];
    const id = pipe ? pipe[1] : m[2] || name;
    const score = scoreChannelName(name, people, titleTokens);
    if (score > 0) scored.push({ name, id, score });
  }
  scored.sort((a, b) => b.score - a.score);
  let pick = scored[0];
  try {
    const { jevScoreCalendarChannel } = await import('../../jev/permissions-jev');
    const jev = await jevScoreCalendarChannel({
      meetingTitle: ctx.title,
      attendees: people.map((a) => a.email || a.name),
      channels: scored.slice(0, 12).map((c) => ({ id: c.id, name: c.name })),
    });
    const match = jev ? scored.find((c) => c.id === jev.channelId) : undefined;
    if (match) pick = match;
  } catch {
    // Lexical score stands.
  }
  if (!pick) return;
  const hist = await safeCallTool(deps.mcp, histTool, { channel_id: pick.id, limit: 12 });
  if (!hist) return;
  const sinceMs = Date.parse(sinceIso);
  const msgs = parseSlackHistoryBody(envelopeBody(hist), 12).filter((m) => {
    const ts = Number.parseFloat(m.ts) * 1000;
    return !Number.isFinite(ts) || ts >= sinceMs;
  });
  if (!msgs.length) return;
  const newest = slackTsDate(msgs[0].ts);
  deps.pool.add({
    source: 'slack',
    title: `Slack #${pick.name} recent history${newest ? `, ${newest}` : ''}`,
    excerpt: msgs
      .slice(0, 8)
      .map((m) => `${m.user}: ${cleanSlackPrepText(m.text)}`)
      .join(' | '),
    url: msgs.find((m) => m.link)?.link,
    when: newest,
    tags: ['channel'],
  });
  deps.connectors.hit('slack');
}

/**
 * Shared context sweep for both meeting kinds: people + topic across Slack,
 * Gmail, the best shared channel, Drive, delivery tools, invite links, Hub leave.
 */
export async function gatherMeetingContext(input: {
  deps: GatherDeps;
  ctx: MeetingPrepContext;
  meetingService: MeetingService | null;
  sinceIso: string;
  includeLocalMeetings: boolean;
}): Promise<void> {
  const { deps, ctx, meetingService, sinceIso, includeLocalMeetings } = input;
  const people = otherAttendees(ctx.attendees, ctx.selfEmail);
  const focus = [...people]
    .sort((a, b) => {
      const aExt = a.email && !YORK_EMAIL_RE.test(a.email) ? 0 : 1;
      const bExt = b.email && !YORK_EMAIL_RE.test(b.email) ? 0 : 1;
      return aExt - bExt;
    })
    .slice(0, 3);
  const title = ctx.title.trim();
  const titleTokens = titleSearchTokens(title);
  const specificTitle = titleTokens.length > 0;
  const after = slackDate(sinceIso);
  const days = daysSince(sinceIso);
  const tasks: Array<Promise<unknown>> = [];

  tasks.push(
    (async () => {
      const handles = await slackHandles(deps, focus.slice(0, 2));
      const queries: string[] = [];
      for (const a of focus.slice(0, 2)) {
        const handle = a.email ? handles.get(a.email.toLowerCase()) : '';
        const names = [...new Set([handle, displayName(a), a.email].filter(Boolean))].slice(0, 3);
        if (names.length) queries.push(`is:im (${names.join(' OR ')}) after:${after}`);
      }
      if (specificTitle) queries.push(`"${title.slice(0, 40)}" after:${after}`);
      for (const q of queries.slice(0, 4)) {
        await searchSlack(deps, q, { maxHits: 3, deepenThreads: 1 });
      }
    })()
  );

  const emails = focus.map((a) => a.email).filter(Boolean);
  if (emails.length || specificTitle) {
    tasks.push(
      (async () => {
        if (emails.length) {
          const fromTo = emails.map((e) => `from:${e} OR to:${e}`).join(' OR ');
          await searchGmail(deps, `newer_than:${days}d (${fromTo})`, { maxHits: 4 });
        }
        if (specificTitle) {
          await searchGmail(
            deps,
            `newer_than:${days}d subject:(${titleTokens.slice(0, 3).join(' ')})`,
            {
              maxHits: 2,
            }
          );
        }
      })()
    );
  }

  tasks.push(gatherChannelContext(deps, ctx, people, sinceIso));

  if (specificTitle) tasks.push(searchDrive(deps, titleTokens.join(' '), { maxHits: 2 }));

  if (impliesDeliveryWork(title, people) && specificTitle) {
    const phrase = titleTokens.slice(0, 3).join(' ');
    tasks.push(searchJira(deps, phrase, sinceIso, { maxHits: 3 }));
    tasks.push(searchLaunchpad(deps, phrase, { maxHits: 1 }));
    tasks.push(searchConfluence(deps, phrase, { maxHits: 2 }));
  }

  const browseUrls = extractBrowseUrls(`${ctx.inviteBody}\n${title}`, 2);
  if (browseUrls.length) {
    deps.connectors.mark('web', 'Web', 'checked');
    tasks.push(
      (async () => {
        for (const url of browseUrls) {
          try {
            const fetched = await fetchWebPage(url);
            deps.pool.add({
              source: 'web',
              title: `Invite link: ${new URL(url).hostname}`,
              excerpt: htmlToPlainSnippet(fetched, 600),
              url,
            });
            deps.connectors.hit('web');
          } catch (error) {
            logWarn('[Matter] Prep link fetch failed:', url, error);
          }
        }
      })()
    );
  }

  const hubId = resolveHubServerId(deps.mcp);
  if (hubId) {
    deps.connectors.mark('hub', 'Hub', 'checked');
    const leaveTool = findToolName(deps.mcp, hubId, ['get_leave_wfh_calendar', 'list_leave_wfh']);
    if (leaveTool) {
      tasks.push(
        (async () => {
          const text = await safeCallTool(deps.mcp, leaveTool, {});
          const emailsAll = people.map((a) => a.email).filter(Boolean);
          const summary = text ? summarizeHubLeaveCalendar(text, emailsAll) : null;
          if (summary && /^Attendees out/.test(summary)) {
            deps.pool.add({ source: 'hub', title: 'Hub leave / WFH calendar', excerpt: summary });
            deps.connectors.hit('hub');
          }
        })()
      );
    }
  } else {
    deps.connectors.mark('hub', 'Hub', 'skipped', 'disconnected');
  }

  if (includeLocalMeetings && meetingService) {
    deps.connectors.mark('meeting', 'Meeting notes', 'checked');
    tasks.push(
      (async () => {
        const seen = new Set<string>();
        const queries = [...focus.map((a) => displayName(a)), specificTitle ? title : '']
          .filter((q) => q && q.length >= 3)
          .slice(0, 3);
        for (const q of queries) {
          for (const item of meetingService.search(q, 2)) {
            if (seen.has(item.id) || seen.size >= 2) continue;
            seen.add(item.id);
            const full = meetingService.get(item.id);
            const notes = full?.notes;
            const excerpt = [
              notes?.summary || item.summary,
              notes?.keyTopics?.length ? `Topics: ${notes.keyTopics.join('; ')}` : '',
              notes?.actionItems?.length ? `Action items: ${notes.actionItems.join('; ')}` : '',
            ]
              .filter(Boolean)
              .join(' · ');
            if (!excerpt) continue;
            const when = isoDate(item.startedAt);
            deps.pool.add({
              source: 'meeting',
              title: `Meeting notes: ${notes?.title || item.title}${when ? `, ${when}` : ''}`,
              excerpt,
              when,
            });
            deps.connectors.hit('meeting');
          }
        }
      })()
    );
  }

  await Promise.all(tasks);
}
