/**
 * In-memory Slack relay hub. Holds no message history: only live owner sockets,
 * short-lived reply capabilities, and abuse counters.
 *
 * Security invariants:
 * - An inbound event reaches only the socket registered for `team:user` of the sender,
 *   and only when it was posted in that owner's IM with the bot.
 * - A desktop can only reply through an opaque `replyHandle` issued to that same socket;
 *   it never names a Slack channel.
 * - Button clicks and slash commands are accepted only from the registered owner, and
 *   approval ids / chat tokens only resolve for the socket that issued them.
 * - Slack Web API calls run on a per-owner serial queue, never on a Slack request path.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  BLOCK_TEXT_MAX,
  renderApprovalCard,
  renderChatList,
  renderFinishedStatus,
  renderReplyWithFooter,
  renderWorkingStatus,
  type ApprovalCardState,
} from './blocks.js';
import {
  OPAQUE_ID_RE,
  PROTOCOL_LIMITS,
  cleanLine,
  cleanText,
  type ApprovalOutcome,
  type CommandName,
  type RelayCapability,
  type StatusPhase,
} from './protocol.js';
import { chunkMrkdwn, markdownToMrkdwn } from './mrkdwn.js';
import { escapeSlackText } from './sanitize.js';
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

/** Result of a slash command or button click, decided synchronously so Slack gets its ack fast. */
export type OwnerActionResult =
  | 'ok'
  | 'offline'
  | 'outdated'
  | 'unknown'
  | 'expired'
  | 'rate_limited';

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
  statusUpdateIntervalMs: 1_500,
  approvalsPerOwner: 20,
  chatTokenTtlMs: 15 * 60_000,
  chatTokensPerOwner: 100,
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

const REACTION_WORKING = 'hourglass_flowing_sand';
const REACTION_DONE = 'white_check_mark';
const REACTION_ERROR = 'x';

interface OwnerEntry {
  peer: RelayPeer;
  imChannel: string;
  connectedAt: number;
  capabilities: Set<RelayCapability>;
}

interface StatusState {
  ts: string | null;
  startedAt: number;
  steps: number;
  label: string;
  lastUpdateAt: number;
  timer: NodeJS.Timeout | null;
  finished: boolean;
}

interface ReplyHandle {
  ownerKey: string;
  peerId: string;
  channel: string;
  threadTs?: string;
  /** The owner's message this handle answers (status reactions go here). */
  userTs?: string;
  expiresAt: number;
  chunksUsed: number;
  status?: StatusState;
}

interface ApprovalEntry {
  ownerKey: string;
  peerId: string;
  channel: string;
  threadTs?: string;
  ts: string | null;
  toolName: string;
  summary: string;
  detail?: string;
  expiresInSec: number;
  expiresAt: number;
  state: ApprovalCardState;
}

interface ChatTokenEntry {
  ownerKey: string;
  peerId: string;
  expiresAt: number;
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
  private readonly approvals = new Map<string, ApprovalEntry>();
  private readonly chatTokens = new Map<string, ChatTokenEntry>();
  private readonly seenEvents = new Map<string, number>();
  private readonly lastOfflineNotice = new Map<string, number>();
  private readonly queues = new Map<string, Promise<void>>();
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
  registerOwner(
    ownerKey: string,
    peer: RelayPeer,
    imChannel: string,
    capabilities: Iterable<RelayCapability> = []
  ): { replaced: boolean } {
    const previous = this.owners.get(ownerKey);
    this.owners.set(ownerKey, {
      peer,
      imChannel,
      connectedAt: this.now(),
      capabilities: new Set(capabilities),
    });
    this.revokeHandlesForOwner(ownerKey);

    if (previous && previous.peer.id !== peer.id) {
      previous.peer.close(RELAY_CLOSE_CODES.replaced, 'replaced_by_new_desktop');
      this.enqueue(ownerKey, async () => {
        await this.api.postMessage({ channel: imChannel, text: escapeSlackText(TAKEOVER_NOTICE) });
      });
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
      userTs: message.ts,
    });
    owner.peer.send({
      type: 'event',
      replyHandle,
      text: message.text.slice(0, RELAY_LIMITS.inboundTextMax),
      ts: message.ts,
    });
    return 'delivered';
  }

  async handleReply(
    peer: RelayPeer,
    replyHandle: unknown,
    text: unknown,
    footer?: unknown
  ): Promise<ReplyResult> {
    if (typeof replyHandle !== 'string' || typeof text !== 'string' || !text.trim()) {
      return { ok: false, error: 'invalid' };
    }
    if (!this.replyLimiter.allow(peer.id)) return { ok: false, error: 'rate_limited' };
    if (text.length > RELAY_LIMITS.replyTextMax) return { ok: false, error: 'too_large' };

    const handle = this.peerHandle(peer, replyHandle);
    if (!handle) return { ok: false, error: 'unknown_handle' };

    const footerLine = cleanLine(footer, PROTOCOL_LIMITS.footer);
    const chunks = chunkMrkdwn(
      markdownToMrkdwn(text),
      footerLine ? BLOCK_TEXT_MAX : RELAY_LIMITS.replyChunkLength
    );
    if (handle.chunksUsed + chunks.length > RELAY_LIMITS.replyHandleMaxChunks) {
      return { ok: false, error: 'handle_exhausted' };
    }
    handle.chunksUsed += chunks.length;

    let result: ReplyResult = { ok: true };
    await this.enqueue(handle.ownerKey, async () => {
      try {
        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          const isLast = i === chunks.length - 1;
          if (isLast && footerLine) {
            const rendered = renderReplyWithFooter(chunk, footerLine);
            await this.api.postMessage({
              channel: handle.channel,
              text: rendered.text,
              blocks: rendered.blocks,
              ...(handle.threadTs ? { threadTs: handle.threadTs } : {}),
            });
          } else {
            await this.api.postMessage({
              channel: handle.channel,
              text: chunk,
              threadTs: handle.threadTs,
            });
          }
        }
      } catch (error) {
        logWarn('[slack-relay] reply post failed', error);
        result = { ok: false, error: 'slack_error' };
      }
    });
    return result;
  }

  /** Live "Working on it…" message on the owner's IM. Fire-and-forget for the desktop. */
  handleStatus(
    peer: RelayPeer,
    replyHandle: unknown,
    phase: StatusPhase,
    label?: unknown,
    steps?: unknown
  ): boolean {
    const handle = this.peerHandle(peer, replyHandle);
    if (!handle) return false;
    const now = this.now();
    // The desktop coalesces step frames, so it reports the running total.
    const reportedSteps =
      typeof steps === 'number' && Number.isInteger(steps) && steps >= 0 && steps <= 10_000
        ? steps
        : null;

    if (phase === 'start') {
      if (handle.status) return true;
      this.beginStatus(handle, 'Thinking…', now);
      return true;
    }

    if (phase === 'thinking' || phase === 'step') {
      const status = handle.status ?? this.beginStatus(handle, 'Thinking…', now);
      if (status.finished) return true;
      const fallback = phase === 'thinking' ? 'Thinking…' : 'Working…';
      const next = cleanLine(label, PROTOCOL_LIMITS.statusLabel) ?? fallback;
      if (reportedSteps !== null) status.steps = Math.max(status.steps, reportedSteps);
      else if (phase === 'step') status.steps += 1;
      if (next === status.label) return true;
      status.label = next;
      this.scheduleStatusUpdate(handle, status);
      return true;
    }

    const status = handle.status;
    if (!status || status.finished) return true;
    status.finished = true;
    if (reportedSteps !== null) status.steps = Math.max(status.steps, reportedSteps);
    if (status.timer) clearTimeout(status.timer);
    status.timer = null;
    const outcome = phase === 'error' ? 'error' : 'done';
    const elapsedMs = now - status.startedAt;
    this.enqueue(handle.ownerKey, async () => {
      if (status.ts) {
        const rendered = renderFinishedStatus({ outcome, elapsedMs, steps: status.steps });
        await this.api.updateMessage({ channel: handle.channel, ts: status.ts, ...rendered });
      }
      if (handle.userTs) {
        await this.api.removeReaction({
          channel: handle.channel,
          ts: handle.userTs,
          name: REACTION_WORKING,
        });
        await this.api.addReaction({
          channel: handle.channel,
          ts: handle.userTs,
          name: outcome === 'error' ? REACTION_ERROR : REACTION_DONE,
        });
      }
    });
    return true;
  }

  /** Post an Allow/Deny card. The desktop owns the approval id and the timeout. */
  handleApproval(peer: RelayPeer, frame: Record<string, unknown>): boolean {
    const handle = this.peerHandle(peer, frame.replyHandle);
    if (!handle) return false;
    const approvalId = frame.approvalId;
    if (typeof approvalId !== 'string' || !OPAQUE_ID_RE.test(approvalId)) return false;
    if (this.approvals.has(approvalId)) return false;
    const toolName = cleanLine(frame.toolName, PROTOCOL_LIMITS.toolName);
    const summary = cleanText(frame.summary, PROTOCOL_LIMITS.approvalSummary) ?? '';
    const detail = cleanText(frame.detail, PROTOCOL_LIMITS.approvalDetail) ?? undefined;
    const expiresInSec = Number(frame.expiresInSec);
    if (
      !toolName ||
      !Number.isInteger(expiresInSec) ||
      expiresInSec < PROTOCOL_LIMITS.approvalMinSec ||
      expiresInSec > PROTOCOL_LIMITS.approvalMaxSec
    ) {
      return false;
    }

    this.pruneApprovals(handle.ownerKey);
    const entry: ApprovalEntry = {
      ownerKey: handle.ownerKey,
      peerId: peer.id,
      channel: handle.channel,
      threadTs: handle.threadTs,
      ts: null,
      toolName,
      summary,
      detail,
      expiresInSec,
      expiresAt: this.now() + expiresInSec * 1000,
      state: 'pending',
    };
    this.approvals.set(approvalId, entry);
    this.enqueue(handle.ownerKey, async () => {
      const rendered = this.renderApproval(approvalId, entry);
      const posted = await this.api.postMessage({
        channel: entry.channel,
        text: rendered.text,
        blocks: rendered.blocks,
        ...(entry.threadTs ? { threadTs: entry.threadTs } : {}),
      });
      entry.ts = posted.ts || null;
    });
    return true;
  }

  /** Desktop confirms the final outcome (button, typed reply, or timeout). */
  handleApprovalClosed(peer: RelayPeer, approvalId: unknown, outcome: ApprovalOutcome): boolean {
    if (typeof approvalId !== 'string') return false;
    const entry = this.approvals.get(approvalId);
    if (!entry || entry.peerId !== peer.id) return false;
    this.approvals.delete(approvalId);
    entry.state = outcome;
    this.updateApprovalCard(approvalId, entry);
    return true;
  }

  /** Owner clicked Allow / Deny. Synchronous: relays the decision, Slack updates are queued. */
  clickApproval(input: {
    teamId: string;
    userId: string;
    channelId: string;
    approvalId: string;
    decision: 'allow' | 'deny';
  }): OwnerActionResult {
    const ownerKey = ownerKeyOf(input.teamId, input.userId);
    const entry = this.approvals.get(input.approvalId);
    if (!entry || entry.ownerKey !== ownerKey || entry.channel !== input.channelId) {
      return 'unknown';
    }
    const owner = this.owners.get(ownerKey);
    if (!owner || owner.peer.id !== entry.peerId) return 'offline';
    if (entry.state !== 'pending') return 'unknown';
    if (entry.expiresAt <= this.now()) {
      this.approvals.delete(input.approvalId);
      entry.state = 'expired';
      this.updateApprovalCard(input.approvalId, entry);
      return 'expired';
    }

    entry.state = input.decision === 'allow' ? 'allowing' : 'denying';
    owner.peer.send({
      type: 'action',
      kind: 'approval',
      approvalId: input.approvalId,
      decision: input.decision,
    });
    this.updateApprovalCard(input.approvalId, entry);
    return 'ok';
  }

  handleChatList(peer: RelayPeer, replyHandle: unknown, chats: unknown): boolean {
    const handle = this.peerHandle(peer, replyHandle);
    if (!handle || !Array.isArray(chats) || chats.length > PROTOCOL_LIMITS.chatListMax) {
      return false;
    }
    const parsed: Array<{ token: string; title: string; updatedLabel: string; current: boolean }> =
      [];
    for (const raw of chats) {
      if (!raw || typeof raw !== 'object') return false;
      const chat = raw as Record<string, unknown>;
      if (typeof chat.token !== 'string' || !OPAQUE_ID_RE.test(chat.token)) return false;
      parsed.push({
        token: chat.token,
        title: cleanLine(chat.title, PROTOCOL_LIMITS.chatTitle) ?? 'Untitled chat',
        updatedLabel: cleanLine(chat.updatedLabel, PROTOCOL_LIMITS.chatUpdatedLabel) ?? '',
        current: chat.current === true,
      });
    }

    this.pruneChatTokens(handle.ownerKey);
    const expiresAt = this.now() + RELAY_LIMITS.chatTokenTtlMs;
    for (const chat of parsed) {
      this.chatTokens.set(chat.token, { ownerKey: handle.ownerKey, peerId: peer.id, expiresAt });
    }
    this.enqueue(handle.ownerKey, async () => {
      const rendered = renderChatList(parsed);
      await this.api.postMessage({
        channel: handle.channel,
        text: rendered.text,
        blocks: rendered.blocks,
      });
    });
    return true;
  }

  handleNotice(peer: RelayPeer, replyHandle: unknown, text: unknown): boolean {
    const handle = this.peerHandle(peer, replyHandle);
    const body = cleanText(text, PROTOCOL_LIMITS.notice);
    if (!handle || !body) return false;
    this.enqueue(handle.ownerKey, async () => {
      await this.api.postMessage({ channel: handle.channel, text: markdownToMrkdwn(body) });
    });
    return true;
  }

  /** Can this Slack user run commands right now? Pure read, safe on the ack path. */
  commandAvailability(teamId: string, userId: string): OwnerActionResult {
    const owner = this.owners.get(ownerKeyOf(teamId, userId));
    if (!owner) return 'offline';
    if (!owner.capabilities.has('commands')) return 'outdated';
    return 'ok';
  }

  /** The owner's IM with the bot, when their desktop is connected. */
  ownerImChannel(teamId: string, userId: string): string | null {
    return this.owners.get(ownerKeyOf(teamId, userId))?.imChannel ?? null;
  }

  /** Forward a slash command (or chat button) to the owner's desktop with a fresh reply handle. */
  dispatchCommand(input: {
    teamId: string;
    userId: string;
    name: CommandName;
    arg?: string;
    token?: string;
  }): OwnerActionResult {
    const ownerKey = ownerKeyOf(input.teamId, input.userId);
    const owner = this.owners.get(ownerKey);
    if (!owner) return 'offline';
    if (!owner.capabilities.has('commands')) return 'outdated';
    if (!this.inboundLimiter.allow(ownerKey)) return 'rate_limited';

    let arg = input.arg?.slice(0, PROTOCOL_LIMITS.commandArg);
    if (input.name === 'open') {
      const token = input.token ?? '';
      const entry = this.chatTokens.get(token);
      if (!entry || entry.ownerKey !== ownerKey || entry.peerId !== owner.peer.id) {
        return 'unknown';
      }
      if (entry.expiresAt <= this.now()) {
        this.chatTokens.delete(token);
        return 'expired';
      }
      arg = token;
    }

    const replyHandle = this.issueHandle({
      ownerKey,
      peerId: owner.peer.id,
      channel: owner.imChannel,
    });
    owner.peer.send({
      type: 'action',
      kind: 'command',
      name: input.name,
      replyHandle,
      ...(arg ? { arg } : {}),
    });
    return 'ok';
  }

  /** Wait for queued Slack calls for an owner (tests and graceful shutdown). */
  async drain(ownerKey?: string): Promise<void> {
    const pending = ownerKey ? [this.queues.get(ownerKey)] : [...this.queues.values()];
    await Promise.all(pending.filter(Boolean));
  }

  private beginStatus(handle: ReplyHandle, label: string, now: number): StatusState {
    const status: StatusState = {
      ts: null,
      startedAt: now,
      steps: 0,
      label,
      lastUpdateAt: now,
      timer: null,
      finished: false,
    };
    handle.status = status;
    this.enqueue(handle.ownerKey, async () => {
      if (handle.userTs) {
        await this.api
          .addReaction({ channel: handle.channel, ts: handle.userTs, name: REACTION_WORKING })
          .catch((error) => logWarn('[slack-relay] reaction failed', error));
      }
      if (status.finished) return;
      const rendered = renderWorkingStatus(status.label);
      const posted = await this.api.postMessage({
        channel: handle.channel,
        text: rendered.text,
        blocks: rendered.blocks,
        ...(handle.threadTs ? { threadTs: handle.threadTs } : {}),
      });
      status.ts = posted.ts || null;
      status.lastUpdateAt = this.now();
    });
    return status;
  }

  /** Coalesce step labels: at most one chat.update per interval, always showing the latest. */
  private scheduleStatusUpdate(handle: ReplyHandle, status: StatusState): void {
    if (status.timer) return;
    const wait = Math.max(
      0,
      status.lastUpdateAt + RELAY_LIMITS.statusUpdateIntervalMs - this.now()
    );
    status.timer = setTimeout(() => {
      status.timer = null;
      if (status.finished) return;
      status.lastUpdateAt = this.now();
      this.enqueue(handle.ownerKey, async () => {
        if (!status.ts || status.finished) return;
        const rendered = renderWorkingStatus(status.label);
        await this.api.updateMessage({ channel: handle.channel, ts: status.ts, ...rendered });
      });
    }, wait);
    status.timer.unref?.();
  }

  private renderApproval(approvalId: string, entry: ApprovalEntry) {
    return renderApprovalCard({
      approvalId,
      toolName: entry.toolName,
      summary: entry.summary,
      detail: entry.detail,
      state: entry.state,
      expiresInSec: entry.expiresInSec,
    });
  }

  private updateApprovalCard(approvalId: string, entry: ApprovalEntry): void {
    const state = entry.state;
    this.enqueue(entry.ownerKey, async () => {
      if (!entry.ts) return;
      const rendered = this.renderApproval(approvalId, { ...entry, state });
      await this.api.updateMessage({ channel: entry.channel, ts: entry.ts, ...rendered });
    });
  }

  private enqueue(ownerKey: string, task: () => Promise<void>): Promise<void> {
    const previous = this.queues.get(ownerKey) ?? Promise.resolve();
    const next = previous
      .then(task)
      .catch((error) => logWarn('[slack-relay] slack call failed', error));
    this.queues.set(ownerKey, next);
    void next.then(() => {
      if (this.queues.get(ownerKey) === next) this.queues.delete(ownerKey);
    });
    return next;
  }

  private peerHandle(peer: RelayPeer, replyHandle: unknown): ReplyHandle | null {
    if (typeof replyHandle !== 'string') return null;
    const handle = this.handles.get(replyHandle);
    const now = this.now();
    if (!handle || handle.peerId !== peer.id || handle.expiresAt <= now) {
      if (handle && handle.expiresAt <= now) this.dropHandle(replyHandle, handle);
      return null;
    }
    const owner = this.owners.get(handle.ownerKey);
    if (!owner || owner.peer.id !== peer.id || owner.imChannel !== handle.channel) {
      this.dropHandle(replyHandle, handle);
      return null;
    }
    return handle;
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

  private dropHandle(id: string, handle: ReplyHandle): void {
    if (handle.status?.timer) clearTimeout(handle.status.timer);
    this.handles.delete(id);
  }

  private pruneHandles(ownerKey: string): void {
    const now = this.now();
    const owned: string[] = [];
    for (const [id, handle] of this.handles) {
      if (handle.expiresAt <= now) {
        this.dropHandle(id, handle);
      } else if (handle.ownerKey === ownerKey) {
        owned.push(id);
      }
    }
    // Map iteration is insertion-ordered, so the first entries are the oldest.
    while (owned.length >= RELAY_LIMITS.replyHandlesPerOwner) {
      const id = owned.shift()!;
      this.dropHandle(id, this.handles.get(id)!);
    }
  }

  private pruneApprovals(ownerKey: string): void {
    const now = this.now();
    const owned: string[] = [];
    for (const [id, entry] of this.approvals) {
      if (entry.expiresAt + 60_000 <= now) {
        this.approvals.delete(id);
      } else if (entry.ownerKey === ownerKey) {
        owned.push(id);
      }
    }
    while (owned.length >= RELAY_LIMITS.approvalsPerOwner) {
      this.approvals.delete(owned.shift()!);
    }
  }

  private pruneChatTokens(ownerKey: string): void {
    const now = this.now();
    const owned: string[] = [];
    for (const [token, entry] of this.chatTokens) {
      if (entry.expiresAt <= now) {
        this.chatTokens.delete(token);
      } else if (entry.ownerKey === ownerKey) {
        owned.push(token);
      }
    }
    while (owned.length + PROTOCOL_LIMITS.chatListMax > RELAY_LIMITS.chatTokensPerOwner) {
      this.chatTokens.delete(owned.shift()!);
    }
  }

  private revokeHandlesForOwner(ownerKey: string): void {
    for (const [id, handle] of this.handles) {
      if (handle.ownerKey === ownerKey) this.dropHandle(id, handle);
    }
    for (const [id, entry] of this.approvals) {
      if (entry.ownerKey === ownerKey) this.approvals.delete(id);
    }
    for (const [token, entry] of this.chatTokens) {
      if (entry.ownerKey === ownerKey) this.chatTokens.delete(token);
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
