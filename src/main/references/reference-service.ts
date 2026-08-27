import type { MCPManager } from '../mcp/mcp-manager';
import {
  DEFAULT_GOOGLE_DRIVE_MCP_SERVER_ID,
  DEFAULT_JIRA_MCP_SERVER_ID,
  DEFAULT_SLACK_MCP_SERVER_ID,
} from '../../shared/mcp-defaults';
import { extractJiraIssueKeys, jiraBrowseUrl, jiraSiteOriginFromUrl } from '../../shared/jira-urls';
import type {
  ExternalReferenceConnectorStatus,
  ExternalReferenceContent,
  ExternalReferenceResolveResult,
  ExternalReferenceSearchItem,
  ExternalReferenceSearchResult,
  ExternalReferenceSource,
} from '../../shared/external-reference';
import { EXTERNAL_REFERENCE_PROMPT_CAP } from '../../shared/external-reference';
import { parseExternalReferenceUrl } from '../../shared/external-reference-urls';
import { logWarn } from '../utils/logger';

function isServerConnected(mcpManager: MCPManager, serverId: string): boolean {
  try {
    return mcpManager.getServerStatus().some((s) => s.id === serverId && s.connected);
  } catch {
    return false;
  }
}

function findToolName(mcpManager: MCPManager, serverId: string, candidates: string[]): string | null {
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

function envelopeTitle(text: string): string | undefined {
  const parsed = parseJsonLoose(text);
  if (parsed && typeof parsed === 'object' && parsed !== null && 'title' in parsed) {
    const title = (parsed as { title?: unknown }).title;
    if (typeof title === 'string' && title.trim()) return title;
  }
  return undefined;
}

async function callToolText(
  mcpManager: MCPManager,
  toolName: string,
  args: Record<string, unknown>
): Promise<string> {
  const result = await mcpManager.callTool(toolName, args);
  return toolResultText(result);
}

function serverIdForSource(source: ExternalReferenceSource): string {
  if (source === 'drive') return DEFAULT_GOOGLE_DRIVE_MCP_SERVER_ID;
  if (source === 'slack') return DEFAULT_SLACK_MCP_SERVER_ID;
  return DEFAULT_JIRA_MCP_SERVER_ID;
}

function disconnectedResult(source: ExternalReferenceSource): ExternalReferenceSearchResult {
  const label = source === 'drive' ? 'Google Drive' : source === 'slack' ? 'Slack' : 'Jira';
  return {
    items: [],
    disconnected: true,
    error: `Connect ${label} in Settings to search and attach references.`,
  };
}

function driveSearchQuery(userQuery: string): string {
  const escaped = userQuery.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return `name contains '${escaped}' or fullText contains '${escaped}'`;
}

function parseDriveSearch(body: string): ExternalReferenceSearchItem[] {
  const items: ExternalReferenceSearchItem[] = [];
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(.*?)\s+\(([^)]+)\)\s+-\s+([a-zA-Z0-9_-]+)\s*$/);
    if (!match) continue;
    const name = match[1].trim();
    const mimeType = match[2].trim();
    const id = match[3].trim();
    items.push({
      source: 'drive',
      externalId: id,
      title: name || id,
      subtitle: mimeType.replace('application/vnd.google-apps.', '') || 'Drive',
      url: `https://drive.google.com/file/d/${id}/view`,
      meta: { fileId: id, mimeType },
    });
  }
  return items;
}

const SLACK_LINE_RE =
  /^([A-Z0-9]+)(?:\|#?([^\s[]+))?\s+\[([^\]]*)\]\s+([^:]+):\s*(.*)$/i;

function parseSlackSearch(body: string): ExternalReferenceSearchItem[] {
  const items: ExternalReferenceSearchItem[] = [];
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].trim().match(SLACK_LINE_RE);
    if (!match) continue;
    const channelId = match[1];
    const channelName = match[2] || channelId;
    const ts = match[3];
    const username = match[4].trim();
    const text = match[5].trim();
    let permalink: string | undefined;
    const next = lines[i + 1]?.trim() ?? '';
    if (next.toLowerCase().startsWith('link:')) {
      permalink = next.slice(5).trim();
      i += 1;
    }
    items.push({
      source: 'slack',
      externalId: `${channelId}:${ts}`,
      title: text || 'Slack message',
      subtitle: `${channelName} · ${username}`,
      url: permalink,
      meta: { channelId, ts, threadTs: ts, channelName, username },
    });
  }
  return items;
}

function parseJiraSearch(text: string): ExternalReferenceSearchItem[] {
  const parsed = parseJsonLoose(text);
  const bag: Array<Record<string, unknown>> = [];
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

  if (bag.length) {
    return bag.slice(0, 25).map((issue) => {
      const key = String(issue.key).toUpperCase();
      const fields =
        issue.fields && typeof issue.fields === 'object'
          ? (issue.fields as Record<string, unknown>)
          : issue;
      const summary =
        (typeof fields.summary === 'string' && fields.summary) ||
        (typeof issue.summary === 'string' && issue.summary) ||
        key;
      const self =
        typeof issue.self === 'string'
          ? issue.self
          : typeof fields.self === 'string'
            ? (fields.self as string)
            : undefined;
      const site = (self && jiraSiteOriginFromUrl(self)) || undefined;
      return {
        source: 'jira' as const,
        externalId: key,
        title: `${key}: ${summary}`,
        subtitle: 'Jira',
        url: jiraBrowseUrl(key, site),
        meta: { issueKey: key },
      };
    });
  }

  const items: ExternalReferenceSearchItem[] = [];
  for (const line of envelopeBody(text).split('\n')) {
    const m = line.match(/\b([A-Z][A-Z0-9]+-\d+)\b\s*[:-]?\s*(.*)$/i);
    if (!m) continue;
    const key = m[1].toUpperCase();
    items.push({
      source: 'jira',
      externalId: key,
      title: m[2]?.trim() ? `${key}: ${m[2].trim()}` : key,
      subtitle: 'Jira',
      url: jiraBrowseUrl(key),
      meta: { issueKey: key },
    });
  }
  if (items.length) return items.slice(0, 25);

  return extractJiraIssueKeys(text)
    .slice(0, 25)
    .map((key) => ({
      source: 'jira' as const,
      externalId: key,
      title: key,
      subtitle: 'Jira',
      url: jiraBrowseUrl(key),
      meta: { issueKey: key },
    }));
}

function jiraJql(userQuery: string): string {
  const trimmed = userQuery.trim();
  if (/^[A-Z][A-Z0-9]+-\d+$/i.test(trimmed)) {
    return `key = "${trimmed.toUpperCase()}"`;
  }
  const escaped = trimmed.replace(/"/g, '\\"').slice(0, 80);
  if (!escaped) {
    return 'assignee = currentUser() ORDER BY updated DESC';
  }
  return `text ~ "${escaped}" ORDER BY updated DESC`;
}

export function getExternalReferenceStatus(mcpManager: MCPManager): ExternalReferenceConnectorStatus {
  return {
    drive: isServerConnected(mcpManager, DEFAULT_GOOGLE_DRIVE_MCP_SERVER_ID),
    slack: isServerConnected(mcpManager, DEFAULT_SLACK_MCP_SERVER_ID),
    jira: isServerConnected(mcpManager, DEFAULT_JIRA_MCP_SERVER_ID),
  };
}

export async function searchExternalReferences(
  mcpManager: MCPManager,
  source: ExternalReferenceSource,
  query: string
): Promise<ExternalReferenceSearchResult> {
  if (!isServerConnected(mcpManager, serverIdForSource(source))) {
    return disconnectedResult(source);
  }

  try {
    if (source === 'drive') {
      const trimmed = query.trim();
      const tool = findToolName(mcpManager, DEFAULT_GOOGLE_DRIVE_MCP_SERVER_ID, ['search_files']);
      if (!tool) return { items: [], error: 'Drive search is not available yet.' };
      const text = await callToolText(mcpManager, tool, {
        query: trimmed ? driveSearchQuery(trimmed) : 'trashed = false',
        limit: 20,
      });
      return { items: parseDriveSearch(envelopeBody(text)).slice(0, 20) };
    }

    if (source === 'slack') {
      const trimmed = query.trim();
      if (!trimmed) return { items: [] };
      const tool = findToolName(mcpManager, DEFAULT_SLACK_MCP_SERVER_ID, ['search_messages']);
      if (!tool) return { items: [], error: 'Slack search is not available yet.' };
      const text = await callToolText(mcpManager, tool, { query: trimmed, limit: 20, sort: 'score' });
      return { items: parseSlackSearch(envelopeBody(text)).slice(0, 20) };
    }

    const tool = findToolName(mcpManager, DEFAULT_JIRA_MCP_SERVER_ID, [
      'searchJiraIssuesUsingJql',
      'searchatlassian',
      'search_issues',
    ]);
    if (!tool) return { items: [], error: 'Jira search is not available yet.' };
    const text = await callToolText(mcpManager, tool, {
      jql: jiraJql(query),
      maxResults: 15,
      limit: 15,
      query: query.trim() || 'assignee = currentUser()',
      fields: ['summary', 'status', 'priority', 'updated', 'issuetype'],
    });
    return { items: parseJiraSearch(text).slice(0, 20) };
  } catch (error) {
    logWarn('[References] search failed', source, error);
    return {
      items: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function capPrompt(text: string): string {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  if (trimmed.length <= EXTERNAL_REFERENCE_PROMPT_CAP) return trimmed;
  return `${trimmed.slice(0, EXTERNAL_REFERENCE_PROMPT_CAP)}…[truncated]`;
}

export async function resolveExternalReference(
  mcpManager: MCPManager,
  reference: Pick<ExternalReferenceContent, 'source' | 'externalId' | 'title' | 'url' | 'meta'>
): Promise<ExternalReferenceResolveResult> {
  const source = reference.source;
  if (!isServerConnected(mcpManager, serverIdForSource(source))) {
    return {
      text: '',
      title: reference.title,
      url: reference.url,
      error: disconnectedResult(source).error,
    };
  }

  try {
    if (source === 'drive') {
      const fileId = reference.meta?.fileId || reference.externalId;
      const tool =
        findToolName(mcpManager, DEFAULT_GOOGLE_DRIVE_MCP_SERVER_ID, ['get_document_content']) ||
        findToolName(mcpManager, DEFAULT_GOOGLE_DRIVE_MCP_SERVER_ID, ['get_file_metadata']);
      if (!tool) return { text: '', title: reference.title, url: reference.url, error: 'Drive is not available.' };
      const text = await callToolText(mcpManager, tool, { file_id: fileId });
      return {
        text: capPrompt(envelopeBody(text)),
        title: envelopeTitle(text) || reference.title,
        url: reference.url,
      };
    }

    if (source === 'slack') {
      const channelId = reference.meta?.channelId || reference.externalId.split(':')[0];
      const threadTs =
        reference.meta?.threadTs || reference.meta?.ts || reference.externalId.split(':')[1];
      const tool = findToolName(mcpManager, DEFAULT_SLACK_MCP_SERVER_ID, ['get_thread']);
      if (!tool || !channelId || !threadTs) {
        return {
          text: reference.title,
          title: reference.title,
          url: reference.url,
          error: tool ? undefined : 'Slack is not available.',
        };
      }
      const text = await callToolText(mcpManager, tool, {
        channel_id: channelId,
        thread_ts: threadTs,
      });
      return {
        text: capPrompt(envelopeBody(text)),
        title: envelopeTitle(text) || reference.title,
        url: reference.url,
      };
    }

    const issueKey = (reference.meta?.issueKey || reference.externalId).toUpperCase();
    const tool = findToolName(mcpManager, DEFAULT_JIRA_MCP_SERVER_ID, [
      'getJiraIssue',
      'fetchatlassian',
      'getVisibleJiraIssue',
    ]);
    if (!tool) {
      return { text: '', title: reference.title, url: reference.url, error: 'Jira is not available.' };
    }
    const text = await callToolText(mcpManager, tool, {
      issueIdOrKey: issueKey,
      issueKey,
      id: issueKey,
      cloudId: reference.meta?.cloudId,
    });
    return {
      text: capPrompt(envelopeBody(text) || text),
      title: envelopeTitle(text) || reference.title,
      url: reference.url || jiraBrowseUrl(issueKey),
    };
  } catch (error) {
    logWarn('[References] resolve failed', source, error);
    return {
      text: '',
      title: reference.title,
      url: reference.url,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function lookupExternalReferenceFromUrl(
  mcpManager: MCPManager,
  url: string
): Promise<ExternalReferenceSearchItem | null> {
  const parsed = parseExternalReferenceUrl(url);
  if (!parsed) return null;
  const resolved = await resolveExternalReference(mcpManager, {
    source: parsed.source,
    externalId: parsed.externalId,
    title: parsed.title || parsed.externalId,
    url: parsed.url,
    meta: parsed.meta,
  });
  return {
    source: parsed.source,
    externalId: parsed.externalId,
    title: resolved.title || parsed.title || parsed.externalId,
    url: resolved.url || parsed.url,
    subtitle: parsed.subtitle,
    meta: parsed.meta,
  };
}
