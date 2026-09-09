/**
 * Shared collab session document helpers (client-owned Y.Doc schema).
 * Backend never interprets this — it only relays bytes.
 */
import * as Y from 'yjs';
import type { Message, MessageRole } from '../../renderer/types';
import type { WorkspaceDivisionKind } from '../workspace-division';

export const COLLAB_LEASE_TTL_MS = 120_000;

export type CollabMemberRole = 'owner' | 'member';

export interface CollabMember {
  displayName: string;
  role: CollabMemberRole;
  joinedAt: number;
}

export interface CollabTurnLease {
  holderSub: string;
  holderName: string;
  runId: string | null;
  acquiredAt: number;
  expiresAt: number;
}

export interface CollabSessionMeta {
  title: string;
  division?: WorkspaceDivisionKind;
  hubProjectId?: string | null;
  hubProjectName?: string | null;
  launchpadProjectId?: number | null;
  launchpadProjectName?: string | null;
  createdBySub: string;
  createdAt: number;
}

/** Portable message stored in the shared doc (attachments = metadata only). */
export interface CollabPortableMessage {
  id: string;
  sessionId: string;
  role: MessageRole;
  content: Message['content'];
  timestamp: number;
  api?: string;
  provider?: string;
  model?: string;
  tokenUsage?: Message['tokenUsage'];
  executionTimeMs?: number;
}

export function getCollabMaps(doc: Y.Doc) {
  return {
    meta: doc.getMap<unknown>('meta'),
    members: doc.getMap<CollabMember>('members'),
    messages: doc.getMap<CollabPortableMessage>('messages'),
    messageOrder: doc.getArray<string>('messageOrder'),
    turnLease: doc.getMap<unknown>('turnLease'),
  };
}

export function stripAttachmentBinaries(content: Message['content']): Message['content'] {
  return content.map((block) => {
    if (block.type === 'file_attachment') {
      return {
        type: 'file_attachment' as const,
        filename: block.filename,
        relativePath: block.relativePath,
        size: block.size,
        mimeType: block.mimeType,
        // Do not sync inline base64 / local paths content beyond metadata.
      };
    }
    if (block.type === 'image') {
      return {
        type: 'text' as const,
        text: '[image omitted from shared sync]',
      };
    }
    if (block.type === 'tool_result' && block.images?.length) {
      return {
        ...block,
        images: undefined,
      };
    }
    return block;
  });
}

export function messageToCollabPortable(message: Message): CollabPortableMessage {
  return {
    id: message.id,
    sessionId: message.sessionId,
    role: message.role,
    content: stripAttachmentBinaries(message.content),
    timestamp: message.timestamp,
    api: message.api,
    provider: message.provider,
    model: message.model,
    tokenUsage: message.tokenUsage,
    executionTimeMs: message.executionTimeMs,
  };
}

export function seedCollabMeta(
  doc: Y.Doc,
  meta: CollabSessionMeta,
  owner: { sub: string; displayName: string }
): void {
  const maps = getCollabMaps(doc);
  doc.transact(() => {
    maps.meta.set('title', meta.title);
    if (meta.division) maps.meta.set('division', meta.division);
    maps.meta.set('hubProjectId', meta.hubProjectId ?? null);
    maps.meta.set('hubProjectName', meta.hubProjectName ?? null);
    maps.meta.set('launchpadProjectId', meta.launchpadProjectId ?? null);
    maps.meta.set('launchpadProjectName', meta.launchpadProjectName ?? null);
    maps.meta.set('createdBySub', meta.createdBySub);
    maps.meta.set('createdAt', meta.createdAt);
    maps.members.set(owner.sub, {
      displayName: owner.displayName,
      role: 'owner',
      joinedAt: Date.now(),
    });
  });
}

export function upsertCollabMember(
  doc: Y.Doc,
  sub: string,
  member: CollabMember
): void {
  getCollabMaps(doc).members.set(sub, member);
}

export function readCollabMeta(doc: Y.Doc): Partial<CollabSessionMeta> {
  const meta = getCollabMaps(doc).meta;
  return {
    title: typeof meta.get('title') === 'string' ? (meta.get('title') as string) : undefined,
    division: meta.get('division') as WorkspaceDivisionKind | undefined,
    hubProjectId: (meta.get('hubProjectId') as string | null | undefined) ?? null,
    hubProjectName: (meta.get('hubProjectName') as string | null | undefined) ?? null,
    launchpadProjectId: (meta.get('launchpadProjectId') as number | null | undefined) ?? null,
    launchpadProjectName: (meta.get('launchpadProjectName') as string | null | undefined) ?? null,
    createdBySub:
      typeof meta.get('createdBySub') === 'string'
        ? (meta.get('createdBySub') as string)
        : undefined,
    createdAt: typeof meta.get('createdAt') === 'number' ? (meta.get('createdAt') as number) : undefined,
  };
}

export function readMembers(doc: Y.Doc): Record<string, CollabMember> {
  const out: Record<string, CollabMember> = {};
  getCollabMaps(doc).members.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

export function listOrderedMessages(doc: Y.Doc): CollabPortableMessage[] {
  const { messages, messageOrder } = getCollabMaps(doc);
  const ordered: CollabPortableMessage[] = [];
  for (const id of messageOrder.toArray()) {
    const msg = messages.get(id);
    if (msg) ordered.push(msg);
  }
  return ordered;
}

/** Insert message if missing (dedupe by id). */
export function commitCollabMessage(doc: Y.Doc, message: CollabPortableMessage): boolean {
  const { messages, messageOrder } = getCollabMaps(doc);
  if (messages.has(message.id)) return false;
  doc.transact(() => {
    messages.set(message.id, message);
    messageOrder.push([message.id]);
  });
  return true;
}

export function readTurnLease(doc: Y.Doc, now = Date.now()): CollabTurnLease | null {
  const lease = getCollabMaps(doc).turnLease;
  const holderSub = lease.get('holderSub');
  if (typeof holderSub !== 'string' || !holderSub) return null;
  const expiresAt = lease.get('expiresAt');
  if (typeof expiresAt !== 'number' || expiresAt < now) return null;
  return {
    holderSub,
    holderName: typeof lease.get('holderName') === 'string' ? (lease.get('holderName') as string) : '',
    runId: typeof lease.get('runId') === 'string' ? (lease.get('runId') as string) : null,
    acquiredAt: typeof lease.get('acquiredAt') === 'number' ? (lease.get('acquiredAt') as number) : now,
    expiresAt,
  };
}

export function clearTurnLease(doc: Y.Doc): void {
  const lease = getCollabMaps(doc).turnLease;
  doc.transact(() => {
    lease.clear();
  });
}

export type AcquireLeaseResult =
  | { ok: true; lease: CollabTurnLease }
  | { ok: false; reason: 'held_by_other'; holder?: CollabTurnLease };

/**
 * Acquire lease if empty/expired or already held by self.
 */
export function tryAcquireLease(
  doc: Y.Doc,
  holder: { sub: string; displayName: string },
  options?: { runId?: string | null; now?: number; ttlMs?: number }
): AcquireLeaseResult {
  const now = options?.now ?? Date.now();
  const ttlMs = options?.ttlMs ?? COLLAB_LEASE_TTL_MS;
  const current = readTurnLease(doc, now);
  if (current && current.holderSub !== holder.sub) {
    return { ok: false, reason: 'held_by_other', holder: current };
  }

  const lease: CollabTurnLease = {
    holderSub: holder.sub,
    holderName: holder.displayName,
    runId: options?.runId ?? current?.runId ?? null,
    acquiredAt: current?.holderSub === holder.sub ? current.acquiredAt : now,
    expiresAt: now + ttlMs,
  };

  const map = getCollabMaps(doc).turnLease;
  doc.transact(() => {
    map.set('holderSub', lease.holderSub);
    map.set('holderName', lease.holderName);
    map.set('runId', lease.runId);
    map.set('acquiredAt', lease.acquiredAt);
    map.set('expiresAt', lease.expiresAt);
  });

  return { ok: true, lease };
}

export function refreshLease(
  doc: Y.Doc,
  holderSub: string,
  options?: { runId?: string | null; now?: number; ttlMs?: number }
): boolean {
  const now = options?.now ?? Date.now();
  const current = readTurnLease(doc, now);
  if (!current || current.holderSub !== holderSub) return false;
  const ttlMs = options?.ttlMs ?? COLLAB_LEASE_TTL_MS;
  const map = getCollabMaps(doc).turnLease;
  doc.transact(() => {
    map.set('expiresAt', now + ttlMs);
    if (options?.runId !== undefined) {
      map.set('runId', options.runId);
    }
  });
  return true;
}

export function releaseLeaseIfHolder(doc: Y.Doc, holderSub: string, now = Date.now()): boolean {
  const current = readTurnLease(doc, now);
  if (!current) {
    clearTurnLease(doc);
    return true;
  }
  if (current.holderSub !== holderSub) return false;
  clearTurnLease(doc);
  return true;
}

export function isLeaseHolder(doc: Y.Doc, sub: string, now = Date.now()): boolean {
  const lease = readTurnLease(doc, now);
  return !!lease && lease.holderSub === sub;
}

/** True when lease is free or held by `sub`. */
export function canPromptWithLease(doc: Y.Doc, sub: string, now = Date.now()): boolean {
  const lease = readTurnLease(doc, now);
  return !lease || lease.holderSub === sub;
}

/** True when lease is held by someone other than `sub`. */
export function isLeaseHeldByOther(doc: Y.Doc, sub: string, now = Date.now()): boolean {
  const lease = readTurnLease(doc, now);
  return !!lease && lease.holderSub !== sub;
}

/**
 * Clear lease if holderSub is not among online peer subs (stale holder left).
 * Returns true if lease was cleared.
 */
export function clearLeaseIfHolderOffline(
  doc: Y.Doc,
  onlineSubs: Set<string>,
  now = Date.now()
): boolean {
  const lease = readTurnLease(doc, now);
  if (!lease) return false;
  if (onlineSubs.has(lease.holderSub)) return false;
  clearTurnLease(doc);
  return true;
}
