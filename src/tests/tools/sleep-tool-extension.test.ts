import { describe, expect, it, vi } from 'vitest';
import {
  parseBashSleepCommandMs,
  SleepToolExtension,
  SLEEP_MAX_MS,
} from '../../main/tools/sleep-tool-extension';

describe('parseBashSleepCommandMs', () => {
  it('parses pure sleep commands', () => {
    expect(parseBashSleepCommandMs('sleep 15')).toBe(15_000);
    expect(parseBashSleepCommandMs('  Sleep 2.5  ')).toBe(2500);
    expect(parseBashSleepCommandMs('/usr/bin/sleep 1')).toBe(1000);
  });

  it('rejects non-sleep commands', () => {
    expect(parseBashSleepCommandMs('sleep 15 && echo hi')).toBeNull();
    expect(parseBashSleepCommandMs('echo sleep 15')).toBeNull();
  });
});

describe('SleepToolExtension', () => {
  it('completes naturally and reports success', async () => {
    const events: Array<{ type: string }> = [];
    const ext = new SleepToolExtension((event) => {
      events.push({ type: event.type });
    });

    const resultPromise = ext.executeSleep('sess-1', 'tool-1', 50);
    await vi.waitFor(() => {
      expect(events.some((e) => e.type === 'sleep.request')).toBe(true);
    });

    const result = await resultPromise;
    expect(result.content[0]?.text).toContain('Sleep completed.');
    expect(events.some((e) => e.type === 'sleep.dismiss')).toBe(true);
  });

  it('skip resolves as successful completion', async () => {
    const events: Array<{ type: string; payload?: { sleepId?: string } }> = [];
    const ext = new SleepToolExtension((event) => {
      events.push(event as { type: string; payload?: { sleepId?: string } });
    });

    const resultPromise = ext.executeSleep('sess-1', 'tool-1', 60_000);
    await vi.waitFor(() => {
      expect(events.some((e) => e.type === 'sleep.request')).toBe(true);
    });
    const sleepId = events.find((e) => e.type === 'sleep.request')?.payload?.sleepId;
    expect(sleepId).toBeTruthy();

    expect(ext.skipSleep(sleepId!)).toBe(true);
    const result = await resultPromise;
    expect(result.content[0]?.text).toMatch(/skipped by user/i);
    expect(result.content[0]?.text).toMatch(/Sleep completed/i);
  });

  it('caps very long sleeps', async () => {
    const ext = new SleepToolExtension(() => undefined);
    // Directly exercise bash parser cap used by the tool path
    expect(parseBashSleepCommandMs(`sleep ${SLEEP_MAX_MS / 1000 + 100}`)).toBe(SLEEP_MAX_MS);
    void ext;
  });
});
