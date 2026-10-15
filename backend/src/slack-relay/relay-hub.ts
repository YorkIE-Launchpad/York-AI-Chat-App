/**
 * In-memory Slack relay hub. Holds no message history: only live owner sockets,
 * short-lived reply capabilities, and abuse counters.
 *
 * Security invariants:
 * - An inbound event reaches only the socket registered for `team:user` of the sender,
 *   and only when it was posted in that owner's IM with the bot.
 * - A desktop can only reply through an opaque `replyHandle` issued to that same socket;
 *   it never names a Slack channel.
 */
import { createHash, randomBytes } from 'node:crypto';
import { chunkText, escapeSlackText } from './sanitize.js';
import type { SlackApi } from './slack-api.js';
import { log, logWarn } from '../safe-log.js';

export interface RelayPeer {
  readonly id: string;
  send(frame: Record<string, unknown>): void;
  close(code: number, reason: string): void;
}

export interface InboundSlackMessage {
  eventId: string;
  teamId: string;
  userId: string;
  channel: string;
  text: string;
  ts: string;
  threadTs?: string;
}

export type InboundResult = 'delivered' | 'offline' | 'dropped';

export type ReplyResult =
  | { ok: true }
  | {
      ok: false;
      error:
        | 'unknown_handle'
        | 'handle_exhausted'
        | 'rate_limited'
        | 'too_large'
        | 'invalid'
        | 'slack_error';
    };

export const RELAY_LIMITS = {
  inboundTextMax: 4_000,
  replyTextMax: 40_000,
  replyChunkLength: 3_800,
  replyHandleTtlMs: 60 * 60_000,
  replyHandleMaxChunks: 50,
  replyHandlesPerOwner: 200,
  inboundPerUserPerMinute: 20,
  replyFramesPerPeerPerMinute: 60,
  dedupeTtlMs: 10 * 60_000,
  dedupeMax: 10_000,
  offlineNoticeIntervalMs: 10 * 60_000,
} as const;

export const RELAY_CLOSE_CODES = {
  badFrame: 4400,
  unauthorized: 4401,
  forbidden: 4403,
  replaced: 4409,
  rateLimited: 4429,
} as const;

const OFFLINE_NOTICE =
  'York IE is not connected on your computer right now. Open York IE and turn on "Control York IE from Slack" to continue.';
const TAKEOVER_NOTICE =
  'A new York IE desktop just connected to your Slack remote control and replaced the previous one. If this was not you, disconnect Slack in York IE settings and sign out of York IE immediately.';

interface OwnerEntry {
  peer: RelayPeer;
  imChannel: string;
  connectedAt: number;
}

interface ReplyHandle {
  ownerKey: string;
  peerId: string;
  channel: string;
  threadTs?: string;
  expiresAt: number;
  chunksUsed: number;
}

export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now
  ) {}

  allow(key: string): boolean {
    const now = this.now();
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) this.prune(now);
    return true;
  }

  private prune(now: number): void {
    for (const [key, times] of this.hits) {
      if (times.every((t) => now - t >= this.windowMs)) this.hits.delete(key);
    }
  }
}

export function ownerKeyOf(teamId: string, userId: string): string {
  return `${teamId}:${userId}`;
}

export class SlackRelayHub {
  private readonly owners = new Map<string, OwnerEntry>();
  private readonly handles = new Map<string, ReplyHandle>();
  private readonly seenEvents = new Map<string, number>();
  private readonly lastOfflineNotice = new Map<string, number>();
  private readonly inboundLimiter: SlidingWindowLimiter;
  private readonly replyLimiter: SlidingWindowLimiter;
  private readonly now: () => number;

  constructor(
    private readonly api: SlackApi,
    options?: { now?: () => number }
  ) {
    this.now = options?.now ?? Date.now;
    this.inboundLimiter = new SlidingWindowLimiter(
      RELAY_LIMITS.inboundPerUserPerMinute,
      60_000,
      this.now
    );
    this.replyLimiter = new SlidingWindowLimiter(
      RELAY_LIMITS.replyFramesPerPeerPerMinute,
      60_000,
      this.now
    );
  }

  get ownerCount(): number {
    return this.owners.size;
  }

  /** Register a verified owner. Replaces (and alerts) any previous desktop for the same identity. */
  registerOwner(ownerKey: string, peer: RelayPeer, imChannel: string): { replaced: boolean } {
    const previous = this.owners.get(ownerKey);
    this.owners.set(ownerKey, { peer, imChannel, connectedAt: this.now() });
    this.revokeHandlesForOwner(ownerKey);

    if (previous && previous.peer.id !== peer.id) {
      previous.peer.close(RELAY_CLOSE_CODES.replaced, 'replaced_by_new_desktop');
      void this.api
        .postMessage({ channel: imChannel, text: escapeSlackText(TAKEOVER_NOTICE) })
        .catch((error) => logWarn('[slack-relay] takeover notice failed', error));
      log(`[slack-relay] owner replaced ${hashKey(ownerKey)}`);
      return { replaced: true };
    }
    log(`[slack-relay] owner registered ${hashKey(ownerKey)}`);
    return { replaced: false };
  }

  unregisterPeer(peer: RelayPeer): void {
    for (const [ownerKey, entry] of this.owners) {
      if (entry.peer.id === peer.id) {
        this.owners.delete(ownerKey);
        this.revokeHandlesForOwner(ownerKey);
        log(`[slack-relay] owner disconnected ${hashKey(ownerKey)}`);
      }
    }
  }

  /** Returns false when the event was already seen (Slack retries / replays). */
  markEventSeen(eventId: string): boolean {
    const now = this.now();
    const expiresAt = this.seenEvents.get(eventId);
    if (expiresAt !== undefined && expiresAt > now) return false;
    this.seenEvents.set(eventId, now + RELAY_LIMITS.dedupeTtlMs);
    if (this.seenEvents.size > RELAY_LIMITS.dedupeMax) {
      for (const [id, exp] of this.seenEvents) {
        if (exp <= now) this.seenEvents.delete(id);
      }
      while (this.seenEvents.size > RELAY_LIMITS.dedupeMax) {
        const oldest = this.seenEvents.keys().next().value as string;
        this.seenEvents.delete(oldest);
      }
    }
    return true;
  }

  async handleInbound(message: InboundSlackMessage): Promise<InboundResult> {
    if (!this.markEventSeen(message.eventId)) return 'dropped';

    const ownerKey = ownerKeyOf(message.teamId, message.userId);
    if (!this.inboundLimiter.allow(ownerKey)) {
      logWarn(`[slack-relay] inbound rate limited ${hashKey(ownerKey)}`);
      return 'dropped';
    }

    const owner = this.owners.get(ownerKey);
    if (!owner) {
      await this.sendOfflineNotice(ownerKey, message.channel);
      return 'offline';
    }
    if (owner.imChannel !== message.channel) {
      logWarn(`[slack-relay] inbound channel mismatch ${hashKey(ownerKey)}`);
      return 'dropped';
    }

    const replyHandle = this.issueHandle({
      ownerKey,
      peerId: owner.peer.id,
      channel: owner.imChannel,
      threadTs: message.threadTs,
    });
    owner.peer.send({
      type: 'event',
      replyHandle,
      text: message.text.slice(0, RELAY_LIMITS.inboundTextMax),
      ts: message.ts,
    });
    return 'delivered';
  }

  async handleReply(peer: RelayPeer, replyHandle: unknown, text: unknown): Promise<ReplyResult> {
    if (typeof replyHandle !== 'string' || typeof text !== 'string' || !text.trim()) {
      return { ok: false, error: 'invalid' };
    }
    if (!this.replyLimiter.allow(peer.id)) return { ok: false, error: 'rate_limited' };
    if (text.length > RELAY_LIMITS.replyTextMax) return { ok: false, error: 'too_large' };

    const handle = this.handles.get(replyHandle);
    const now = this.now();
    if (!handle || handle.peerId !== peer.id || handle.expiresAt <= now) {
      if (handle && handle.expiresAt <= now) this.handles.delete(replyHandle);
      return { ok: false, error: 'unknown_handle' };
    }
    const owner = this.owners.get(handle.ownerKey);
    if (!owner || owner.peer.id !== peer.id || owner.imChannel !== handle.channel) {
      this.handles.delete(replyHandle);
      return { ok: false, error: 'unknown_handle' };
    }

    const chunks = chunkText(text, RELAY_LIMITS.replyChunkLength);
    if (handle.chunksUsed + chunks.length > RELAY_LIMITS.replyHandleMaxChunks) {
      return { ok: false, error: 'handle_exhausted' };
    }
    handle.chunksUsed += chunks.length;

    try {
      for (const chunk of chunks) {
        await this.api.postMessage({
          channel: handle.channel,
          text: escapeSlackText(chunk),
          threadTs: handle.threadTs,
        });
      }
      return { ok: true };
    } catch (error) {
      logWarn('[slack-relay] reply post failed', error);
      return { ok: false, error: 'slack_error' };
    }
  }

  private issueHandle(input: Omit<ReplyHandle, 'expiresAt' | 'chunksUsed'>): string {
    this.pruneHandles(input.ownerKey);
    const id = randomBytes(16).toString('base64url');
    this.handles.set(id, {
      ...input,
      expiresAt: this.now() + RELAY_LIMITS.replyHandleTtlMs,
      chunksUsed: 0,
    });
    return id;
  }

  private pruneHandles(ownerKey: string): void {
    const now = this.now();
    const owned: string[] = [];
    for (const [id, handle] of this.handles) {
      if (handle.expiresAt <= now) {
        this.handles.delete(id);
      } else if (handle.ownerKey === ownerKey) {
        owned.push(id);
      }
    }
    // Map iteration is insertion-ordered, so the first entries are the oldest.
    while (owned.length >= RELAY_LIMITS.replyHandlesPerOwner) {
      this.handles.delete(owned.shift()!);
    }
  }

  private revokeHandlesForOwner(ownerKey: string): void {
    for (const [id, handle] of this.handles) {
      if (handle.ownerKey === ownerKey) this.handles.delete(id);
    }
  }

  private async sendOfflineNotice(ownerKey: string, channel: string): Promise<void> {
    const now = this.now();
    const last = this.lastOfflineNotice.get(ownerKey) ?? 0;
    if (now - last < RELAY_LIMITS.offlineNoticeIntervalMs) return;
    this.lastOfflineNotice.set(ownerKey, now);
    try {
      await this.api.postMessage({ channel, text: escapeSlackText(OFFLINE_NOTICE) });
    } catch (error) {
      logWarn('[slack-relay] offline notice failed', error);
    }
  }
}

/** Short non-reversible identity tag for logs. */
export function hashKey(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}
