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
