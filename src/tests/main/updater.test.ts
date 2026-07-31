import { describe, expect, it } from 'vitest';
import { shouldEnableAutoUpdater, UPDATE_FEED_URL } from '../../main/updater';

describe('shouldEnableAutoUpdater', () => {
  it('enables only for packaged macOS', () => {
    expect(shouldEnableAutoUpdater({ isPackaged: true, platform: 'darwin' })).toBe(true);
  });

  it('disables for unpackaged / non-mac platforms', () => {
    expect(shouldEnableAutoUpdater({ isPackaged: false, platform: 'darwin' })).toBe(false);
    expect(shouldEnableAutoUpdater({ isPackaged: true, platform: 'win32' })).toBe(false);
    expect(shouldEnableAutoUpdater({ isPackaged: true, platform: 'linux' })).toBe(false);
  });
});

describe('UPDATE_FEED_URL', () => {
  it('points at the S3 latest prefix used by upload-s3', () => {
    expect(UPDATE_FEED_URL).toBe(
      'https://york-internal-apps.s3.ap-south-1.amazonaws.com/york-workos/latest'
    );
  });
});
