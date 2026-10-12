import { describe, expect, it } from 'vitest';
import {
  pushLocation,
  sameLocation,
  type NavLocation,
} from '../../renderer/hooks/useNavigationHistory';

describe('navigation history', () => {
  it('pushes new locations, skips repeats, and drops forward entries', () => {
    let h: { entries: NavLocation[]; index: number } = { entries: [{ page: 'today' }], index: 0 };
    h = pushLocation(h, { page: 'chat', sessionId: 'a' });
    h = pushLocation(h, { page: 'chat', sessionId: 'a' });
    h = pushLocation(h, { page: 'followUps' });
    expect(h.entries).toHaveLength(3);
    h = { ...h, index: 1 };
    h = pushLocation(h, { page: 'settings' });
    expect(h.entries.map((e) => e.page)).toEqual(['today', 'chat', 'settings']);
    expect(h.index).toBe(2);
  });

  it('treats different chats as different locations', () => {
    expect(sameLocation({ page: 'chat', sessionId: 'a' }, { page: 'chat', sessionId: 'b' })).toBe(
      false
    );
  });
});
