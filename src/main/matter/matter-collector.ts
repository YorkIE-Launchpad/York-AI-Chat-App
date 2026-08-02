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
import type { MCPManager } from '../mcp/mcp-manager';
import type { MeetingService } from '../meetings/meeting-service';
import { log, logWarn } from '../utils/logger';
import {
  DEFAULT_GMAIL_MCP_SERVER_ID,
  DEFAULT_GOOGLE_CALENDAR_MCP_SERVER_ID,
  DEFAULT_GOOGLE_DRIVE_MCP_SERVER_ID,
  DEFAULT_HUB_MCP_SERVER_ID,
  DEFAULT_JIRA_MCP_SERVER_ID,
  DEFAULT_LAUNCHPAD_MCP_SERVER_ID,
  DEFAULT_SLACK_MCP_SERVER_ID,
} from '../../shared/mcp-defaults';

const MAX_PER_SOURCE = 8;
const RAW_CAP = 4000;

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
  occurredAt?: number;
}): RawMatterSignal {
  const rawDetails = truncate(input.raw);
  const url = input.sourceRef?.url || extractUrl(rawDetails);
  return {
    fingerprint: input.fingerprint,
    source: input.source,
    title: input.title.trim().slice(0, 160) || 'Untitled item',
    summary: input.summary.trim().slice(0, 400),
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
    occurredAt: input.occurredAt,
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

async function collectCalendar(
  mcpManager: MCPManager,
  _profile: WelcomeProfile | null
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
  const events = parseCalendarLines(body).slice(0, MAX_PER_SOURCE);
  if (!events.length) return [];

  const getTool = findToolName(mcpManager, DEFAULT_GOOGLE_CALENDAR_MCP_SERVER_ID, ['get_event']);
  const detailed = await Promise.all(
    events.map(async (ev) => {
      let htmlLink: string | undefined;
      let startIso: string | undefined;
      let raw: unknown = ev;
      if (getTool && !ev.id.startsWith('line-')) {
        const detailText = await safeCallTool(mcpManager, getTool, { event_id: ev.id });
        if (detailText) {
          const parsed = parseJsonLoose(detailText) as Record<string, unknown> | null;
          const nested = parsed && typeof parsed === 'object' ? parsed : null;
          htmlLink = extractUrl(detailText);
          const bodyStr = typeof nested?.body === 'string' ? nested.body : detailText;
          // summarizeEvent line: id: Title (start → end)
          const whenMatch = bodyStr.match(/\(([^)]+→[^)]+)\)/);
          startIso = whenMatch?.[1]?.split('→')[0]?.trim() || ev.when.split('→')[0]?.trim();
          if (typeof nested?.title === 'string' && nested.title.trim()) {
            ev.title = nested.title.trim();
          }
          raw = nested || detailText;
        }
      }
      const startMs = parseIsoMs(startIso) ?? parseIsoMs(ev.when.split('→')[0]?.trim());
      const hoursUntil = startMs != null ? (startMs - Date.now()) / 36e5 : 48;
      const orbit: MatterOrbit = hoursUntil <= 4 ? 'now' : hoursUntil <= 36 ? 'today' : 'week';
      const severity: MatterSeverity =
        hoursUntil <= 2 ? 'critical' : hoursUntil <= 24 ? 'warning' : 'signal';

      return signal({
        fingerprint: `calendar:event:${ev.id}`,
        source: 'calendar',
        title: ev.title,
        summary: ev.when,
        raw,
        severityHint: severity,
        orbitHint: orbit,
        categoryHint: 'time',
        whyHint:
          hoursUntil <= 4
            ? 'Starts soon — prep or confirm attendance.'
            : 'On your calendar this week.',
        suggestedAction: 'Open the event and confirm agenda / prep.',
        sourceRef: {
          connectorId: DEFAULT_GOOGLE_CALENDAR_MCP_SERVER_ID,
          externalId: ev.id,
          label: 'Calendar',
          url: htmlLink,
        },
        muteKeys: [`calendar:event:${ev.id}`, 'source:calendar'],
        occurredAt: startMs,
      });
    })
  );

  return detailed;
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
  const query = me
    ? `${me} after:${new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10)}`
    : 'is:dm';
  const text = await safeCallTool(mcpManager, tool, {
    query,
    limit: 15,
  });
  if (!text) return [];

  const body = envelopeBody(text);
  const messages = parseSlackMessages(body).slice(0, MAX_PER_SOURCE);
  if (!messages.length) {
    // Fallback: if API returned unstructured text with a link, still emit one concrete row
    const url = extractUrl(body);
    if (!url && body.length < 40) return [];
    return [
      signal({
        fingerprint: `slack:snippet:${hashKey(body.slice(0, 120))}`,
        source: 'slack',
        title: truncate(body.split('\n')[0] || 'Slack message', 120),
        summary: truncate(body, 280),
        raw: text,
        severityHint: 'warning',
        orbitHint: 'today',
        categoryHint: 'comms',
        whyHint: 'This Slack item may need a reply.',
        suggestedAction: 'Open in Slack and reply or snooze.',
        sourceRef: {
          connectorId: DEFAULT_SLACK_MCP_SERVER_ID,
          label: 'Slack',
          url,
        },
        muteKeys: ['source:slack'],
      }),
    ];
  }

  return messages.map((msg) => {
    const preview = msg.text.slice(0, 100) || '(no text)';
    const title = `${msg.user} in #${msg.channel.replace(/^#/, '')}: ${preview}`;
    return signal({
      fingerprint: `slack:msg:${msg.channel}:${msg.ts}`,
      source: 'slack',
      title,
      summary: msg.text.slice(0, 280) || `Message from ${msg.user}`,
      raw: msg,
      severityHint: /[?]|\bplease\b|\bcan you\b|\bneed\b/i.test(msg.text) ? 'warning' : 'signal',
      orbitHint: 'today',
      categoryHint: 'comms',
      whyHint: 'Specific Slack message that may need your reply.',
      suggestedAction: 'Reply in thread or mark handled.',
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

// ── Gmail: one signal per unread email ──────────────────────────────────────

async function collectGmail(
  mcpManager: MCPManager,
  _profile: WelcomeProfile | null
): Promise<RawMatterSignal[]> {
  const searchTool = findToolName(mcpManager, DEFAULT_GMAIL_MCP_SERVER_ID, [
    'search_emails',
    'list_messages',
  ]);
  if (!searchTool) return [];

  const searchText = await safeCallTool(mcpManager, searchTool, {
    query: 'is:unread newer_than:7d',
    limit: 12,
  });
  if (!searchText) return [];

  const body = envelopeBody(searchText);
  const ids = body
    .split(/\n/)
    .map((l) => l.trim())
    .filter((l) => /^[a-zA-Z0-9_-]{6,}$/.test(l))
    .slice(0, MAX_PER_SOURCE);

  // Also try JSON arrays of ids
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

    signals.push(
      signal({
        fingerprint: `gmail:msg:${id}`,
        source: 'gmail',
        title: subject,
        summary:
          [from && `From ${from}`, snippet && snippet !== subject ? snippet : '']
            .filter(Boolean)
            .join(' — ')
            .slice(0, 400) || 'Unread email',
        raw,
        severityHint: /urgent|asap|action required|invoice|blocked/i.test(`${subject} ${snippet}`)
          ? 'warning'
          : 'signal',
        orbitHint: 'today',
        categoryHint: 'comms',
        whyHint: 'Unread email that may need a reply or triage.',
        suggestedAction: 'Open in Gmail and reply or archive.',
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
  const jql = email
    ? `assignee = "${email}" AND statusCategory != Done ORDER BY updated DESC`
    : 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC';

  const text = await safeCallTool(mcpManager, tool, {
    jql,
    maxResults: 12,
    fields: ['summary', 'status', 'priority', 'updated', 'issuetype'],
  });
  if (!text) return [];

  const issues = extractJiraIssues(text).slice(0, MAX_PER_SOURCE);
  return issues.map((issue) => {
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
    const critical = /highest|blocker|critical|p0|p1/i.test(priority);
    const browse =
      extractUrl(truncate(issue)) ||
      (key ? `https://yorkblack.atlassian.net/browse/${key}` : undefined);

    return signal({
      fingerprint: `jira:issue:${key}`,
      source: 'jira',
      title: `${key}: ${summary}`,
      summary: [status && `Status: ${status}`, priority && `Priority: ${priority}`]
        .filter(Boolean)
        .join(' · '),
      raw: issue,
      severityHint: critical
        ? 'critical'
        : /in progress|selected/i.test(status)
          ? 'warning'
          : 'signal',
      orbitHint: critical ? 'now' : 'today',
      categoryHint: 'delivery',
      whyHint: 'Assigned Jira issue still open.',
      suggestedAction: 'Update status or unblock the next step.',
      sourceRef: {
        connectorId: DEFAULT_JIRA_MCP_SERVER_ID,
        externalId: key,
        label: 'Jira',
        url: browse,
      },
      muteKeys: [`jira:${key}`, 'source:jira'],
    });
  });
}

// ── Hub: one signal per leave / allocation row when parseable ───────────────

function parseHubPeople(text: string): string[] {
  const names: string[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.length > 80) continue;
    if (/^(No |Error|Here |Found|Result)/i.test(trimmed)) continue;
    // "Name — Leave" / "Name (WFH)" patterns
    const m = trimmed.match(/^[-*•]?\s*([A-Z][A-Za-z .'-]{2,40})(?:\s*[—\-:|(].*)?$/);
    if (m) names.push(m[1].trim());
  }
  return [...new Set(names)].slice(0, MAX_PER_SOURCE);
}

async function collectHub(
  mcpManager: MCPManager,
  profile: WelcomeProfile | null
): Promise<RawMatterSignal[]> {
  const signals: RawMatterSignal[] = [];
  const leaveTool = findToolName(mcpManager, DEFAULT_HUB_MCP_SERVER_ID, [
    'get_team_leave_calendar',
    'get_leave_balance',
    'list_pending_hub_requests',
  ]);
  if (leaveTool) {
    const text = await safeCallTool(mcpManager, leaveTool, {
      start_date: new Date().toISOString().slice(0, 10),
      end_date: new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10),
    });
    if (text) {
      const people = parseHubPeople(envelopeBody(text));
      if (people.length) {
        for (const name of people) {
          signals.push(
            signal({
              fingerprint: `hub:leave:${name.toLowerCase().replace(/\s+/g, '-')}:${new Date().toISOString().slice(0, 10)}`,
              source: 'hub',
              title: `${name} is OOO / on leave`,
              summary: 'Appears on the team leave calendar this week.',
              raw: { name, excerpt: truncate(text, 800) },
              severityHint: 'signal',
              orbitHint: 'week',
              categoryHint: 'people',
              whyHint: 'Plan around coverage if you depend on them.',
              suggestedAction: 'Check handoff or reschedule shared work.',
              sourceRef: {
                connectorId: DEFAULT_HUB_MCP_SERVER_ID,
                label: 'Hub',
              },
              muteKeys: [`hub:person:${name.toLowerCase()}`, 'source:hub'],
            })
          );
        }
      } else if (/leave|wfh|ooo|pto|vacation/i.test(text)) {
        // Last resort: still avoid a giant rollup — one short digest with raw for drill-in
        signals.push(
          signal({
            fingerprint: `hub:leave-digest:${new Date().toISOString().slice(0, 10)}`,
            source: 'hub',
            title: 'Team leave to review',
            summary: truncate(
              envelopeBody(text).split('\n').filter(Boolean)[0] || 'Leave calendar update',
              200
            ),
            raw: text,
            severityHint: 'signal',
            orbitHint: 'week',
            categoryHint: 'people',
            whyHint: 'Coverage may shift this week.',
            suggestedAction: 'Open Hub leave calendar.',
            sourceRef: { connectorId: DEFAULT_HUB_MCP_SERVER_ID, label: 'Hub' },
            muteKeys: ['source:hub'],
          })
        );
      }
    }
  }

  // Pending hub requests as discrete items if tool returns a list
  const reqTool = findToolName(mcpManager, DEFAULT_HUB_MCP_SERVER_ID, [
    'list_pending_hub_requests',
    'list_hub_requests',
  ]);
  if (reqTool && reqTool !== leaveTool) {
    const text = await safeCallTool(mcpManager, reqTool, {});
    if (text) {
      const lines = envelopeBody(text)
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 8 && l.length < 160)
        .slice(0, 5);
      for (const line of lines) {
        signals.push(
          signal({
            fingerprint: `hub:request:${hashKey(line)}`,
            source: 'hub',
            title: line,
            summary: 'Pending Hub request',
            raw: line,
            severityHint: 'warning',
            orbitHint: 'today',
            categoryHint: 'people',
            whyHint: 'A Hub request may be waiting on you.',
            suggestedAction: 'Approve, reject, or follow up in Hub.',
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

// ── Drive: one signal per file ──────────────────────────────────────────────

function parseDriveFiles(body: string): Array<{ id?: string; name: string; link?: string }> {
  const files: Array<{ id?: string; name: string; link?: string }> = [];
  const lines = body
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const link = extractUrl(line);
    const nameMatch = line.match(/^(?:[-*•]\s*)?(.+?)(?:\s+[—-]\s+|\s+\(|$)/);
    const name = (nameMatch?.[1] || line).replace(link || '', '').trim();
    if (!name || name.length < 3 || /^No |Error|Found \d/i.test(name)) continue;
    if (/^https?:/i.test(name)) continue;
    files.push({ name: name.slice(0, 120), link, id: link?.match(/\/d\/([^/]+)/)?.[1] });
  }
  // Dedupe by name
  const seen = new Set<string>();
  return files.filter((f) => {
    const k = f.name.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

async function collectDrive(mcpManager: MCPManager): Promise<RawMatterSignal[]> {
  const tool = findToolName(mcpManager, DEFAULT_GOOGLE_DRIVE_MCP_SERVER_ID, [
    'list_recent_files',
    'search_files',
    'list_files',
  ]);
  if (!tool) return [];
  const text = await safeCallTool(mcpManager, tool, { limit: 12, pageSize: 12 });
  if (!text) return [];
  const files = parseDriveFiles(envelopeBody(text)).slice(0, MAX_PER_SOURCE);
  return files.map((file) =>
    signal({
      fingerprint: `drive:file:${file.id || hashKey(file.name)}`,
      source: 'drive',
      title: file.name,
      summary: 'Recently active Drive file',
      raw: file,
      severityHint: 'signal',
      orbitHint: 'week',
      categoryHint: 'delivery',
      whyHint: 'Recent file activity may need your review.',
      suggestedAction: 'Open and check latest comments/edits.',
      sourceRef: {
        connectorId: DEFAULT_GOOGLE_DRIVE_MCP_SERVER_ID,
        externalId: file.id,
        label: 'Drive',
        url: file.link,
      },
      muteKeys: [`drive:file:${file.id || file.name}`, 'source:drive'],
    })
  );
}

// ── Launchpad: one signal per release/feature row ───────────────────────────

async function collectLaunchpad(mcpManager: MCPManager): Promise<RawMatterSignal[]> {
  const tool = findToolName(mcpManager, DEFAULT_LAUNCHPAD_MCP_SERVER_ID, [
    'list_releases',
    'get_active_release',
    'list_features',
  ]);
  if (!tool) return [];
  const text = await safeCallTool(mcpManager, tool, {});
  if (!text) return [];

  const body = envelopeBody(text);
  const lines = body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 6 && l.length < 160 && !/^Error/i.test(l))
    .slice(0, MAX_PER_SOURCE);

  if (!lines.length) return [];

  return lines.map((line, idx) => {
    const risky = /risk|blocked|failed|critical|overdue/i.test(line);
    return signal({
      fingerprint: `launchpad:item:${hashKey(line)}:${idx}`,
      source: 'launchpad',
      title: line,
      summary: 'Launchpad delivery item',
      raw: line,
      severityHint: risky ? 'warning' : 'signal',
      orbitHint: 'today',
      categoryHint: 'delivery',
      whyHint: 'Delivery item from R&D Launchpad.',
      suggestedAction: 'Check status in Launchpad.',
      sourceRef: {
        connectorId: DEFAULT_LAUNCHPAD_MCP_SERVER_ID,
        label: 'Launchpad',
        url: extractUrl(line),
      },
      muteKeys: ['source:launchpad'],
    });
  });
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

function hashKey(input: string): string {
  let h = 0;
  for (let i = 0; i < input.length; i++) h = (Math.imul(31, h) + input.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

const SOURCE_SERVER: Record<MatterConfigurableSource, string | null> = {
  calendar: DEFAULT_GOOGLE_CALENDAR_MCP_SERVER_ID,
  slack: DEFAULT_SLACK_MCP_SERVER_ID,
  gmail: DEFAULT_GMAIL_MCP_SERVER_ID,
  jira: DEFAULT_JIRA_MCP_SERVER_ID,
  hub: DEFAULT_HUB_MCP_SERVER_ID,
  meeting: null,
  drive: DEFAULT_GOOGLE_DRIVE_MCP_SERVER_ID,
  launchpad: DEFAULT_LAUNCHPAD_MCP_SERVER_ID,
};

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
      run('calendar', () => collectCalendar(mcpManager, profile)),
      run('slack', () => collectSlack(mcpManager, profile)),
      run('gmail', () => collectGmail(mcpManager, profile)),
      run('jira', () => collectJira(mcpManager, profile)),
      run('hub', () => collectHub(mcpManager, profile)),
      run('drive', () => collectDrive(mcpManager)),
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
