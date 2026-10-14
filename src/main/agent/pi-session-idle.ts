/**
 * pi AgentSession can keep running after prompt() resolves: overflow
 * auto-compaction and auto-retry restart the loop via setTimeout(continue).
 * Calling prompt() during that window throws "Agent is already processing".
 * Wait for the session to settle (or abort the ghost run) before prompting.
 */

export interface IdleablePiSession {
  readonly isStreaming: boolean;
  readonly isCompacting: boolean;
  readonly isRetrying: boolean;
  abort(): Promise<void>;
  abortCompaction(): void;
}

export interface WaitForPiSessionIdleOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  pollMs?: number;
  /** Quiet period after busy flags clear; covers the deferred setTimeout(continue). */
  settleMs?: number;
  onWait?: () => void;
}

export type PiSessionIdleOutcome = 'idle' | 'waited' | 'aborted_stale';

const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_POLL_MS = 100;
const DEFAULT_SETTLE_MS = 250;

export function isPiSessionBusy(session: IdleablePiSession): boolean {
  return session.isStreaming || session.isCompacting || session.isRetrying;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForPiSessionIdle(
  session: IdleablePiSession,
  options: WaitForPiSessionIdleOptions = {}
): Promise<PiSessionIdleOutcome> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;

  if (!isPiSessionBusy(session)) return 'idle';

  options.onWait?.();
  const deadline = Date.now() + timeoutMs;
  let quietSince: number | null = null;

  while (Date.now() < deadline && !options.signal?.aborted) {
    if (isPiSessionBusy(session)) {
      quietSince = null;
    } else {
      quietSince ??= Date.now();
      if (Date.now() - quietSince >= settleMs) return 'waited';
    }
    await sleep(pollMs);
  }

  session.abortCompaction();
  await session.abort();
  return 'aborted_stale';
}
