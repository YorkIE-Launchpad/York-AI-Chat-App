import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetYorkLlmGateForTests, getYorkLlmGateSnapshot } from '../../main/york-llm/york-llm-gate';
import {
  uninstallYorkLlmFetchGate,
  yorkLlmGatedFetchForTests,
} from '../../main/york-llm/york-llm-fetch-gate';

describe('york-llm-fetch-gate', () => {
  beforeEach(() => {
    resetYorkLlmGateForTests();
  });

  afterEach(() => {
    resetYorkLlmGateForTests();
    uninstallYorkLlmFetchGate();
  });

  it('passes through without acquiring a concurrency slot', async () => {
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
    await yorkLlmGatedFetchForTests(
      fetchMock,
      'http://llm.yorkdevs.link:2222/v1/chat/completions',
      { method: 'POST' }
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getYorkLlmGateSnapshot().activeCount).toBe(0);
  });

  it('does not gate non-york urls', async () => {
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
    await yorkLlmGatedFetchForTests(fetchMock, 'http://localhost:11434/v1/chat/completions', {
      method: 'POST',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
