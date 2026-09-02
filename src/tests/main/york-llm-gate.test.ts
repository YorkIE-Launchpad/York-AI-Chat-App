import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acquireYorkLlmSlot,
  getYorkLlmGateSnapshot,
  resetYorkLlmGateForTests,
} from '../../main/york-llm/york-llm-gate';

describe('york-llm-gate', () => {
  beforeEach(() => {
    resetYorkLlmGateForTests();
    vi.stubEnv('YORK_LLM_MAX_CONCURRENT', '2');
  });

  afterEach(() => {
    resetYorkLlmGateForTests();
    vi.unstubAllEnvs();
  });

  it('allows up to max concurrent slots and queues additional acquires', async () => {
    const first = await acquireYorkLlmSlot({ sessionId: 's1' });
    const second = await acquireYorkLlmSlot({ sessionId: 's2' });

    let thirdResolved = false;
    const thirdPromise = acquireYorkLlmSlot({ sessionId: 's3' }).then((ticket) => {
      thirdResolved = true;
      return ticket;
    });

    await Promise.resolve();
    expect(thirdResolved).toBe(false);
    expect(getYorkLlmGateSnapshot().waitingCount).toBe(1);

    first.release();
    const third = await thirdPromise;
    expect(thirdResolved).toBe(true);
    expect(third.position).toBe(0);

    second.release();
    third.release();
    expect(getYorkLlmGateSnapshot().activeCount).toBe(0);
  });

  it('removes aborted waiters from the queue', async () => {
    const first = await acquireYorkLlmSlot({ sessionId: 's1' });
    const second = await acquireYorkLlmSlot({ sessionId: 's2' });

    const controller = new AbortController();
    const aborted = acquireYorkLlmSlot({ sessionId: 's3', signal: controller.signal });
    controller.abort();

    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' });
    expect(getYorkLlmGateSnapshot().waitingCount).toBe(0);

    first.release();
    second.release();
  });
});
