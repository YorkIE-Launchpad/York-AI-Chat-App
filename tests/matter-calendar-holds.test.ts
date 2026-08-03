import { describe, expect, it } from 'vitest';
import { isDailySeriesMeeting, isPersonalCalendarHold } from '../src/main/matter/matter-collector';

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

  it('drops FREQ=DAILY from event detail even with a normal title', () => {
    expect(
      isDailySeriesMeeting(
        'Engineering huddle',
        'Recurrence:\nRRULE:FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR'
      )
    ).toBe(true);
  });

  it('keeps weekly / one-off meetings', () => {
    expect(isDailySeriesMeeting('1:1 with Ada')).toBe(false);
    expect(isDailySeriesMeeting('Sprint planning', 'Recurrence:\nRRULE:FREQ=WEEKLY;BYDAY=MO')).toBe(
      false
    );
    expect(isDailySeriesMeeting('Customer kickoff')).toBe(false);
  });
});
