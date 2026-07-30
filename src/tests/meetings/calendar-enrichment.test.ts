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

import { findCurrentCalendarMeeting } from '../../main/meetings/calendar-enrichment';

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
            location: 'https://zoom.us/j/123',
            attendees: [{ displayName: 'Bob' }],
          },
        ],
      }),
    })) as unknown as typeof fetch;

    const match = await findCurrentCalendarMeeting(Date.now());
    expect(match?.title).toBe('Standup');
    expect(match?.attendees).toContain('Bob');
  });
});
