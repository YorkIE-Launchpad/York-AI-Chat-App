import { describe, expect, it } from 'vitest';
import {
  deriveMatterTimeFields,
  formatDueRelative,
  MATTER_REMIND_LEAD_MS,
  shouldFireExpiry,
  shouldFireReminder,
  urgencyFromDueAt,
} from '../src/shared/matter-time';

describe('deriveMatterTimeFields', () => {
  const now = Date.parse('2026-08-04T12:00:00.000Z');

  it('returns null times when no dueAt', () => {
    expect(deriveMatterTimeFields({ now })).toEqual({
      dueAt: null,
      remindAt: null,
      expiresAt: null,
    });
  });

  it('sets remindAt 15m before due and expiresAt at due for calendar', () => {
    const dueAt = now + 60 * 60 * 1000; // 1h ahead
    const fields = deriveMatterTimeFields({ dueAt, source: 'calendar', now });
    expect(fields.dueAt).toBe(dueAt);
    expect(fields.remindAt).toBe(dueAt - MATTER_REMIND_LEAD_MS);
    expect(fields.expiresAt).toBe(dueAt);
  });

  it('respects explicit expiresAt later than due', () => {
    const dueAt = now + 60 * 60 * 1000;
    const expiresAt = dueAt + 30 * 60 * 1000;
    const fields = deriveMatterTimeFields({ dueAt, expiresAt, source: 'calendar', now });
    expect(fields.expiresAt).toBe(expiresAt);
    expect(fields.remindAt).toBe(dueAt - MATTER_REMIND_LEAD_MS);
  });

  it('skips remindAt when already past remind window', () => {
    const dueAt = now + 5 * 60 * 1000; // 5m ahead (< 15m lead)
    const fields = deriveMatterTimeFields({ dueAt, now });
    expect(fields.remindAt).toBeNull();
    expect(fields.dueAt).toBe(dueAt);
  });
});

describe('urgencyFromDueAt', () => {
  const now = Date.parse('2026-08-04T12:00:00.000Z');

  it('marks within 1h as critical / now', () => {
    const u = urgencyFromDueAt(now + 30 * 60 * 1000, now);
    expect(u?.severity).toBe('critical');
    expect(u?.orbit).toBe('now');
  });

  it('marks overdue as critical', () => {
    const u = urgencyFromDueAt(now - 5 * 60 * 1000, now);
    expect(u?.severity).toBe('critical');
    expect(u?.orbit).toBe('now');
  });
});

describe('shouldFireReminder / shouldFireExpiry', () => {
  const now = Date.parse('2026-08-04T12:00:00.000Z');

  it('fires reminder once when due', () => {
    expect(
      shouldFireReminder(
        {
          remindAt: now - 1000,
          reminderNotifiedAt: null,
          status: 'active',
        },
        now
      )
    ).toBe(true);

    expect(
      shouldFireReminder(
        {
          remindAt: now - 1000,
          reminderNotifiedAt: now - 500,
          status: 'active',
        },
        now
      )
    ).toBe(false);
  });

  it('does not fire reminder while snoozed', () => {
    expect(
      shouldFireReminder(
        {
          remindAt: now - 1000,
          reminderNotifiedAt: null,
          status: 'active',
          snoozeUntil: now + 60_000,
        },
        now
      )
    ).toBe(false);
  });

  it('fires expiry once when past expiresAt', () => {
    expect(
      shouldFireExpiry(
        {
          expiresAt: now - 1000,
          expiredNotifiedAt: null,
          status: 'active',
        },
        now
      )
    ).toBe(true);

    expect(
      shouldFireExpiry(
        {
          expiresAt: now - 1000,
          expiredNotifiedAt: now,
          status: 'active',
        },
        now
      )
    ).toBe(false);
  });

  it('skips expiry for pinned items', () => {
    expect(
      shouldFireExpiry(
        {
          expiresAt: now - 1000,
          expiredNotifiedAt: null,
          status: 'active',
          pinned: true,
        },
        now
      )
    ).toBe(false);
  });
});

describe('formatDueRelative', () => {
  const now = Date.parse('2026-08-04T12:00:00.000Z');

  it('formats future and overdue', () => {
    expect(formatDueRelative(now + 45 * 60 * 1000, now)).toBe('in 45m');
    expect(formatDueRelative(now - 20 * 60 * 1000, now)).toBe('overdue 20m');
    expect(formatDueRelative(now, now)).toBe('due now');
  });
});
