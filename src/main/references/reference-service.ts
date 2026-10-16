import type { MCPManager } from '../mcp/mcp-manager';
import {
  DEFAULT_CONFLUENCE_MCP_SERVER_ID,
  DEFAULT_GOOGLE_DRIVE_MCP_SERVER_ID,
  DEFAULT_JIRA_MCP_SERVER_ID,
  DEFAULT_SLACK_MCP_SERVER_ID,
} from '../../shared/mcp-defaults';
import { confluenceCql, jiraJql } from '../../shared/atlassian-reference-query';
import { confluencePageUrl, confluenceSiteOriginFromUrl } from '../../shared/confluence-urls';
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
import { DRIVE_FOLDER_MIME, parseExternalReferenceUrl } from '../../shared/external-reference-urls';
import { logWarn } from '../utils/logger';

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
  if (source === 'confluence') return DEFAULT_CONFLUENCE_MCP_SERVER_ID;
  return DEFAULT_JIRA_MCP_SERVER_ID;
}

function disconnectedResult(source: ExternalReferenceSource): ExternalReferenceSearchResult {
  const label =
    source === 'drive'
      ? 'Google Drive'
      : source === 'slack'
        ? 'Slack'
        : source === 'confluence'
          ? 'Confluence'
          : 'Jira';
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
      url:
        mimeType === DRIVE_FOLDER_MIME
          ? `https://drive.google.com/drive/folders/${id}`
          : `https://drive.google.com/file/d/${id}/view`,
      meta: { fileId: id, mimeType },
    });
  }
  return items;
}

const DRIVE_EXPORTABLE_MIMES = new Set([
  'application/vnd.google-apps.document',
  'application/vnd.google-apps.spreadsheet',
  'application/vnd.google-apps.presentation',
  'application/json',
  'application/xml',
  'application/yaml',
  'application/x-yaml',
]);
const DRIVE_FOLDER_MAX_DEPTH = 3;
const DRIVE_FOLDER_LIST_LIMIT = 200;
const DRIVE_FOLDER_PROMPT_MAX_FILES = 25;
const DRIVE_FOLDER_FULL_MAX_FILES = 200;
const DRIVE_FOLDER_READ_CONCURRENCY = 4;
const DRIVE_FOLDER_MIN_FILE_CHARS = 1_500;
const DRIVE_FOLDER_PROMPT_CAP = EXTERNAL_REFERENCE_PROMPT_CAP * 4;
const DRIVE_FOLDER_SKIPPED_LIST_MAX = 50;
const DRIVE_ID_RE = /^[a-zA-Z0-9_-]+$/;

function isReadableDriveMime(mimeType: string): boolean {
  return mimeType.startsWith('text/') || DRIVE_EXPORTABLE_MIMES.has(mimeType);
}

type DriveFolderEntry = { id: string; path: string };

async function listDriveFolderFiles(
  mcpManager: MCPManager,
  searchTool: string,
  rootId: string,
  maxFiles: number
): Promise<{ files: DriveFolderEntry[]; skipped: string[] }> {
  const files: DriveFolderEntry[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>([rootId]);
  const queue: Array<{ id: string; path: string; depth: number }> = [
    { id: rootId, path: '', depth: 0 },
  ];
  while (queue.length > 0) {
    const folder = queue.shift()!;
    const text = await callToolText(mcpManager, searchTool, {
      query: `'${folder.id}' in parents and trashed = false`,
      limit: DRIVE_FOLDER_LIST_LIMIT,
    });
    const children = parseDriveSearch(envelopeBody(text)).sort((a, b) =>
      a.title.localeCompare(b.title)
    );
    for (const child of children) {
      const mimeType = child.meta?.mimeType ?? '';
      const path = `${folder.path}${child.title}`;
      if (mimeType === DRIVE_FOLDER_MIME) {
        if (folder.depth + 1 >= DRIVE_FOLDER_MAX_DEPTH) {
          skipped.push(`${path}/ (nested too deep)`);
        } else if (!seen.has(child.externalId)) {
          seen.add(child.externalId);
          queue.push({ id: child.externalId, path: `${path}/`, depth: folder.depth + 1 });
        }
        continue;
      }
      if (!isReadableDriveMime(mimeType)) {
        skipped.push(`${path} (unsupported type)`);
      } else if (files.length >= maxFiles) {
        skipped.push(`${path} (over the ${maxFiles}-file limit)`);
      } else {
        files.push({ id: child.externalId, path });
      }
    }
  }
  return { files, skipped };
}

async function driveFolderName(mcpManager: MCPManager, folderId: string): Promise<string | null> {
  const tool = findToolName(mcpManager, DEFAULT_GOOGLE_DRIVE_MCP_SERVER_ID, ['get_file_metadata']);
  if (!tool) return null;
  try {
    return envelopeTitle(await callToolText(mcpManager, tool, { file_id: folderId })) ?? null;
  } catch {
    return null;
  }
}

async function resolveDriveFolder(
  mcpManager: MCPManager,
  reference: Pick<ExternalReferenceContent, 'externalId' | 'title' | 'url' | 'meta'>,
  full: boolean
): Promise<ExternalReferenceResolveResult> {
  const folderId = reference.meta?.fileId || reference.externalId;
  const url = reference.url || `https://drive.google.com/drive/folders/${folderId}`;
  const searchTool = findToolName(mcpManager, DEFAULT_GOOGLE_DRIVE_MCP_SERVER_ID, ['search_files']);
  const contentTool = findToolName(mcpManager, DEFAULT_GOOGLE_DRIVE_MCP_SERVER_ID, [
    'get_document_content',
  ]);
  if (!DRIVE_ID_RE.test(folderId) || !searchTool || !contentTool) {
    return {
      text: '',
      title: reference.title,
      url,
      error: DRIVE_ID_RE.test(folderId) ? 'Drive is not available.' : 'Invalid Drive folder id.',
    };
  }

  const maxFiles = full ? DRIVE_FOLDER_FULL_MAX_FILES : DRIVE_FOLDER_PROMPT_MAX_FILES;
  const [title, listing] = await Promise.all([
    driveFolderName(mcpManager, folderId),
    listDriveFolderFiles(mcpManager, searchTool, folderId, maxFiles),
  ]);
  const { files, skipped } = listing;
  const perFileChars = full
    ? FULL_TEXT_CAP
    : Math.max(
        DRIVE_FOLDER_MIN_FILE_CHARS,
        Math.floor(DRIVE_FOLDER_PROMPT_CAP / Math.max(files.length, 1))
      );

  const sections: string[] = new Array(files.length);
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const index = next++;
      const file = files[index];
      try {
        const raw = envelopeBody(await callToolText(mcpManager, contentTool, { file_id: file.id }));
        const body = full ? raw.trim() : raw.replace(/\s+/g, ' ').trim();
        sections[index] = body
          ? `--- ${file.path} ---\n${body.length > perFileChars ? `${body.slice(0, perFileChars)}…[truncated]` : body}`
          : '';
        if (!body) skipped.push(`${file.path} (empty)`);
      } catch (error) {
        sections[index] = '';
        logWarn('[References] drive folder file read failed', file.path, error);
        skipped.push(`${file.path} (could not be read)`);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(DRIVE_FOLDER_READ_CONCURRENCY, files.length) }, worker)
  );

  const readSections = sections.filter(Boolean);
  const folderTitle = title || reference.title;
  if (readSections.length === 0) {
    return {
      text: '',
      title: folderTitle,
      url,
      error:
        skipped.length > 0
          ? `No readable files in this folder. Skipped: ${skipped.slice(0, 10).join(', ')}`
          : 'This folder is empty.',
    };
  }

  const parts = [
    `Google Drive folder "${folderTitle}": ${readSections.length} file(s) read${skipped.length ? `, ${skipped.length} skipped` : ''}.`,
  ];
  if (skipped.length > 0) {
    const listed = skipped.slice(0, DRIVE_FOLDER_SKIPPED_LIST_MAX);
    const more = skipped.length - listed.length;
    parts.push(`Skipped: ${listed.join('; ')}${more > 0 ? `; and ${more} more` : ''}`);
  }
  parts.push(...readSections);
  const text = parts.join('\n\n');
  const cap = full ? FULL_TEXT_CAP : DRIVE_FOLDER_PROMPT_CAP;
  return {
    text: text.length > cap ? `${text.slice(0, cap)}…[truncated]` : text,
    title: folderTitle,
    url,
  };
}

const SLACK_LINE_RE = /^([A-Z0-9]+)(?:\|#?([^\s[]+))?\s+\[([^\]]*)\]\s+([^:]+):\s*(.*)$/i;

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

function parseConfluenceSearch(text: string): ExternalReferenceSearchItem[] {
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
      const id =
        (typeof obj.id === 'string' && obj.id) ||
        (typeof obj.pageId === 'string' && obj.pageId) ||
        (typeof obj.id === 'number' && String(obj.id)) ||
        (typeof obj.pageId === 'number' && String(obj.pageId));
      const title =
        (typeof obj.title === 'string' && obj.title) || (typeof obj.name === 'string' && obj.name);
      if (id && title) {
        bag.push(obj);
        return;
      }
      for (const v of Object.values(obj)) walk(v, depth + 1);
    }
  };
  walk(parsed);

  if (bag.length) {
    return bag.slice(0, 25).map((page) => {
      const pageId =
        String(page.pageId ?? page.id ?? '').trim() ||
        (typeof page.id === 'number' ? String(page.id) : '');
      const title =
        (typeof page.title === 'string' && page.title) ||
        (typeof page.name === 'string' && page.name) ||
        pageId;
      const spaceKey =
        typeof page.spaceKey === 'string'
          ? page.spaceKey
          : typeof page.space === 'object' &&
              page.space &&
              typeof (page.space as { key?: string }).key === 'string'
            ? (page.space as { key: string }).key
            : undefined;
      const url =
        (typeof page.url === 'string' && page.url) ||
        (typeof page._links === 'object' &&
        page._links &&
        typeof (page._links as { webui?: string }).webui === 'string'
          ? (page._links as { webui: string }).webui
          : undefined);
      const siteOrigin =
        (url && confluenceSiteOriginFromUrl(url)) ||
        (typeof page.cloudId === 'string' && page.cloudId.includes('.')
          ? `https://${page.cloudId}`
          : undefined);
      const cloudId =
        (typeof page.cloudId === 'string' && page.cloudId) ||
        (siteOrigin ? new URL(siteOrigin).hostname : undefined);
      return {
        source: 'confluence' as const,
        externalId: pageId,
        title,
        subtitle: spaceKey ? `${spaceKey} · Confluence` : 'Confluence',
        url:
          url ||
          (pageId && siteOrigin
            ? confluencePageUrl(pageId, siteOrigin, spaceKey, title)
            : undefined),
        meta: {
          pageId,
          ...(cloudId ? { cloudId } : {}),
          ...(spaceKey ? { spaceKey } : {}),
        },
      };
    });
  }

  const items: ExternalReferenceSearchItem[] = [];
  for (const line of envelopeBody(text).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const idTitle = trimmed.match(/^(\d+)\s*[-–:]\s*(.+)$/);
    if (idTitle) {
      items.push({
        source: 'confluence',
        externalId: idTitle[1],
        title: idTitle[2].trim(),
        subtitle: 'Confluence',
        meta: { pageId: idTitle[1] },
      });
      continue;
    }
    const urlMatch = trimmed.match(/(https?:\/\/[^\s]+\/wiki\/[^\s]+)/i);
    if (urlMatch) {
      const pageUrl = urlMatch[1];
      const pageIdMatch = pageUrl.match(/\/pages\/(\d+)/) || pageUrl.match(/pageId=(\d+)/);
      if (pageIdMatch) {
        const pageId = pageIdMatch[1];
        const siteOrigin = confluenceSiteOriginFromUrl(pageUrl);
        items.push({
          source: 'confluence',
          externalId: pageId,
          title: trimmed.replace(urlMatch[0], '').trim() || `Page ${pageId}`,
          subtitle: 'Confluence',
          url: pageUrl,
          meta: {
            pageId,
            ...(siteOrigin ? { cloudId: new URL(siteOrigin).hostname } : {}),
          },
        });
      }
    }
  }
  return items.slice(0, 25);
}

function confluenceBodyFromResult(text: string): string {
  const parsed = parseJsonLoose(text);
  if (parsed && typeof parsed === 'object' && parsed !== null) {
    const obj = parsed as Record<string, unknown>;
    const body =
      (typeof obj.body === 'string' && obj.body) ||
      (typeof obj.content === 'string' && obj.content) ||
      (typeof obj.markdown === 'string' && obj.markdown) ||
      (obj.body &&
      typeof obj.body === 'object' &&
      typeof (obj.body as { markdown?: string }).markdown === 'string'
        ? (obj.body as { markdown: string }).markdown
        : undefined);
    if (body) return body;
  }
  return envelopeBody(text);
}

function confluenceTitleFromResult(text: string, fallback: string): string {
  const parsed = parseJsonLoose(text);
  if (parsed && typeof parsed === 'object' && parsed !== null) {
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.title === 'string' && obj.title.trim()) return obj.title.trim();
  }
  return envelopeTitle(text) || fallback;
}

export function getExternalReferenceStatus(
  mcpManager: MCPManager
): ExternalReferenceConnectorStatus {
  return {
    drive: isServerConnected(mcpManager, DEFAULT_GOOGLE_DRIVE_MCP_SERVER_ID),
    slack: isServerConnected(mcpManager, DEFAULT_SLACK_MCP_SERVER_ID),
    jira: isServerConnected(mcpManager, DEFAULT_JIRA_MCP_SERVER_ID),
    confluence: isServerConnected(mcpManager, DEFAULT_CONFLUENCE_MCP_SERVER_ID),
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
      if (parseExternalReferenceUrl(trimmed)?.source === 'drive') {
        const lookedUp = await lookupExternalReferenceFromUrl(mcpManager, trimmed);
        if (lookedUp) return { items: [lookedUp] };
      }
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
      const text = await callToolText(mcpManager, tool, {
        query: trimmed,
        limit: 20,
        sort: 'score',
      });
      return { items: parseSlackSearch(envelopeBody(text)).slice(0, 20) };
    }

    if (source === 'confluence') {
      const trimmed = query.trim();
      const parsedUrl = parseExternalReferenceUrl(trimmed);
      if (parsedUrl?.source === 'confluence') {
        const lookedUp = await lookupExternalReferenceFromUrl(mcpManager, trimmed);
        if (lookedUp) return { items: [lookedUp] };
      }
      const tool = findToolName(mcpManager, DEFAULT_CONFLUENCE_MCP_SERVER_ID, [
        'searchConfluenceUsingCql',
        'searchconfluence',
      ]);
      if (!tool) return { items: [], error: 'Confluence search is not available yet.' };
      const text = await callToolText(mcpManager, tool, {
        cql: confluenceCql(query),
        limit: 15,
        maxResults: 15,
      });
      return { items: parseConfluenceSearch(text).slice(0, 20) };
    }

    const trimmed = query.trim();
    const parsedJiraUrl = parseExternalReferenceUrl(trimmed);
    if (parsedJiraUrl?.source === 'jira') {
      const lookedUp = await lookupExternalReferenceFromUrl(mcpManager, trimmed);
      if (lookedUp) return { items: [lookedUp] };
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

export function capExternalReferenceText(text: string): string {
  return capPrompt(text);
}

const FULL_TEXT_CAP = 2_000_000;

export async function resolveExternalReference(
  mcpManager: MCPManager,
  reference: Pick<ExternalReferenceContent, 'source' | 'externalId' | 'title' | 'url' | 'meta'>,
  /** `full` keeps whitespace and skips the prompt cap (knowledge base indexing). */
  options?: { full?: boolean }
): Promise<ExternalReferenceResolveResult> {
  const capPrompt = options?.full
    ? (text: string) => text.trim().slice(0, FULL_TEXT_CAP)
    : capExternalReferenceText;
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
    if (source === 'drive' && reference.meta?.mimeType === DRIVE_FOLDER_MIME) {
      return await resolveDriveFolder(mcpManager, reference, Boolean(options?.full));
    }

    if (source === 'drive') {
      const fileId = reference.meta?.fileId || reference.externalId;
      const tool =
        findToolName(mcpManager, DEFAULT_GOOGLE_DRIVE_MCP_SERVER_ID, ['get_document_content']) ||
        findToolName(mcpManager, DEFAULT_GOOGLE_DRIVE_MCP_SERVER_ID, ['get_file_metadata']);
      if (!tool)
        return {
          text: '',
          title: reference.title,
          url: reference.url,
          error: 'Drive is not available.',
        };
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

    if (source === 'confluence') {
      const pageId = reference.meta?.pageId || reference.externalId;
      const cloudId = reference.meta?.cloudId;
      const tool =
        findToolName(mcpManager, DEFAULT_CONFLUENCE_MCP_SERVER_ID, ['getConfluencePage']) ||
        findToolName(mcpManager, DEFAULT_CONFLUENCE_MCP_SERVER_ID, ['fetchAtlassian']);
      if (!tool) {
        return {
          text: '',
          title: reference.title,
          url: reference.url,
          error: 'Confluence is not available.',
        };
      }
      const text = await callToolText(mcpManager, tool, {
        pageId,
        cloudId,
        contentFormat: 'markdown',
        id: pageId,
      });
      const title = confluenceTitleFromResult(text, reference.title);
      const siteOrigin =
        (reference.url && confluenceSiteOriginFromUrl(reference.url)) ||
        (cloudId && cloudId.includes('.') ? `https://${cloudId}` : undefined);
      const spaceKey = reference.meta?.spaceKey;
      return {
        text: capPrompt(confluenceBodyFromResult(text)),
        title,
        url:
          reference.url ||
          (siteOrigin ? confluencePageUrl(pageId, siteOrigin, spaceKey, title) : undefined),
      };
    }

    const issueKey = (reference.meta?.issueKey || reference.externalId).toUpperCase();
    const tool = findToolName(mcpManager, DEFAULT_JIRA_MCP_SERVER_ID, [
      'getJiraIssue',
      'fetchatlassian',
      'getVisibleJiraIssue',
    ]);
    if (!tool) {
      return {
        text: '',
        title: reference.title,
        url: reference.url,
        error: 'Jira is not available.',
      };
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
  if (parsed.source === 'drive' && parsed.meta?.mimeType === DRIVE_FOLDER_MIME) {
    const name = isServerConnected(mcpManager, DEFAULT_GOOGLE_DRIVE_MCP_SERVER_ID)
      ? await driveFolderName(mcpManager, parsed.externalId)
      : null;
    return {
      source: parsed.source,
      externalId: parsed.externalId,
      title: name || parsed.title || parsed.externalId,
      url: parsed.url,
      subtitle: parsed.subtitle,
      meta: parsed.meta,
    };
  }
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
