import { describe, expect, it, vi } from 'vitest';
import { waitForPiSessionIdle, type IdleablePiSession } from '../src/main/agent/pi-session-idle';

function fakeSession(overrides: Partial<IdleablePiSession> = {}) {
  const state = { isStreaming: false, isCompacting: false, isRetrying: false };
  const session = {
    get isStreaming() {
      return state.isStreaming;
    },
    get isCompacting() {
      return state.isCompacting;
    },
    get isRetrying() {
      return state.isRetrying;
    },
    abort: vi.fn(async () => {
      state.isStreaming = false;
    }),
    abortCompaction: vi.fn(() => {
      state.isCompacting = false;
    }),
    ...overrides,
  };
  return { session, state };
}

describe('waitForPiSessionIdle', () => {
  it('returns immediately when the session is idle', async () => {
    const { session } = fakeSession();
    await expect(waitForPiSessionIdle(session)).resolves.toBe('idle');
    expect(session.abort).not.toHaveBeenCalled();
  });

  it('waits through compaction followed by a deferred continue()', async () => {
    const { session, state } = fakeSession();
    state.isCompacting = true;
    setTimeout(() => {
      state.isCompacting = false;
      setTimeout(() => {
        state.isStreaming = true;
        setTimeout(() => {
          state.isStreaming = false;
        }, 40);
      }, 20);
    }, 30);

    const onWait = vi.fn();
    const outcome = await waitForPiSessionIdle(session, {
      pollMs: 5,
      settleMs: 60,
      timeoutMs: 2_000,
      onWait,
    });

    expect(outcome).toBe('waited');
    expect(onWait).toHaveBeenCalledOnce();
    expect(session.abort).not.toHaveBeenCalled();
    expect(state.isStreaming).toBe(false);
  });

  it('aborts a stale run after the timeout', async () => {
    const { session, state } = fakeSession();
    state.isStreaming = true;

    const outcome = await waitForPiSessionIdle(session, { pollMs: 5, timeoutMs: 30 });

    expect(outcome).toBe('aborted_stale');
    expect(session.abortCompaction).toHaveBeenCalled();
    expect(session.abort).toHaveBeenCalled();
  });

  it('aborts promptly when the host signal is aborted', async () => {
    const { session, state } = fakeSession();
    state.isRetrying = true;
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);

    const outcome = await waitForPiSessionIdle(session, {
      signal: controller.signal,
      pollMs: 5,
      timeoutMs: Number.POSITIVE_INFINITY,
    });

    expect(outcome).toBe('aborted_stale');
    expect(session.abort).toHaveBeenCalled();
  });
});
