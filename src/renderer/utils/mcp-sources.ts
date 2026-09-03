import { toUserFacingSourceUrls } from '../../shared/jira-urls';
import {
  slackChannelIdFromUrl,
  slackChannelLabelFromResultText,
  toUserFacingSlackSourceUrls,
} from '../../shared/slack-urls';
import type { Message, ToolResultContent, ToolUseContent } from '../types';
import { messageHasAssistantText } from './active-turn';

export const MCP_SOURCES_MAX = 12;

export type McpSourceItem = {
  /** Display label for the source link or connector. */
  title: string;
  /** MCP server key from mcp__Server__tool (decoded spaces). */
  serverName: string;
  /** Absolute http(s) URL when available. */
  url?: string;
};

const URL_RE = /https?:\/\/[^\s<>"'`)\]]+/gi;
/** Sources heading near the end of the answer (last ~40% or last 1200 chars). */
const SOURCES_HEADING_RE = /(?:^|\n)#{0,3}\s*Sources\s*:?\s*(?:\n|$)/i;

function decodeMcpServerName(raw: string): string {
  return raw.replace(/_/g, ' ').trim() || raw;
}

export function parseMcpToolName(toolName: string): {
  serverName: string;
  toolName: string;
} | null {
  if (!toolName.startsWith('mcp__')) return null;
  const match = toolName.match(/^mcp__(.+?)__(.+)$/);
  if (!match) return null;
  return {
    serverName: decodeMcpServerName(match[1]),
    toolName: match[2],
  };
}

/**
 * True when assistant text already includes a Sources section near the end.
 * Checks only the trailing portion to avoid mid-answer false positives.
 */
export function messageHasSourcesSection(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const windowStart = Math.max(
    0,
    trimmed.length - Math.max(1200, Math.floor(trimmed.length * 0.4))
  );
  const tail = trimmed.slice(windowStart);
  return SOURCES_HEADING_RE.test(tail);
}

function extractUrls(text: string): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(URL_RE)) {
    let url = match[0];
    // Trim common trailing punctuation from prose.
    url = url.replace(/[.,;:!?]+$/g, '');
    if (!seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
  }
  return urls;
}

function titleFromUrl(url: string, serverName: string, resultText = ''): string {
  const slackChannelId = slackChannelIdFromUrl(url);
  if (slackChannelId) {
    const slackLabel = slackChannelLabelFromResultText(resultText, slackChannelId);
    if (slackLabel) return `${serverName}: ${slackLabel}`;
  }
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, '');
    const path = parsed.pathname.replace(/\/$/, '');
    if (path && path !== '/') {
      const last = path.split('/').filter(Boolean).pop() || '';
      if (last && last.length < 48) {
        return `${serverName}: ${decodeURIComponent(last)}`;
      }
    }
    return `${serverName}: ${host}`;
  } catch {
    return serverName;
  }
}

function getAssistantText(message: Message): string {
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => (block as { type: 'text'; text: string }).text)
    .join('\n');
}

/** Messages belonging to the turn after `userMessageId` until the next user message. */
export function getTurnMessages(messages: Message[], userMessageId: string): Message[] {
  const anchorIndex = messages.findIndex((message) => message.id === userMessageId);
  if (anchorIndex === -1) return [];
  const turn: Message[] = [];
  for (let i = anchorIndex + 1; i < messages.length; i += 1) {
    if (messages[i].role === 'user') break;
    turn.push(messages[i]);
  }
  return turn;
}

/** Preceding user message id for a given message, if any. */
export function findTurnUserMessageId(messages: Message[], messageId: string): string | undefined {
  const index = messages.findIndex((message) => message.id === messageId);
  if (index === -1) return undefined;
  for (let i = index; i >= 0; i -= 1) {
    if (messages[i].role === 'user') return messages[i].id;
  }
  return undefined;
}

/** Last assistant message in the turn that has non-empty text. */
export function findLastAssistantTextMessageId(turnMessages: Message[]): string | undefined {
  for (let i = turnMessages.length - 1; i >= 0; i -= 1) {
    if (messageHasAssistantText(turnMessages[i])) {
      return turnMessages[i].id;
    }
  }
  return undefined;
}

/**
 * Collect unique MCP sources from tool_use / tool_result pairs in a turn.
 * When no URLs are found but MCP tools ran, returns connector-name items (no url).
 */
export function extractMcpSourcesFromTurn(
  messages: Message[],
  userMessageId: string,
  options?: { max?: number }
): McpSourceItem[] {
  const max = options?.max ?? MCP_SOURCES_MAX;
  const turnMessages = getTurnMessages(messages, userMessageId);

  const toolUses = new Map<string, ToolUseContent>();
  const toolResults = new Map<string, ToolResultContent>();

  for (const message of turnMessages) {
    for (const block of message.content) {
      if (block.type === 'tool_use') {
        const tu = block as ToolUseContent;
        if (tu.name.startsWith('mcp__')) {
          toolUses.set(tu.id, tu);
        }
      } else if (block.type === 'tool_result') {
        const tr = block as ToolResultContent;
        toolResults.set(tr.toolUseId, tr);
      }
    }
  }

  if (toolUses.size === 0) return [];

  const items: McpSourceItem[] = [];
  const seenUrls = new Set<string>();
  const seenServers = new Set<string>();

  for (const [toolUseId, toolUse] of toolUses) {
    const parsed = parseMcpToolName(toolUse.name);
    if (!parsed) continue;
    seenServers.add(parsed.serverName);

    const result = toolResults.get(toolUseId);
    const resultText = result && typeof result.content === 'string' ? result.content : '';

    if (!resultText) continue;

    for (const url of toUserFacingSlackSourceUrls(
      toUserFacingSourceUrls(extractUrls(resultText), resultText)
    )) {
      if (seenUrls.has(url)) continue;
      seenUrls.add(url);
      items.push({
        title: titleFromUrl(url, parsed.serverName, resultText),
        serverName: parsed.serverName,
        url,
      });
      if (items.length >= max) return items;
    }
  }

  // No URLs — fall back to connector names for provenance.
  if (items.length === 0) {
    for (const serverName of seenServers) {
      items.push({ title: serverName, serverName });
      if (items.length >= max) break;
    }
  }

  return items;
}

/**
 * Whether the UI Sources footer should render for this message.
 */
export function shouldShowMcpSourcesFooter(input: {
  messages: Message[];
  messageId: string;
  isStreaming?: boolean;
}): { show: boolean; sources: McpSourceItem[] } {
  if (input.isStreaming) {
    return { show: false, sources: [] };
  }

  const userMessageId = findTurnUserMessageId(input.messages, input.messageId);
  if (!userMessageId) {
    return { show: false, sources: [] };
  }

  const turnMessages = getTurnMessages(input.messages, userMessageId);
  const lastTextId = findLastAssistantTextMessageId(turnMessages);
  if (!lastTextId || lastTextId !== input.messageId) {
    return { show: false, sources: [] };
  }

  const message = turnMessages.find((m) => m.id === input.messageId);
  if (!message) {
    return { show: false, sources: [] };
  }

  const text = getAssistantText(message);
  if (messageHasSourcesSection(text)) {
    return { show: false, sources: [] };
  }

  const sources = extractMcpSourcesFromTurn(input.messages, userMessageId);
  if (sources.length === 0) {
    return { show: false, sources: [] };
  }

  return { show: true, sources };
}
