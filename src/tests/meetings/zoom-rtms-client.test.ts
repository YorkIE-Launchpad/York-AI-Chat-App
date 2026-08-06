import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../shared/auth-config', () => ({
  authConfig: {
    zoomConnectorClientId: 'zoom-client-id',
    zoomConnectorClientSecret: 'secret',
  },
}));

vi.mock('../../shared/backend-config', () => ({
  resolveBackendUrl: () => 'http://localhost:9999',
}));

vi.mock('../../main/config/backend-auth', () => ({
  getBackendAuthHeaders: async () => ({ Authorization: 'Bearer cognito' }),
}));

vi.mock('../../main/utils/logger', () => ({
  log: () => {},
  logWarn: () => {},
}));

import { ZoomRtmsDesktopClient } from '../../main/meetings/zoom-rtms-client';

describe('ZoomRtmsDesktopClient.startParticipantRtms', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('PATCHes live_meetings rtms_app/status with client_id', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '{}',
    } as Response);

    const client = new ZoomRtmsDesktopClient();
    const ok = await client.startParticipantRtms('access-token', '123456789');
    expect(ok).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://api.zoom.us/v2/live_meetings/123456789/rtms_app/status',
      expect.objectContaining({
        method: 'PATCH',
        headers: expect.objectContaining({
          Authorization: 'Bearer access-token',
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({
          action: 'start',
          settings: { client_id: 'zoom-client-id' },
        }),
      })
    );
  });

  it('treats already-active RTMS responses as success', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ message: 'RTMS already started for this meeting' }),
    } as Response);

    const client = new ZoomRtmsDesktopClient();
    expect(await client.startParticipantRtms('token', '999')).toBe(true);
  });

  it('returns false on hard Zoom errors', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue({
      ok: false,
      status: 2310,
      text: async () =>
        JSON.stringify({ code: 2310, message: 'Failed to perform RTMS app operation.' }),
    } as Response);

    const client = new ZoomRtmsDesktopClient();
    expect(await client.startParticipantRtms('token', '999')).toBe(false);
  });
});

describe('ZoomRtmsDesktopClient.poll speaker updates', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    vi.useFakeTimers();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it('delivers speakerUpdates from poll JSON even without new segments', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        segments: [],
        nextCursor: 2,
        speakerUpdates: [
          { id: 'seg-1', speaker: 'Grace', speakerUserId: '11' },
          { id: 'seg-2', speaker: '  ', speakerUserId: '12' },
          { id: 'bad' },
        ],
      }),
    } as Response);

    const client = new ZoomRtmsDesktopClient();
    const batches: Array<{ segments: unknown[]; speakerUpdates: unknown[] }> = [];
    // Seed session id used by polling without a full register round-trip.
    (client as unknown as { yorkMeetingId: string }).yorkMeetingId = 'york-1';

    client.startPolling('york-1', (batch) => {
      batches.push(batch);
    });

    await vi.advanceTimersByTimeAsync(0);
    // Allow the initial void pollOnce() promise to settle.
    await Promise.resolve();
    await Promise.resolve();

    expect(batches).toHaveLength(1);
    expect(batches[0]?.segments).toEqual([]);
    expect(batches[0]?.speakerUpdates).toEqual([
      { id: 'seg-1', speaker: 'Grace', speakerUserId: '11' },
    ]);

    client.stopPolling();
  });

  it('fetchAllSegments requests after=0 without advancing poll cursor', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        segments: [
          {
            id: 's1',
            text: 'hi',
            speaker: 'Ada',
            speakerUserId: '1',
            startedAt: 1,
            endedAt: 2,
          },
        ],
        nextCursor: 1,
        speakerUpdates: [],
      }),
    } as Response);

    const client = new ZoomRtmsDesktopClient();
    (client as unknown as { yorkMeetingId: string; cursor: number }).yorkMeetingId = 'york-1';
    (client as unknown as { cursor: number }).cursor = 5;

    const segments = await client.fetchAllSegments();
    expect(segments).toHaveLength(1);
    expect(segments[0]?.speaker).toBe('Ada');
    expect((client as unknown as { cursor: number }).cursor).toBe(5);

    const calledUrl = String(vi.mocked(globalThis.fetch).mock.calls[0]?.[0]);
    expect(calledUrl).toContain('/zoom/sessions/york-1/segments');
    expect(calledUrl).toContain('after=0');
  });
});
