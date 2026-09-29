import { describe, expect, it } from 'vitest';
import { matterDeadline } from '../../main/loops/loop-extractor';
import type { MatterItem } from '../../shared/matter';

const now = Date.UTC(2026, 8, 29, 10);

describe('matterDeadline', () => {
  it('ignores past dueAt (Matter falls back to the signal timestamp)', () => {
    expect(matterDeadline({ dueAt: now - 3_600_000 } as MatterItem, now)).toBeNull();
  });

  it('keeps future deadlines', () => {
    expect(matterDeadline({ dueAt: now + 86_400_000 } as MatterItem, now)).toBe(now + 86_400_000);
  });

  it('handles missing dueAt', () => {
    expect(matterDeadline({ dueAt: null } as MatterItem, now)).toBeNull();
  });
});
