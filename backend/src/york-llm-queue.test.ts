import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  DEFAULT_YORK_LLM_MAX_CONCURRENT,
  resolveYorkLlmMaxConcurrent,
  YorkLlmQueue,
  YorkLlmQueueAbortedError,
} from './york-llm-queue.js';

describe('YorkLlmQueue', () => {
  const prevMax = process.env.YORK_LLM_MAX_CONCURRENT;
  afterEach(() => {
    if (prevMax === undefined) delete process.env.YORK_LLM_MAX_CONCURRENT;
    else process.env.YORK_LLM_MAX_CONCURRENT = prevMax;
  });

  it('defaults to 15 slots and honours YORK_LLM_MAX_CONCURRENT', () => {
    delete process.env.YORK_LLM_MAX_CONCURRENT;
    assert.equal(resolveYorkLlmMaxConcurrent(), DEFAULT_YORK_LLM_MAX_CONCURRENT);
    assert.equal(DEFAULT_YORK_LLM_MAX_CONCURRENT, 15);
    process.env.YORK_LLM_MAX_CONCURRENT = '8';
    assert.equal(resolveYorkLlmMaxConcurrent(), 8);
    process.env.YORK_LLM_MAX_CONCURRENT = 'nope';
    assert.equal(resolveYorkLlmMaxConcurrent(), 15);
  });

  it('grants up to the limit, then serves waiters in FIFO order', async () => {
    const queue = new YorkLlmQueue(() => 2);
    const first = await queue.acquire();
    const second = await queue.acquire();
    const order: string[] = [];
    const third = queue.acquire().then((release) => (order.push('third'), release));
    const fourth = queue.acquire().then((release) => (order.push('fourth'), release));
    await Promise.resolve();
    assert.deepEqual(queue.snapshot(), { maxConcurrent: 2, activeCount: 2, waitingCount: 2 });

    first();
    first();
    const thirdRelease = await third;
    assert.deepEqual(order, ['third']);
    assert.deepEqual(queue.snapshot(), { maxConcurrent: 2, activeCount: 2, waitingCount: 1 });

    second();
    (await fourth)();
    thirdRelease();
    assert.deepEqual(order, ['third', 'fourth']);
    assert.deepEqual(queue.snapshot(), { maxConcurrent: 2, activeCount: 0, waitingCount: 0 });
  });

  it('drops an aborted waiter without consuming a slot', async () => {
    const queue = new YorkLlmQueue(() => 1);
    const held = await queue.acquire();
    const controller = new AbortController();
    const waiting = queue.acquire(controller.signal);
    controller.abort();
    await assert.rejects(waiting, YorkLlmQueueAbortedError);
    assert.equal(queue.snapshot().waitingCount, 0);

    held();
    const next = await queue.acquire();
    assert.equal(queue.snapshot().activeCount, 1);
    next();
  });
});
