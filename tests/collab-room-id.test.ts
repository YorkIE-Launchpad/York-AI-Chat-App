import { describe, expect, it } from 'vitest';
import {
  createCollabRoomId,
  isCollabRoomId,
  parseCollabRoomId,
} from '../src/shared/collab/room-id';

describe('collab room-id', () => {
  it('creates compact shareable ids', () => {
    const id = createCollabRoomId();
    expect(isCollabRoomId(id)).toBe(true);
    expect(id.length).toBeGreaterThanOrEqual(8);
    expect(id.includes('.')).toBe(false);
  });

  it('parses plain ids and prefixes', () => {
    expect(parseCollabRoomId('  abcDEF12_xy  ')).toBe('abcDEF12_xy');
    expect(parseCollabRoomId('york-collab:abcDEF12_xy')).toBe('abcDEF12_xy');
  });

  it('rejects empty and jwt-looking garbage without roomId', () => {
    expect(parseCollabRoomId('')).toBeNull();
    expect(parseCollabRoomId('not a token!!!')).toBeNull();
  });
});
