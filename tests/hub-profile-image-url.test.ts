import { describe, expect, it, vi } from 'vitest';

vi.mock('../../shared/auth-config', () => ({
  authConfig: {
    hubApiUrl: 'https://api.uat-hub.yorkdevs.link',
  },
}));

import { normalizeProfileImageUrl } from '../../src/main/auth/hub-parse';

describe('normalizeProfileImageUrl', () => {
  it('prefixes Hub /documents paths with /api', () => {
    expect(
      normalizeProfileImageUrl(
        'https://api.uat-hub.yorkdevs.link/documents/kalrav@york.ie/profile-pic.png'
      )
    ).toBe('https://api.uat-hub.yorkdevs.link/api/documents/kalrav@york.ie/profile-pic.png');
  });

  it('resolves relative document paths against hub API base', () => {
    expect(normalizeProfileImageUrl('/documents/user@york.ie/pic.png')).toBe(
      'https://api.uat-hub.yorkdevs.link/api/documents/user@york.ie/pic.png'
    );
  });
});
