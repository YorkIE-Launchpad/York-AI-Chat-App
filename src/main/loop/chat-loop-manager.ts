/**
 * @module main/loop/chat-loop-manager
 *
 * Session-scoped independent chat loops (/loop, /goal).
 * Continues the same session on a fixed interval until stopped,
 * goal completes, or max iterations is reached.
 */
import {
  buildGoalTickPrompt,
  isGoalCompleteInText,
  type ChatLoopKind,
} from '../../shared/loop/types';
import { log, logError, logWarn } from '../utils/logger';

export interface ChatLoopStatus {
  sessionId: string;
  kind: ChatLoopKind;
  prompt: string;
  intervalMs: number;
  tickCount: number;
  maxIterations: number | null;
  startedAt: number;
  nextTickAt: number | null;
  stopReason: string | null;
}

export interface ChatLoopStartInput {
  sessionId: string;
  kind: ChatLoopKind;
  /** Interval prompt text, or goal text when kind === 'goal'. */
  prompt: string;
  intervalMs: number;
  maxIterations?: number | null;
  /** When false, skip the immediate first tick (timer-only). Default true. */
  runImmediately?: boolean;
}

export interface ChatLoopSessionApi {
  continueSession: (sessionId: string, prompt: string) => Promise<void>;
  getSessionStatus: (sessionId: string) => 'running' | 'idle' | 'completed' | null;
  getLatestAssistantText: (sessionId: string) => string | null;
  sessionExists: (sessionId: string) => boolean;
}

interface ActiveChatLoop {
  sessionId: string;
  kind: ChatLoopKind;
  prompt: string;
  intervalMs: number;
  tickCount: number;
  maxIterations: number | null;
  startedAt: number;
  nextTickAt: number | null;
  stopReason: string | null;
  timer: NodeJS.Timeout | null;
  ticking: boolean;
}

const IDLE_POLL_MS = 500;
const IDLE_WAIT_MAX_MS = 30 * 60_000;

export class ChatLoopManager {
  private readonly loops = new Map<string, ActiveChatLoop>();
  private readonly api: ChatLoopSessionApi;
  private readonly onChanged?: (status: ChatLoopStatus | null, sessionId: string) => void;

  constructor(options: {
    api: ChatLoopSessionApi;
    onChanged?: (status: ChatLoopStatus | null, sessionId: string) => void;
  }) {
    this.api = options.api;
    this.onChanged = options.onChanged;
  }

  start(input: ChatLoopStartInput): ChatLoopStatus {
    const existing = this.loops.get(input.sessionId);
    if (existing && !existing.stopReason) {
      this.clearTimer(existing);
    }

    const now = Date.now();
    const loop: ActiveChatLoop = {
      sessionId: input.sessionId,
      kind: input.kind,
      prompt: input.prompt.trim(),
      intervalMs: input.intervalMs,
      tickCount: 0,
      maxIterations: input.kind === 'goal' ? (input.maxIterations ?? 20) : null,
      startedAt: now,
      nextTickAt: null,
      stopReason: null,
      timer: null,
      ticking: false,
    };

    this.loops.set(input.sessionId, loop);
    log(
      `[ChatLoop] Started ${loop.kind} loop for session ${input.sessionId} every ${loop.intervalMs}ms`
    );

    const runImmediately = input.runImmediately !== false;
    if (runImmediately) {
      void this.runTick(input.sessionId);
    } else {
      this.armTimer(loop);
    }

    this.emit(input.sessionId);
    return this.toStatus(loop);
  }

  stop(sessionId: string, reason = 'stopped'): ChatLoopStatus | null {
    const loop = this.loops.get(sessionId);
    if (!loop) return null;
    this.clearTimer(loop);
    loop.stopReason = reason;
    loop.nextTickAt = null;
    log(`[ChatLoop] Stopped loop for session ${sessionId}: ${reason}`);
    this.emit(sessionId);
    // Keep status readable briefly; remove after emit consumers can read once.
    this.loops.delete(sessionId);
    return this.toStatus({ ...loop, stopReason: reason, nextTickAt: null, timer: null });
  }

  stopAll(reason = 'shutdown'): void {
    for (const sessionId of [...this.loops.keys()]) {
      this.stop(sessionId, reason);
    }
  }

  status(sessionId: string): ChatLoopStatus | null {
    const loop = this.loops.get(sessionId);
    return loop ? this.toStatus(loop) : null;
  }

  list(): ChatLoopStatus[] {
    return [...this.loops.values()].filter((l) => !l.stopReason).map((l) => this.toStatus(l));
  }

  private armTimer(loop: ActiveChatLoop): void {
    this.clearTimer(loop);
    if (loop.stopReason) return;
    loop.nextTickAt = Date.now() + loop.intervalMs;
    loop.timer = setTimeout(() => {
      void this.runTick(loop.sessionId);
    }, loop.intervalMs);
  }

  private clearTimer(loop: ActiveChatLoop): void {
    if (loop.timer) {
      clearTimeout(loop.timer);
      loop.timer = null;
    }
  }

  private async runTick(sessionId: string): Promise<void> {
    const loop = this.loops.get(sessionId);
    if (!loop || loop.stopReason) return;
    if (loop.ticking) {
      this.armTimer(loop);
      return;
    }

    if (!this.api.sessionExists(sessionId)) {
      this.stop(sessionId, 'session_gone');
      return;
    }

    const status = this.api.getSessionStatus(sessionId);
    if (status === 'running') {
      logWarn(`[ChatLoop] Skip tick — session ${sessionId} still running`);
      this.armTimer(loop);
      this.emit(sessionId);
      return;
    }

    loop.ticking = true;
    loop.tickCount += 1;
    this.emit(sessionId);

    const tickPrompt = loop.kind === 'goal' ? buildGoalTickPrompt(loop.prompt) : loop.prompt;

    try {
      await this.api.continueSession(sessionId, tickPrompt);
      if (loop.kind === 'goal') {
        await this.waitUntilIdle(sessionId);
        const text = this.api.getLatestAssistantText(sessionId) ?? '';
        if (isGoalCompleteInText(text)) {
          loop.ticking = false;
          this.stop(sessionId, 'goal_complete');
          return;
        }
        if (loop.maxIterations !== null && loop.tickCount >= loop.maxIterations) {
          loop.ticking = false;
          this.stop(sessionId, 'max_iterations');
          return;
        }
      }
    } catch (error) {
      logError(`[ChatLoop] Tick failed for ${sessionId}:`, error);
      loop.ticking = false;
      this.stop(sessionId, 'error');
      return;
    }

    loop.ticking = false;
    if (!this.loops.has(sessionId) || this.loops.get(sessionId)?.stopReason) {
      return;
    }
    this.armTimer(loop);
    this.emit(sessionId);
  }

  private async waitUntilIdle(sessionId: string): Promise<void> {
    const started = Date.now();
    // Allow enqueue to flip status to running
    await sleep(IDLE_POLL_MS);
    while (Date.now() - started < IDLE_WAIT_MAX_MS) {
      const status = this.api.getSessionStatus(sessionId);
      if (status !== 'running') return;
      await sleep(IDLE_POLL_MS);
    }
    logWarn(`[ChatLoop] Timed out waiting for idle on ${sessionId}`);
  }

  private toStatus(loop: ActiveChatLoop): ChatLoopStatus {
    return {
      sessionId: loop.sessionId,
      kind: loop.kind,
      prompt: loop.prompt,
      intervalMs: loop.intervalMs,
      tickCount: loop.tickCount,
      maxIterations: loop.maxIterations,
      startedAt: loop.startedAt,
      nextTickAt: loop.nextTickAt,
      stopReason: loop.stopReason,
    };
  }

  private emit(sessionId: string): void {
    const loop = this.loops.get(sessionId);
    this.onChanged?.(loop && !loop.stopReason ? this.toStatus(loop) : null, sessionId);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function extractAssistantText(
  messages: Array<{ role: string; content: Array<{ type: string; text?: string }> }>
): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg.role !== 'assistant') continue;
    const parts = msg.content
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string);
    if (parts.length > 0) return parts.join('\n');
  }
  return null;
}
