/**
 * Cross-workspace chat search types shared by main (FTS) and renderer (palette / sidebar).
 */

import type { SessionDivisionFields, WorkspaceDivisionKind } from './workspace-division';

export const CHAT_FTS_TITLE_STUB_ID = '__title__';

export interface ChatSearchHit {
  sessionId: string;
  messageId: string | null;
  title: string;
  snippet: string;
  timestamp: number;
  pinned: boolean;
  division: string;
  hubProjectId: string | null;
  hubProjectName: string | null;
  launchpadProjectId: number | null;
  launchpadProjectName: string | null;
  folderId: string | null;
  folderName: string | null;
  projectCanonicalKey: string | null;
  clientName: string | null;
  clientProjectIds: string | null;
}

export function chatSearchHitToDivisionFields(hit: ChatSearchHit): SessionDivisionFields {
  return {
    division: (hit.division as WorkspaceDivisionKind) || 'general',
    hubProjectId: hit.hubProjectId,
    hubProjectName: hit.hubProjectName,
    launchpadProjectId: hit.launchpadProjectId,
    launchpadProjectName: hit.launchpadProjectName,
    folderId: hit.folderId,
    folderName: hit.folderName,
    canonicalKey: hit.projectCanonicalKey,
    clientName: hit.clientName,
    clientProjectIds: hit.clientProjectIds,
  };
}

/** Strip FTS MATCH special characters and build a prefix AND query. */
export function toFtsMatchQuery(raw: string): string {
  const tokens = raw
    .trim()
    .split(/\s+/)
    .map((token) => token.replace(/["'^:*(){}[\]\\]/g, ''))
    .filter((token) => token.length > 0)
    .slice(0, 12);
  if (tokens.length === 0) return '';
  return tokens.map((token) => `"${token}"*`).join(' AND ');
}

const MAX_BODY_CHARS = 50_000;
const MAX_BLOCK_CHARS = 8_000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function clip(text: string, max = MAX_BLOCK_CHARS): string {
  return text.length > max ? text.slice(0, max) : text;
}

/**
 * Flatten persisted message `content` JSON into searchable plain text.
 * Skips image/base64 payloads.
 */
export function extractSearchableText(contentJson: string): string {
  if (!contentJson) return '';
  let parsed: unknown;
  try {
    parsed = JSON.parse(contentJson);
  } catch {
    return clip(contentJson, MAX_BODY_CHARS);
  }

  const blocks = Array.isArray(parsed) ? parsed : [parsed];
  const parts: string[] = [];

  for (const block of blocks) {
    const rec = asRecord(block);
    if (!rec || typeof rec.type !== 'string') {
      if (typeof block === 'string') parts.push(clip(block));
      continue;
    }
    switch (rec.type) {
      case 'text':
        if (typeof rec.text === 'string') parts.push(clip(rec.text));
        break;
      case 'file_attachment':
        if (typeof rec.filename === 'string') parts.push(rec.filename);
        break;
      case 'meeting_attachment':
        if (typeof rec.title === 'string') parts.push(rec.title);
        break;
      case 'external_reference': {
        const bits = [rec.title, rec.subtitle, rec.source, rec.externalId]
          .filter((v): v is string => typeof v === 'string' && v.length > 0);
        if (bits.length) parts.push(bits.join(' '));
        break;
      }
      case 'tool_use': {
        if (typeof rec.name === 'string') parts.push(rec.name);
        if (typeof rec.displayName === 'string') parts.push(rec.displayName);
        break;
      }
      case 'tool_result':
        if (typeof rec.content === 'string') parts.push(clip(rec.content, 4_000));
        break;
      case 'thinking':
      case 'image':
        break;
      default:
        break;
    }
  }

  return parts.join('\n').replace(/\s+/g, ' ').trim().slice(0, MAX_BODY_CHARS);
}
