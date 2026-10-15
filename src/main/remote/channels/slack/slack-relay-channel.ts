/**
 * Slack Relay Channel
 * Slack remote control through the York backend relay (`/slack-relay/ws`).
 *
 * The desktop never holds a bot token and never names a Slack channel: the backend
 * forwards only DMs that the owner sent to the platform bot, each with an opaque
 * reply handle, and posts replies itself.
 */

import WebSocket from 'ws';
import { randomUUID } from 'crypto';
import { ChannelBase } from '../channel-base';
import { log, logWarn } from '../../../utils/logger';
import { isLoopbackUrl, resolveBackendWsUrl } from '../../../../shared/backend-config';
import type { RemoteMessage, RemoteResponse } from '../../types';
import {
  SLACK_RELAY_CAPABILITIES,
  SLACK_RELAY_IMAGE_LIMITS,
  parseSlackRelayAction,
  parseSlackRelayImages,
  type SlackRelayAction,
  type SlackRelayApprovalOutcome,
  type SlackRelayApprovalRequest,
  type SlackRelayChatEntry,
  type SlackRelayPicker,
  type SlackRelayQuestionOutcome,
  type SlackRelayQuestionRequest,
  type SlackRelayServerFeature,
  type SlackRelayStatusPhase,
} from './slack-relay-protocol';

/** Stable id so the router keeps one session and one pending-approval route per owner. */
export const SLACK_RELAY_CHANNEL_ID = 'slack-relay-dm';
export const SLACK_RELAY_WS_PATH = '/slack-relay/ws';

const REPLY_TEXT_MAX = 39_000;
const REPLY_RESULT_TIMEOUT_MS = 20_000;
const INBOUND_TEXT_MAX = 4_000;
const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;
const CLIENT_PING_INTERVAL_MS = 25_000;
/** Progress labels are coalesced so a burst of tool calls can't trip the relay frame limit. */
const STATUS_MIN_INTERVAL_MS = 1_000;

const CLOSE_FORBIDDEN = 4403;
const CLOSE_REPLACED = 4409;
const CLOSE_RATE_LIMITED = 4429;

export interface SlackRelayChannelDeps {
  /** Authorization (Cognito **id** token) plus client version headers. */
  getUpgradeHeaders: () => Promise<Record<string, string>>;
  getSlackUserToken: () => Promise<string>;
  /** Slack user id recorded when the user connected the Slack integration. */
  expectedSlackUserId: string;
  wsUrl?: string;
  createSocket?: (url: string, headers: Record<string, string>) => WebSocket;
  onStateChange?: (state: { connected: boolean; lastError: string | null }) => void;
  /** Called for every inbound owner message (used for idle tracking / notifications). */
  onActivity?: () => void;
}

interface PendingReply {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface StatusThrottle {
  lastSentAt: number;
  steps: number;
  pending: { phase: 'thinking' | 'step'; label?: string } | null;
  timer: NodeJS.Timeout | null;
}

/** Reply handle carried on inbound relay messages (`RemoteMessage.raw`). */
export function slackRelayReplyHandleOf(message: RemoteMessage): string | null {
  const raw = message.raw as { replyHandle?: unknown } | undefined;
  return typeof raw?.replyHandle === 'string' ? raw.replyHandle : null;
}

function textOf(response: RemoteResponse): string {
  const { content } = response;
  if (content.type === 'markdown') return content.markdown || '';
  return content.text || '';
}

export class SlackRelayChannel extends ChannelBase {
  readonly type = 'slack' as const;

  private ws: WebSocket | null = null;
  private stopped = true;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private backoffMs = MIN_BACKOFF_MS;
  private latestReplyHandle: string | null = null;
  private pendingReplies = new Map<string, PendingReply>();
  private statusThrottles = new Map<string, StatusThrottle>();
  private actionHandler?: (action: SlackRelayAction) => void;
  private serverFeatures = new Set<SlackRelayServerFeature>();
  private _lastError: string | null = null;

  constructor(private readonly deps: SlackRelayChannelDeps) {
    super();
  }

  get lastError(): string | null {
    return this._lastError;
  }

  /** Reply handle of the most recent owner message or command. */
  get latestHandle(): string | null {
    return this.latestReplyHandle;
  }

  /** Whether the connected backend renders AskUserQuestion as a button card. */
  get supportsQuestions(): boolean {
    return this._connected && this.serverFeatures.has('questions');
  }

  get supportsPickers(): boolean {
    return this._connected && this.serverFeatures.has('pickers');
  }

  /** Button clicks and `/growthos` commands relayed by the backend. */
  onAction(handler: (action: SlackRelayAction) => void): void {
    this.actionHandler = handler;
  }

  async start(): Promise<void> {
    if (!this.stopped) return;
    const url = this.resolveUrl();
    if (!url.startsWith('wss://') && !isLoopbackUrl(url)) {
      this.setError('Slack relay requires an https backend.');
      throw new Error('Refusing insecure Slack relay connection');
    }
    this.stopped = false;
    this.backoffMs = MIN_BACKOFF_MS;
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearTimers();
    this.clearStatusThrottles();
    this.latestReplyHandle = null;
    this.failPendingReplies('Slack relay stopped');
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.removeAllListeners();
      ws.on('error', () => undefined);
      try {
        ws.close(1000, 'client_stop');
      } catch {
        ws.terminate();
      }
    }
    this.setConnected(false);
  }

  async send(response: RemoteResponse): Promise<void> {
    if (response.channelId !== SLACK_RELAY_CHANNEL_ID) {
      throw new Error('No active Slack reply route');
    }
    await this.sendReply(this.latestReplyHandle, textOf(response));
  }

  /** Post an answer through a specific reply handle, optionally with a footer line. */
  async sendReply(replyHandle: string | null, body: string, footer?: string): Promise<void> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || !this._connected) {
      throw new Error('Slack relay not connected');
    }
    if (!replyHandle) {
      throw new Error('No active Slack reply route');
    }

    let text = body.trim();
    if (!text) return;
    if (text.length > REPLY_TEXT_MAX) {
      text = `${text.slice(0, REPLY_TEXT_MAX)}\n\n…(truncated — open York IE GrowthOS to see the full reply)`;
    }

    const requestId = randomUUID();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingReplies.delete(requestId);
        reject(new Error('Slack relay reply timed out'));
      }, REPLY_RESULT_TIMEOUT_MS);
      this.pendingReplies.set(requestId, { resolve, reject, timer });
      ws.send(
        JSON.stringify({
          type: 'reply',
          replyHandle,
          text,
          requestId,
          ...(footer ? { footer } : {}),
        })
      );
    });
  }

  /**
   * Live progress for a turn. `start`, `done` and `error` go out immediately;
   * `thinking` / `step` labels are coalesced to one frame per second (latest wins).
   */
  sendStatus(replyHandle: string, phase: SlackRelayStatusPhase, label?: string): void {
    if (phase === 'start') {
      this.statusThrottles.set(replyHandle, {
        lastSentAt: Date.now(),
        steps: 0,
        pending: null,
        timer: null,
      });
      this.sendFrame({ type: 'status', replyHandle, phase });
      return;
    }

    let throttle = this.statusThrottles.get(replyHandle);
    if (phase === 'done' || phase === 'error') {
      if (throttle?.timer) clearTimeout(throttle.timer);
      this.statusThrottles.delete(replyHandle);
      this.sendFrame({ type: 'status', replyHandle, phase, steps: throttle?.steps ?? 0 });
      return;
    }

    if (!throttle) {
      throttle = { lastSentAt: 0, steps: 0, pending: null, timer: null };
      this.statusThrottles.set(replyHandle, throttle);
    }
    if (phase === 'step') throttle.steps += 1;
    throttle.pending = { phase, ...(label ? { label } : {}) };
    if (throttle.timer) return;

    const wait = throttle.lastSentAt + STATUS_MIN_INTERVAL_MS - Date.now();
    if (wait <= 0) {
      this.flushStatus(replyHandle, throttle);
      return;
    }
    const active = throttle;
    active.timer = setTimeout(() => {
      active.timer = null;
      if (this.statusThrottles.get(replyHandle) === active) this.flushStatus(replyHandle, active);
    }, wait);
    active.timer.unref?.();
  }

  sendApproval(replyHandle: string, request: SlackRelayApprovalRequest): boolean {
    return this.sendFrame({ type: 'approval', replyHandle, ...request });
  }

  closeApproval(approvalId: string, outcome: SlackRelayApprovalOutcome): boolean {
    return this.sendFrame({ type: 'approval_closed', approvalId, outcome });
  }

  sendQuestion(replyHandle: string, request: SlackRelayQuestionRequest): boolean {
    if (!this.supportsQuestions) return false;
    return this.sendFrame({ type: 'question', replyHandle, ...request });
  }

  closeQuestion(
    questionId: string,
    outcome: SlackRelayQuestionOutcome,
    answers?: string[][]
  ): boolean {
    if (!this.supportsQuestions) return false;
    return this.sendFrame({
      type: 'question_closed',
      questionId,
      outcome,
      ...(answers ? { answers } : {}),
    });
  }

  sendChatList(replyHandle: string, chats: SlackRelayChatEntry[]): boolean {
    return this.sendFrame({ type: 'chat_list', replyHandle, chats });
  }

  sendPicker(replyHandle: string, picker: SlackRelayPicker): boolean {
    if (!this.supportsPickers) return false;
    return this.sendFrame({ type: 'picker', replyHandle, ...picker });
  }

  sendNotice(replyHandle: string, text: string): boolean {
    return this.sendFrame({ type: 'notice', replyHandle, text });
  }

  private flushStatus(replyHandle: string, throttle: StatusThrottle): void {
    const pending = throttle.pending;
    if (!pending) return;
    throttle.pending = null;
    throttle.lastSentAt = Date.now();
    this.sendFrame({
      type: 'status',
      replyHandle,
      phase: pending.phase,
      steps: throttle.steps,
      ...(pending.label ? { label: pending.label } : {}),
    });
  }

  /** Fire-and-forget frame; false when the relay isn't connected. */
  private sendFrame(frame: Record<string, unknown>): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || !this._connected) return false;
    ws.send(JSON.stringify(frame));
    return true;
  }

  private clearStatusThrottles(): void {
    for (const throttle of this.statusThrottles.values()) {
      if (throttle.timer) clearTimeout(throttle.timer);
    }
    this.statusThrottles.clear();
  }

  private resolveUrl(): string {
    return this.deps.wsUrl ?? `${resolveBackendWsUrl()}${SLACK_RELAY_WS_PATH}`;
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    let headers: Record<string, string>;
    let slackUserToken: string;
    try {
      [headers, slackUserToken] = await Promise.all([
        this.deps.getUpgradeHeaders(),
        this.deps.getSlackUserToken(),
      ]);
    } catch (error) {
      this.setError(error instanceof Error ? error.message : 'Could not load credentials');
      this.scheduleReconnect();
      return;
    }
    if (this.stopped) return;

    const url = this.resolveUrl();
    const ws = this.deps.createSocket
      ? this.deps.createSocket(url, headers)
      : new WebSocket(url, {
          headers,
          maxPayload: SLACK_RELAY_IMAGE_LIMITS.frameBytes,
          handshakeTimeout: 15_000,
        });
    this.ws = ws;

    ws.on('unexpected-response', (req, res) => {
      res.resume();
      req.destroy();
      if (this.ws === ws) this.ws = null;
      const status = res.statusCode ?? 0;
      if (status === 426) {
        this.halt('York IE GrowthOS must be updated before Slack remote control can connect.');
      } else if (status === 401 || status === 403) {
        this.setError('Slack remote control was refused. Sign in to York IE GrowthOS again.');
        this.scheduleReconnect(MAX_BACKOFF_MS);
      } else {
        this.setError(`Slack relay unavailable (HTTP ${status || '?'})`);
        this.scheduleReconnect();
      }
    });

    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          type: 'register',
          slackUserToken,
          capabilities: [...SLACK_RELAY_CAPABILITIES],
        })
      );
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let frame: Record<string, unknown>;
      try {
        const parsed = JSON.parse(data.toString()) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
        frame = parsed as Record<string, unknown>;
      } catch {
        return;
      }
      this.handleFrame(frame);
    });

    ws.on('close', (code, reasonBuf) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.latestReplyHandle = null;
      this.clearTimers();
      this.clearStatusThrottles();
      this.failPendingReplies('Slack relay disconnected');
      this.setConnected(false);
      if (this.stopped) return;

      const reason = reasonBuf.toString();
      if (code === CLOSE_FORBIDDEN) {
        this.halt(
          'Slack rejected this desktop. Your Slack account email must match your York IE GrowthOS sign-in, and guest accounts are not allowed.'
        );
      } else if (code === CLOSE_REPLACED) {
        this.halt(
          'Another York IE GrowthOS desktop took over Slack remote control for your account.'
        );
      } else {
        if (reason) log('[SlackRelay] Disconnected:', { code, reason });
        this.scheduleReconnect(code === CLOSE_RATE_LIMITED ? MAX_BACKOFF_MS : undefined);
      }
    });

    ws.on('error', (error) => {
      logWarn('[SlackRelay] Socket error:', error.message);
    });
  }

  private handleFrame(frame: Record<string, unknown>): void {
    switch (frame.type) {
      case 'registered': {
        if (frame.slackUserId !== this.deps.expectedSlackUserId) {
          this.halt(
            'Slack relay registered a different Slack user than the connected integration.'
          );
          return;
        }
        this.serverFeatures = new Set(
          (Array.isArray(frame.features) ? frame.features : []).filter(
            (f): f is SlackRelayServerFeature => f === 'questions' || f === 'pickers'
          )
        );
        this.backoffMs = MIN_BACKOFF_MS;
        this._lastError = null;
        this.setConnected(true);
        this.startPing();
        log('[SlackRelay] Registered');
        return;
      }
      case 'event': {
        if (!this._connected) return;
        const handle = typeof frame.replyHandle === 'string' ? frame.replyHandle : '';
        const text = typeof frame.text === 'string' ? frame.text.trim() : '';
        const images = parseSlackRelayImages(frame.images);
        if (!handle || handle.length > 64 || (!text && images.length === 0)) return;
        this.latestReplyHandle = handle;
        this.deps.onActivity?.();
        const message: RemoteMessage = {
          id: this.generateMessageId(),
          channelType: 'slack',
          channelId: SLACK_RELAY_CHANNEL_ID,
          sender: { id: this.deps.expectedSlackUserId, isBot: false },
          content: {
            type: 'text',
            text: text.slice(0, INBOUND_TEXT_MAX),
            ...(images.length > 0 ? { images } : {}),
          },
          timestamp: Date.now(),
          isGroup: false,
          isMentioned: true,
          raw: { replyHandle: handle },
        };
        this.emitMessage(message);
        return;
      }
      case 'action': {
        if (!this._connected) return;
        const action = parseSlackRelayAction(frame);
        if (!action) return;
        if (action.kind === 'command') this.latestReplyHandle = action.replyHandle;
        this.deps.onActivity?.();
        try {
          this.actionHandler?.(action);
        } catch (error) {
          logWarn('[SlackRelay] Action handler failed:', error);
        }
        return;
      }
      case 'reply_result': {
        const requestId = typeof frame.requestId === 'string' ? frame.requestId : '';
        const pending = this.pendingReplies.get(requestId);
        if (!pending) return;
        this.pendingReplies.delete(requestId);
        clearTimeout(pending.timer);
        if (frame.ok === true) {
          pending.resolve();
        } else {
          pending.reject(
            new Error(`Slack relay reply rejected: ${String(frame.error ?? 'unknown')}`)
          );
        }
        return;
      }
      default:
        return;
    }
  }

  private startPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, CLIENT_PING_INTERVAL_MS);
  }

  private scheduleReconnect(minDelayMs?: number): void {
    if (this.stopped || this.reconnectTimer) return;
    const base = Math.max(minDelayMs ?? 0, this.backoffMs);
    const delay = Math.round(base / 2 + Math.random() * (base / 2));
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  /** Stop permanently (until re-enabled) for errors a retry cannot fix. */
  private halt(message: string): void {
    this.setError(message);
    void this.stop();
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private failPendingReplies(reason: string): void {
    for (const pending of this.pendingReplies.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pendingReplies.clear();
  }

  private setConnected(connected: boolean): void {
    if (this._connected === connected) return;
    this._connected = connected;
    this.deps.onStateChange?.({ connected, lastError: this._lastError });
  }

  private setError(message: string): void {
    this._lastError = message;
    logWarn('[SlackRelay]', message);
    this.deps.onStateChange?.({ connected: this._connected, lastError: message });
  }
}
