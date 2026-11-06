/**
 * Skippable Sleep tool: pauses the agent for N seconds (e.g. between LaunchPad
 * polls). The UI shows a Skip button; skipping resolves the tool as a successful
 * completion so the agent continues as if the sleep finished.
 */
import { Type } from '@sinclair/typebox';
import { v4 as uuidv4 } from 'uuid';
import type {
  AgentRuntimeExtension,
  BeforeSessionRunContext,
  BeforeSessionRunResult,
  AgentRuntimeCustomTool,
} from '../extensions/agent-runtime-extension';
import type { ServerEvent } from '../../renderer/types';
import { log, logWarn } from '../utils/logger';

export const SLEEP_TOOL_NAME = 'Sleep';

/** Cap so a bad model argument cannot block a turn for hours. */
export const SLEEP_MAX_MS = 30 * 60 * 1000;
export const SLEEP_MIN_MS = 100;

export type SleepSendEvent = (event: ServerEvent) => void;

export interface SleepRequest {
  sleepId: string;
  sessionId: string;
  toolUseId: string;
  durationMs: number;
  startedAt: number;
  endsAt: number;
}

type SleepResult =
  | { kind: 'completed' }
  | { kind: 'skipped' }
  | { kind: 'cancelled'; reason: string };

type PendingSleep = {
  sleepId: string;
  sessionId: string;
  toolUseId: string;
  settle: (result: SleepResult) => void;
  timer: NodeJS.Timeout;
  abortHandler?: () => void;
  signal?: AbortSignal;
};

function parseDurationMs(params: unknown): number | null {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    return null;
  }
  const root = params as Record<string, unknown>;
  const candidates: Array<{ value: unknown; unit: 'ms' | 's' }> = [
    { value: root.duration_ms, unit: 'ms' },
    { value: root.durationMs, unit: 'ms' },
    { value: root.ms, unit: 'ms' },
    { value: root.milliseconds, unit: 'ms' },
    { value: root.duration_seconds, unit: 's' },
    { value: root.durationSeconds, unit: 's' },
    { value: root.seconds, unit: 's' },
    { value: root.duration, unit: 's' },
  ];
  for (const { value, unit } of candidates) {
    const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
    if (!Number.isFinite(n) || n < 0) continue;
    const ms = unit === 'ms' ? n : n * 1000;
    return Math.min(SLEEP_MAX_MS, Math.max(SLEEP_MIN_MS, Math.round(ms)));
  }
  return null;
}

/** Pure `sleep N` / `Sleep N` bash commands (seconds). */
export function parseBashSleepCommandMs(command: string): number | null {
  const trimmed = command.trim();
  const match = /^(?:\/usr\/bin\/)?sleep\s+(\d+(?:\.\d+)?)\s*$/i.exec(trimmed);
  if (!match) return null;
  const seconds = Number(match[1]);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(SLEEP_MAX_MS, Math.max(SLEEP_MIN_MS, Math.round(seconds * 1000)));
}

function createSleepTool(extension: SleepToolExtension, sessionId: string): AgentRuntimeCustomTool {
  return {
    name: SLEEP_TOOL_NAME,
    label: 'Sleep',
    description:
      'Pause for a number of seconds (e.g. between LaunchPad status polls). Prefer polling tools when possible. ' +
      'The user can Skip in the UI; skip counts as sleep completed — continue immediately. ' +
      'Pass seconds (or duration_ms). Max 30 minutes.',
    parameters: Type.Object({
      seconds: Type.Optional(
        Type.Number({ description: 'How long to sleep, in seconds.', minimum: 0 })
      ),
      duration_seconds: Type.Optional(
        Type.Number({ description: 'Alias for seconds.', minimum: 0 })
      ),
      duration_ms: Type.Optional(
        Type.Number({ description: 'How long to sleep, in milliseconds.', minimum: 0 })
      ),
    }),
    async execute(toolCallId: string, params: unknown, signal?: AbortSignal) {
      const durationMs = parseDurationMs(params);
      if (durationMs == null) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Error: Sleep requires seconds (or duration_ms). Example: { "seconds": 15 }',
            },
          ],
          details: undefined,
        };
      }
      return extension.executeSleep(sessionId, toolCallId, durationMs, signal);
    },
  };
}

export class SleepToolExtension implements AgentRuntimeExtension {
  readonly name = 'sleep-tool';

  private readonly pending = new Map<string, PendingSleep>();

  constructor(private readonly sendToRenderer: SleepSendEvent) {}

  async beforeSessionRun(context: BeforeSessionRunContext): Promise<BeforeSessionRunResult> {
    return {
      customTools: [createSleepTool(this, context.session.id)],
    };
  }

  async executeSleep(
    sessionId: string,
    toolCallId: string,
    durationMs: number,
    signal?: AbortSignal
  ): Promise<{ content: Array<{ type: 'text'; text: string }>; details: unknown }> {
    const sleepId = uuidv4();
    const toolUseId = toolCallId || sleepId;
    const startedAt = Date.now();
    const endsAt = startedAt + durationMs;

    const request: SleepRequest = {
      sleepId,
      sessionId,
      toolUseId,
      durationMs,
      startedAt,
      endsAt,
    };

    const result = await new Promise<SleepResult>((resolve) => {
      let settled = false;
      const settle = (sleepResult: SleepResult) => {
        if (settled) return;
        settled = true;
        const pending = this.pending.get(sleepId);
        if (pending) {
          clearTimeout(pending.timer);
          if (pending.signal && pending.abortHandler) {
            pending.signal.removeEventListener('abort', pending.abortHandler);
          }
          this.pending.delete(sleepId);
        }
        this.sendToRenderer({
          type: 'sleep.dismiss',
          payload: { sleepId, sessionId },
        });
        resolve(sleepResult);
      };

      if (signal?.aborted) {
        settle({ kind: 'cancelled', reason: 'aborted' });
        return;
      }

      const timer = setTimeout(() => settle({ kind: 'completed' }), durationMs);

      const abortHandler = () => {
        settle({ kind: 'cancelled', reason: 'aborted' });
      };

      this.pending.set(sleepId, {
        sleepId,
        sessionId,
        toolUseId,
        settle,
        timer,
        abortHandler,
        signal,
      });

      signal?.addEventListener('abort', abortHandler, { once: true });

      this.sendToRenderer({
        type: 'sleep.request',
        payload: request,
      });

      log(
        `[Sleep] Waiting ${durationMs}ms: ${sleepId} (session=${sessionId}, toolUseId=${toolUseId})`
      );
    });

    if (result.kind === 'skipped') {
      return {
        content: [
          {
            type: 'text',
            text: 'Sleep completed (skipped by user). Continue immediately — treat this as a full wait finished.',
          },
        ],
        details: { skipped: true, durationMs, elapsedMs: Date.now() - startedAt },
      };
    }

    if (result.kind === 'completed') {
      return {
        content: [{ type: 'text', text: 'Sleep completed.' }],
        details: { skipped: false, durationMs, elapsedMs: durationMs },
      };
    }

    // Session stop / abort — still success so the model does not treat skip-like
    // interruption as a failed wait when the turn is ending.
    return {
      content: [
        {
          type: 'text',
          text: `Sleep completed (interrupted: ${result.reason}).`,
        },
      ],
      details: { skipped: false, interrupted: true, durationMs },
    };
  }

  hasPending(sessionId: string): boolean {
    for (const pending of this.pending.values()) {
      if (pending.sessionId === sessionId) return true;
    }
    return false;
  }

  /** User clicked Skip — resolve as successful sleep completion. */
  skipSleep(sleepId: string): boolean {
    const pending = this.pending.get(sleepId);
    if (!pending) {
      logWarn(`[Sleep] No pending sleep for ID: ${sleepId}`);
      return false;
    }
    pending.settle({ kind: 'skipped' });
    return true;
  }

  skipSleepByToolUseId(toolUseId: string): boolean {
    for (const pending of this.pending.values()) {
      if (pending.toolUseId === toolUseId) {
        pending.settle({ kind: 'skipped' });
        return true;
      }
    }
    return false;
  }

  dismissSessionSleeps(sessionId: string, reason = 'session stopped'): void {
    for (const [, pending] of [...this.pending.entries()]) {
      if (pending.sessionId !== sessionId) continue;
      pending.settle({ kind: 'cancelled', reason });
    }
  }
}
