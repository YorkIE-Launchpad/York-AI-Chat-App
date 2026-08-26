import { describe, expect, it } from 'vitest';
import {
  deriveMatterTimeFields,
  formatDueRelative,
  formatMeetingWhen,
  MATTER_REMIND_LEAD_MS,
  orbitFromRankScore,
  pickNextUpMeeting,
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

describe('orbitFromRankScore', () => {
  const now = Date.parse('2026-08-04T12:00:00.000Z');

  it('maps high rankScore to the inner now ring', () => {
    expect(orbitFromRankScore(90)).toBe('now');
    expect(orbitFromRankScore(90, { fallbackOrbit: 'watching' })).toBe('now');
  });

  it('maps mid scores to today/week and low scores to watching', () => {
    expect(orbitFromRankScore(60)).toBe('today');
    expect(orbitFromRankScore(30)).toBe('week');
    expect(orbitFromRankScore(10)).toBe('watching');
  });

  it('floors overdue calendar items to now even with a low score', () => {
    expect(orbitFromRankScore(10, { dueAt: now - 60 * 60 * 1000, now })).toBe('now');
  });

  it('keeps a closer fallback orbit when rank is lower', () => {
    expect(orbitFromRankScore(10, { fallbackOrbit: 'today' })).toBe('today');
  });

  it('pins to now regardless of score', () => {
    expect(orbitFromRankScore(5, { pinned: true, fallbackOrbit: 'watching' })).toBe('now');
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

describe('formatMeetingWhen', () => {
  it('uses date and hour:minute without seconds/ISO', () => {
    // Local timezone — assert shape, not fixed offset string.
    const start = Date.parse('2026-08-26T14:00:00.000Z');
    const end = Date.parse('2026-08-26T14:30:00.000Z');
    const label = formatMeetingWhen(start, end);
    expect(label).not.toMatch(/T\d{2}:\d{2}:\d{2}/);
    expect(label).not.toContain('.000');
    expect(label).toMatch(/\d/);
    expect(label).toContain('·');
    expect(label).toContain('–');
  });

  it('falls back when start is missing', () => {
    expect(formatMeetingWhen(null, null, 'fallback')).toBe('fallback');
  });
});

describe('pickNextUpMeeting', () => {
  const now = Date.parse('2026-08-26T12:00:00.000Z');

  it('picks the soonest not-yet-ended meeting', () => {
    const next = pickNextUpMeeting(
      [
        {
          id: 'past',
          startMs: now - 2 * 3600_000,
          endMs: now - 3600_000,
        },
        {
          id: 'later',
          startMs: now + 3 * 3600_000,
          endMs: now + 3.5 * 3600_000,
        },
        {
          id: 'soon',
          startMs: now + 30 * 60_000,
          endMs: now + 60 * 60_000,
        },
      ],
      now
    );
    expect(next?.id).toBe('soon');
  });

  it('keeps an in-progress meeting as next up', () => {
    const next = pickNextUpMeeting(
      [
        {
          id: 'live',
          startMs: now - 10 * 60_000,
          endMs: now + 20 * 60_000,
        },
        {
          id: 'later',
          startMs: now + 60 * 60_000,
          endMs: now + 90 * 60_000,
        },
      ],
      now
    );
    expect(next?.id).toBe('live');
  });
});
