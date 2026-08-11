import { beforeEach, describe, expect, it, vi } from 'vitest';

const { NotificationMock, showMock, instances, isSupportedMock } = vi.hoisted(() => {
  const showMock = vi.fn();
  const isSupportedMock = vi.fn(() => true);
  const instances: Array<{
    on: ReturnType<typeof vi.fn>;
    show: typeof showMock;
    emit: (event: string, ...args: unknown[]) => void;
  }> = [];

  class NotificationMock {
    static isSupported = isSupportedMock;
    on: ReturnType<typeof vi.fn>;
    show: typeof showMock;
    private handlers: Record<string, Array<(...args: unknown[]) => void>> = {};

    constructor(_opts: unknown) {
      this.on = vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        if (!this.handlers[event]) this.handlers[event] = [];
        this.handlers[event].push(cb);
      });
      this.show = showMock;
      instances.push(this as unknown as (typeof instances)[number]);
    }

    emit(event: string, ...args: unknown[]) {
      for (const cb of this.handlers[event] || []) cb(...args);
    }
  }

  return { NotificationMock, showMock, instances, isSupportedMock };
});

vi.mock('electron', () => ({
  Notification: NotificationMock,
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
}));

vi.mock('../src/main/utils/logger', () => ({
  log: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import {
  showOsNotification,
  selectMatterScanNotifyItems,
  truncateNotifyBody,
} from '../src/main/os-notifications';

describe('os-notifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    instances.length = 0;
    isSupportedMock.mockReturnValue(true);
  });

  it('shows a notification when supported', () => {
    showOsNotification({ title: 'Hello', body: 'World', tag: 'Test' });
    expect(showMock).toHaveBeenCalled();
  });

  it('skips when Notification is not supported', () => {
    isSupportedMock.mockReturnValue(false);
    showOsNotification({ title: 'Hello', body: 'World' });
    expect(showMock).not.toHaveBeenCalled();
  });

  it('invokes onClick when notification is clicked', () => {
    const onClick = vi.fn();
    showOsNotification({ title: 'T', body: 'B', onClick });
    const latest = instances[instances.length - 1];
    latest.emit('click');
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('releases retention on close and failed', () => {
    showOsNotification({ title: 'T', body: 'B' });
    const latest = instances[instances.length - 1];
    expect(() => latest.emit('close')).not.toThrow();
    showOsNotification({ title: 'T2', body: 'B2' });
    const failedOne = instances[instances.length - 1];
    expect(() => failedOne.emit('failed', {}, 'err')).not.toThrow();
  });
});

describe('selectMatterScanNotifyItems', () => {
  it('notifies new critical and warning items', () => {
    const result = selectMatterScanNotifyItems(
      [],
      [
        {
          fingerprint: 'a',
          severity: 'critical',
          status: 'active',
          title: 'A',
        },
        {
          fingerprint: 'b',
          severity: 'warning',
          status: 'active',
          title: 'B',
        },
        {
          fingerprint: 'c',
          severity: 'signal',
          status: 'active',
          title: 'C',
        },
      ]
    );
    expect(result.items.map((i) => i.fingerprint)).toEqual(['a', 'b']);
    expect(result.overflow).toBe(0);
  });

  it('does not re-notify unchanged active urgent items', () => {
    const previous = [
      { fingerprint: 'a', severity: 'critical', status: 'active' },
      { fingerprint: 'b', severity: 'warning', status: 'active' },
    ];
    const after = [
      {
        fingerprint: 'a',
        severity: 'critical',
        status: 'active',
        title: 'A',
      },
      {
        fingerprint: 'b',
        severity: 'warning',
        status: 'active',
        title: 'B',
      },
    ];
    const result = selectMatterScanNotifyItems(previous, after);
    expect(result.items).toEqual([]);
    expect(result.overflow).toBe(0);
  });

  it('notifies on resurface and severity escalation', () => {
    const result = selectMatterScanNotifyItems(
      [
        { fingerprint: 'gone', severity: 'warning', status: 'done' },
        { fingerprint: 'soft', severity: 'signal', status: 'active' },
        { fingerprint: 'warn', severity: 'warning', status: 'active' },
      ],
      [
        {
          fingerprint: 'gone',
          severity: 'warning',
          status: 'resurfaced',
          title: 'Back',
        },
        {
          fingerprint: 'soft',
          severity: 'critical',
          status: 'active',
          title: 'Escalated',
        },
        {
          fingerprint: 'warn',
          severity: 'critical',
          status: 'active',
          title: 'More urgent',
        },
      ]
    );
    expect(result.items.map((i) => i.fingerprint).sort()).toEqual(['gone', 'soft', 'warn']);
  });

  it('caps per-scan items and reports overflow', () => {
    const after = Array.from({ length: 8 }, (_, i) => ({
      fingerprint: `fp-${i}`,
      severity: i % 2 === 0 ? 'critical' : 'warning',
      status: 'active' as const,
      title: `Item ${i}`,
    }));
    const result = selectMatterScanNotifyItems([], after, 5);
    expect(result.items).toHaveLength(5);
    expect(result.overflow).toBe(3);
  });
});

describe('truncateNotifyBody', () => {
  it('truncates long text with ellipsis', () => {
    const long = 'x'.repeat(250);
    const out = truncateNotifyBody(long, 200);
    expect(out.length).toBe(200);
    expect(out.endsWith('…')).toBe(true);
  });
});
