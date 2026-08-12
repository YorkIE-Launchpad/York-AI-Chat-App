import { describe, expect, it } from 'vitest';
import {
  isAllDayCalendarEvent,
  isDailySeriesMeeting,
  isPersonalCalendarHold,
} from '../src/main/matter/matter-collector';

describe('isPersonalCalendarHold', () => {
  it('drops personal hold titles', () => {
    for (const title of ['Break', 'block', 'Focus time', 'OOO', 'Lunch', 'focus block', 'PTO']) {
      expect(isPersonalCalendarHold(title), title).toBe(true);
    }
  });

  it('keeps real meeting titles', () => {
    for (const title of ['1:1 with Ada', 'Sprint planning', 'Unblock checkout']) {
      expect(isPersonalCalendarHold(title), title).toBe(false);
    }
  });

  it('treats blank titles as holds', () => {
    expect(isPersonalCalendarHold('')).toBe(true);
    expect(isPersonalCalendarHold('   ')).toBe(true);
  });
});

describe('isDailySeriesMeeting', () => {
  it('drops daily title patterns', () => {
    for (const title of [
      'Daily standup',
      'daily sync',
      'Daily series',
      'Daily check-in',
      'Daily',
    ]) {
      expect(isDailySeriesMeeting(title), title).toBe(true);
    }
  });

  it('drops FREQ=DAILY from event detail even with a non-hold title', () => {
    expect(
      isDailySeriesMeeting(
        'Engineering huddle',
        'Recurrence:\nRRULE:FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR'
      )
    ).toBe(true);
    expect(isPersonalCalendarHold('Engineering huddle')).toBe(false);
  });

  it('drops weekday-every-day WEEKLY RRULE with a non-hold title', () => {
    expect(
      isDailySeriesMeeting(
        'Engineering huddle',
        'Recurrence:\nRRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR'
      )
    ).toBe(true);
    expect(
      isDailySeriesMeeting(
        'Standup',
        'Recurrence:\nRRULE:BYDAY=FR,MO,TH,TU,WE;FREQ=WEEKLY'
      )
    ).toBe(true);
    expect(isPersonalCalendarHold('Engineering huddle')).toBe(false);
  });

  it('drops when connector keywords mark the event daily', () => {
    expect(
      isDailySeriesMeeting(
        'Team sync',
        JSON.stringify({ keywords: ['calendar', 'event', 'Team sync', 'daily'] })
      )
    ).toBe(true);
  });

  it('keeps weekly-once / timed one-offs that are not daily', () => {
    expect(isDailySeriesMeeting('1:1 with Ada')).toBe(false);
    expect(isDailySeriesMeeting('Sprint planning', 'Recurrence:\nRRULE:FREQ=WEEKLY;BYDAY=MO')).toBe(
      false
    );
    expect(isDailySeriesMeeting('Customer kickoff')).toBe(false);
    expect(
      isDailySeriesMeeting(
        'Planning',
        'Recurrence:\nRRULE:FREQ=WEEKLY;BYDAY=MO,WE'
      )
    ).toBe(false);
  });
});

describe('isAllDayCalendarEvent', () => {
  it('drops date-only ranges even with a non-hold title', () => {
    expect(isAllDayCalendarEvent('2026-08-12 → 2026-08-13')).toBe(true);
    expect(isAllDayCalendarEvent('2026-08-12')).toBe(true);
    expect(isPersonalCalendarHold('Company offsite')).toBe(false);
    expect(
      isAllDayCalendarEvent(
        'ignored',
        'Company offsite (2026-08-12 → 2026-08-13)'
      )
    ).toBe(true);
  });

  it('keeps timed events', () => {
    expect(isAllDayCalendarEvent('2026-08-12T10:00:00Z → 2026-08-12T11:00:00Z')).toBe(false);
    expect(isAllDayCalendarEvent('2026-08-12 10:00 → 2026-08-12 11:00')).toBe(false);
    expect(
      isAllDayCalendarEvent('', '1:1 with Ada (2026-08-12T15:00:00Z → 2026-08-12T15:30:00Z)')
    ).toBe(false);
  });
});
