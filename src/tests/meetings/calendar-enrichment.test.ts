import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const mockState = vi.hoisted(() => ({
  googleConnected: true,
  token: 'google-token',
}));

vi.mock('../../main/connectors/connector-manager', () => ({
  connectorManager: {
    isConnected: (id: string) => (id === 'google' ? mockState.googleConnected : false),
    ensureFreshAccessToken: async () => ({ accessToken: mockState.token }),
  },
}));

vi.mock('../../main/utils/logger', () => ({
  log: () => {},
  logWarn: () => {},
}));

import {
  extractZoomMeetingIdFromText,
  findCurrentCalendarMeeting,
} from '../../main/meetings/calendar-enrichment';

describe('extractZoomMeetingIdFromText', () => {
  it('parses zoom.us/j meeting links', () => {
    expect(extractZoomMeetingIdFromText('Join https://zoom.us/j/12345678901?pwd=abc')).toBe(
      '12345678901'
    );
  });

  it('parses other Zoom URL shapes', () => {
    expect(extractZoomMeetingIdFromText('https://york.zoom.us/s/98765432109')).toBe('98765432109');
    expect(extractZoomMeetingIdFromText('https://zoom.us/wc/join/11122233344')).toBe('11122233344');
  });

  it('returns null when no Zoom id is present', () => {
    expect(extractZoomMeetingIdFromText('https://meet.google.com/abc-defg-hij')).toBeNull();
  });
});

describe('findCurrentCalendarMeeting', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    mockState.googleConnected = true;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns null when no Google connector is connected', async () => {
    mockState.googleConnected = false;
    expect(await findCurrentCalendarMeeting()).toBeNull();
  });

  it('prefers Zoom-linked calendar events', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        items: [
          {
            id: '1',
            summary: 'Lunch',
            location: 'Cafe',
            attendees: [{ email: 'a@york.ie', displayName: 'Ada' }],
          },
          {
            id: '2',
            summary: 'Standup',
            location: 'https://zoom.us/j/12345678901',
            attendees: [{ displayName: 'Bob' }],
          },
        ],
      }),
    })) as unknown as typeof fetch;

    const match = await findCurrentCalendarMeeting(Date.now());
    expect(match?.title).toBe('Standup');
    expect(match?.attendees).toContain('Bob');
    expect(match?.zoomMeetingId).toBe('12345678901');
  });

  it('extracts Zoom meeting id from description when location lacks it', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        items: [
          {
            id: '3',
            summary: 'Client call',
            description: 'Please join: https://zoom.us/j/55566677788',
            attendees: [],
          },
        ],
      }),
    })) as unknown as typeof fetch;

    const match = await findCurrentCalendarMeeting(Date.now());
    expect(match?.zoomMeetingId).toBe('55566677788');
  });
});
