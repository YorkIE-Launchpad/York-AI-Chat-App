import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_MATTER_RUNTIME, type MatterRuntimeConfig } from '../src/shared/matter';
import { MatterScheduler, type MatterScanState } from '../src/main/matter/matter-scheduler';
import { createMatterStore } from '../src/main/matter/matter-store';
import type { DatabaseInstance, MatterItemRow } from '../src/main/db/database';

vi.mock('../src/main/utils/logger', () => ({
  log: () => {},
  logWarn: () => {},
  logError: () => {},
}));

const HOUR = 60 * 60 * 1000;

function at(hour: number, minute = 0): number {
  return new Date(2026, 9, 12, hour, minute, 0, 0).getTime();
}

function makeScheduler(options: {
  now: () => number;
  state: MatterScanState;
  runtime?: Partial<MatterRuntimeConfig>;
}) {
  const onTick = vi.fn();
  const onMorningBrief = vi.fn(() => true);
  const scheduler = new MatterScheduler({
    getRuntime: () => ({ ...DEFAULT_MATTER_RUNTIME, ...options.runtime }),
    getScanState: () => options.state,
    onTick,
    onMorningBrief,
    onEndOfDay: () => {},
    now: options.now,
  });
  return { scheduler, onTick, onMorningBrief };
}

describe('MatterScheduler wall-clock cadence', () => {
  it('is due once the interval has elapsed since the last scan, even after sleep', () => {
    let now = at(10);
    const state: MatterScanState = {
      lastAttemptAt: at(9, 50),
      lastAttemptFailed: false,
      busy: false,
    };
    const { scheduler } = makeScheduler({ now: () => now, state });
    expect(scheduler.isScanDue()).toBe(false);
    // Laptop asleep for hours: monotonic timers paused, wall clock did not.
    now = at(14);
    expect(scheduler.isScanDue()).toBe(true);
  });

  it('never scans outside the window or while a scan is running', () => {
    const state: MatterScanState = { lastAttemptAt: null, lastAttemptFailed: false, busy: false };
    expect(makeScheduler({ now: () => at(6), state }).scheduler.isScanDue()).toBe(false);
    expect(
      makeScheduler({ now: () => at(10), state: { ...state, busy: true } }).scheduler.isScanDue()
    ).toBe(false);
    expect(makeScheduler({ now: () => at(10), state }).scheduler.isScanDue()).toBe(true);
  });

  it('retries a failed scan sooner than the normal interval', () => {
    const state: MatterScanState = { lastAttemptAt: at(10), lastAttemptFailed: true, busy: false };
    const { scheduler } = makeScheduler({ now: () => at(10, 16), state });
    expect(scheduler.isScanDue()).toBe(true);
  });

  it('settings changes do not push the next scan back', () => {
    const state: MatterScanState = { lastAttemptAt: at(9), lastAttemptFailed: false, busy: false };
    const { scheduler, onTick } = makeScheduler({ now: () => at(10, 1), state });
    scheduler.start();
    scheduler.reschedule();
    scheduler.stop();
    expect(onTick).toHaveBeenCalledWith('interval');
  });

  it('catches up the morning brief when the Mac wakes late, once per day', () => {
    let now = at(9, 30);
    const state: MatterScanState = {
      lastAttemptAt: at(9, 29),
      lastAttemptFailed: false,
      busy: false,
    };
    const { scheduler, onMorningBrief } = makeScheduler({ now: () => now, state });
    scheduler.start();
    scheduler.reschedule();
    now = at(9, 31);
    scheduler.reschedule();
    scheduler.stop();
    expect(onMorningBrief).toHaveBeenCalledTimes(1);
  });
});

function fakeDb(rows: MatterItemRow[]): DatabaseInstance {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return {
    matterItems: {
      listActive: () =>
        [...byId.values()].filter((r) => ['active', 'snoozed', 'resurfaced'].includes(r.status)),
      update: (id: string, updates: Partial<MatterItemRow>) => {
        const row = byId.get(id);
        if (row) byId.set(id, { ...row, ...updates });
      },
      get: (id: string) => byId.get(id),
    },
  } as unknown as DatabaseInstance;
}

function row(
  partial: Partial<MatterItemRow> & Pick<MatterItemRow, 'id' | 'source'>
): MatterItemRow {
  return {
    fingerprint: partial.id,
    title: partial.id,
    summary: '',
    why_it_matters: '',
    raw_details: null,
    severity: 'signal',
    orbit: 'today',
    category: 'comms',
    source_ref: '{}',
    confidence: 0.8,
    suggested_action: null,
    status: 'active',
    pinned: 0,
    snooze_until: null,
    due_at: null,
    remind_at: null,
    expires_at: null,
    reminder_notified_at: null,
    expired_notified_at: null,
    rank_score: 50,
    created_at: 0,
    updated_at: 0,
    last_seen_at: 0,
    resolved_at: null,
    ...partial,
  } as MatterItemRow;
}

describe('reconcileAbsentItems', () => {
  it('keeps items still at source, from skipped sources, or inside the grace window', () => {
    const now = 10 * HOUR;
    const db = fakeDb([
      row({ id: 'still-there', source: 'slack', last_seen_at: 0 }),
      row({ id: 'source-skipped', source: 'jira', last_seen_at: 0 }),
      row({ id: 'recently-seen', source: 'slack', last_seen_at: now - HOUR }),
      row({ id: 'gone', source: 'slack', last_seen_at: now - 2 * HOUR }),
      row({ id: 'pinned', source: 'slack', last_seen_at: 0, pinned: 1 }),
    ]);
    const store = createMatterStore(db);
    const expired = store.reconcileAbsentItems({
      seenFingerprints: ['still-there'],
      checkedSources: ['slack'],
      graceMs: 1.5 * HOUR,
      now,
    });
    expect(expired).toBe(1);
    const status = (id: string) => db.matterItems.get(id)?.status;
    expect(status('gone')).toBe('expired');
    expect(status('still-there')).toBe('active');
    expect(db.matterItems.get('still-there')?.last_seen_at).toBe(now);
    expect(status('source-skipped')).toBe('active');
    expect(status('recently-seen')).toBe('active');
    expect(status('pinned')).toBe('active');
  });
});
