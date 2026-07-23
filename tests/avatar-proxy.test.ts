import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../shared/auth-config', () => ({
  authConfig: {
    hubApiUrl: 'https://api.uat-hub.yorkdevs.link',
  },
}));

import {
  clearAvatarCache,
  extractPresignedUrlFromBody,
  resolveAvatarDataUrl,
} from '../../src/main/auth/avatar-proxy';

describe('extractPresignedUrlFromBody', () => {
  it('reads top-level url', () => {
    expect(extractPresignedUrlFromBody({ url: 'https://s3.example/signed' })).toBe(
      'https://s3.example/signed'
    );
  });

  it('reads nested data.url', () => {
    expect(extractPresignedUrlFromBody({ data: { url: 'https://s3.example/nested' } })).toBe(
      'https://s3.example/nested'
    );
  });

  it('returns null when missing', () => {
    expect(extractPresignedUrlFromBody({ success: true })).toBeNull();
  });
});

describe('resolveAvatarDataUrl', () => {
  afterEach(() => {
    clearAvatarCache();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('presigns Hub document keys then fetches image bytes as a data URL', async () => {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/storage/presigned-url')) {
        expect(url).toContain('key=documents');
        expect(init?.headers).toMatchObject({
          Authorization: 'Bearer access-token',
        });
        return new Response(JSON.stringify({ data: { url: 'https://s3.example/signed.png' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url === 'https://s3.example/signed.png') {
        return new Response(pngBytes, {
          status: 200,
          headers: { 'content-type': 'image/png' },
        });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const dataUrl = await resolveAvatarDataUrl(
      'https://api.uat-hub.yorkdevs.link/api/documents/user@york.ie/pic.png',
      ['access-token', 'id-token']
    );

    expect(dataUrl).toBe(`data:image/png;base64,${pngBytes.toString('base64')}`);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns null when Hub presign fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ message: 'Unauthorized' }), { status: 401 }))
    );

    const dataUrl = await resolveAvatarDataUrl('documents/user@york.ie/pic.png', ['bad-token']);
    expect(dataUrl).toBeNull();
  });
});
