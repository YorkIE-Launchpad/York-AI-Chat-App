import { describe, expect, it } from 'vitest';
import { MATTER_DEFAULT_SNOOZE_MS, MATTER_MIN_SNOOZE_MS } from '../src/shared/matter';

describe('Matter snooze duration defaults', () => {
  it('defaults to 24 hours (not 1 hour)', () => {
    expect(MATTER_DEFAULT_SNOOZE_MS).toBe(24 * 60 * 60 * 1000);
    expect(MATTER_DEFAULT_SNOOZE_MS).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000);
    expect(MATTER_DEFAULT_SNOOZE_MS).toBeLessThanOrEqual(48 * 60 * 60 * 1000);
  });

  it('enforces a minimum snooze of at least one hour', () => {
    expect(MATTER_MIN_SNOOZE_MS).toBe(60 * 60 * 1000);
  });
});
