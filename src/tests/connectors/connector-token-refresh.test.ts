import { describe, expect, it } from 'vitest';
import { connectorAccessTokenNeedsRefresh } from '../../main/connectors/connector-manager';

describe('connectorAccessTokenNeedsRefresh', () => {
  const now = 1_700_000_000_000;

  it('returns false when expiry is more than 60s away', () => {
    expect(
      connectorAccessTokenNeedsRefresh(
        {
          expiresAt: now + 5 * 60_000,
          updatedAt: now - 10_000,
          refreshToken: 'rt',
        },
        now
      )
    ).toBe(false);
  });

  it('returns true when expiry is within the 60s buffer', () => {
    expect(
      connectorAccessTokenNeedsRefresh(
        {
          expiresAt: now + 30_000,
          updatedAt: now - 10_000,
          refreshToken: 'rt',
        },
        now
      )
    ).toBe(true);
  });

  it('returns true when already expired', () => {
    expect(
      connectorAccessTokenNeedsRefresh(
        {
          expiresAt: now - 1_000,
          updatedAt: now - 3_600_000,
          refreshToken: 'rt',
        },
        now
      )
    ).toBe(true);
  });

  it('forceRefresh always returns true', () => {
    expect(
      connectorAccessTokenNeedsRefresh(
        {
          expiresAt: now + 3_600_000,
          updatedAt: now,
          refreshToken: 'rt',
        },
        now,
        { forceRefresh: true }
      )
    ).toBe(true);
  });

  it('refreshes stale tokens that lack expiresAt when a refresh token exists', () => {
    expect(
      connectorAccessTokenNeedsRefresh(
        {
          expiresAt: null,
          updatedAt: now - 51 * 60_000,
          refreshToken: 'rt',
        },
        now
      )
    ).toBe(true);
  });

  it('does not refresh recent tokens that lack expiresAt', () => {
    expect(
      connectorAccessTokenNeedsRefresh(
        {
          expiresAt: null,
          updatedAt: now - 5 * 60_000,
          refreshToken: 'rt',
        },
        now
      )
    ).toBe(false);
  });
});
