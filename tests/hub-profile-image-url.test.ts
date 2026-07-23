import { describe, expect, it, vi } from 'vitest';

vi.mock('../../shared/auth-config', () => ({
  authConfig: {
    hubApiUrl: 'https://api.uat-hub.yorkdevs.link',
  },
}));

import { extractHubDocumentS3Key, normalizeProfileImageUrl } from '../../src/main/auth/hub-parse';

describe('extractHubDocumentS3Key', () => {
  it('returns documents keys as-is', () => {
    expect(extractHubDocumentS3Key('documents/user@york.ie/pic.png')).toBe(
      'documents/user@york.ie/pic.png'
    );
  });

  it('strips leading slash from /documents paths', () => {
    expect(extractHubDocumentS3Key('/documents/user@york.ie/pic.png')).toBe(
      'documents/user@york.ie/pic.png'
    );
  });

  it('converts Hub absolute /documents URLs to keys', () => {
    expect(
      extractHubDocumentS3Key(
        'https://api.uat-hub.yorkdevs.link/documents/kalrav@york.ie/profile-pic.png'
      )
    ).toBe('documents/kalrav@york.ie/profile-pic.png');
  });

  it('converts mistaken Hub /api/documents URLs to keys', () => {
    expect(
      extractHubDocumentS3Key(
        'https://api.uat-hub.yorkdevs.link/api/documents/kalrav@york.ie/profile-pic.png'
      )
    ).toBe('documents/kalrav@york.ie/profile-pic.png');
  });

  it('returns null for non-Hub https URLs', () => {
    expect(extractHubDocumentS3Key('https://lh3.googleusercontent.com/a/photo')).toBeNull();
  });
});

describe('normalizeProfileImageUrl', () => {
  it('preserves Hub S3 document keys', () => {
    expect(normalizeProfileImageUrl('documents/user@york.ie/pic.png')).toBe(
      'documents/user@york.ie/pic.png'
    );
  });

  it('converts Hub /documents absolute URLs to S3 keys', () => {
    expect(
      normalizeProfileImageUrl(
        'https://api.uat-hub.yorkdevs.link/documents/kalrav@york.ie/profile-pic.png'
      )
    ).toBe('documents/kalrav@york.ie/profile-pic.png');
  });

  it('converts Hub /api/documents absolute URLs to S3 keys', () => {
    expect(
      normalizeProfileImageUrl(
        'https://api.uat-hub.yorkdevs.link/api/documents/kalrav@york.ie/profile-pic.png'
      )
    ).toBe('documents/kalrav@york.ie/profile-pic.png');
  });

  it('leaves non-Hub https URLs unchanged', () => {
    expect(normalizeProfileImageUrl('https://lh3.googleusercontent.com/a/photo')).toBe(
      'https://lh3.googleusercontent.com/a/photo'
    );
  });

  it('resolves other relative Hub paths against hub API base', () => {
    expect(normalizeProfileImageUrl('/avatars/me.png')).toBe(
      'https://api.uat-hub.yorkdevs.link/avatars/me.png'
    );
  });
});
