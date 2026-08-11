import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  Notification: Object.assign(vi.fn(), { isSupported: () => false }),
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock('../src/main/utils/logger', () => ({
  log: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import { selectMatterScanNotifyItems } from '../src/main/os-notifications';

/**
 * Pure selection logic for Matter scan OS notifications
 * (new / resurfaced / escalated critical|warning with cap).
 */
describe('matter OS scan notify selection', () => {
  it('notifies only newly urgent items on a typical scan delta', () => {
    const previous = [
      { fingerprint: 'stable-crit', severity: 'critical', status: 'active' },
      { fingerprint: 'stable-warn', severity: 'warning', status: 'active' },
      { fingerprint: 'signal-now', severity: 'signal', status: 'active' },
    ];
    const after = [
      {
        fingerprint: 'stable-crit',
        severity: 'critical',
        status: 'active',
        title: 'Stable critical',
      },
      {
        fingerprint: 'stable-warn',
        severity: 'warning',
        status: 'active',
        title: 'Stable warning',
      },
      {
        fingerprint: 'signal-now',
        severity: 'warning',
        status: 'active',
        title: 'Escalated to warning',
      },
      {
        fingerprint: 'brand-new',
        severity: 'critical',
        status: 'active',
        title: 'Brand new',
      },
    ];
    const { items, overflow } = selectMatterScanNotifyItems(previous, after);
    expect(overflow).toBe(0);
    expect(items.map((i) => i.fingerprint).sort()).toEqual(['brand-new', 'signal-now']);
  });

  it('produces overflow brief condition when more than 5 new urgents', () => {
    const after = Array.from({ length: 7 }, (_, i) => ({
      fingerprint: `n-${i}`,
      severity: 'critical' as const,
      status: 'active' as const,
      title: `N${i}`,
    }));
    const { items, overflow } = selectMatterScanNotifyItems([], after);
    expect(items).toHaveLength(5);
    expect(overflow).toBe(2);
  });

  it('skips snoozed and done statuses in after-set', () => {
    const { items } = selectMatterScanNotifyItems(
      [],
      [
        {
          fingerprint: 's',
          severity: 'critical',
          status: 'snoozed',
          title: 'Snoozed',
        },
        {
          fingerprint: 'd',
          severity: 'warning',
          status: 'done',
          title: 'Done',
        },
        {
          fingerprint: 'a',
          severity: 'warning',
          status: 'active',
          title: 'Active',
        },
      ]
    );
    expect(items.map((i) => i.fingerprint)).toEqual(['a']);
  });
});
