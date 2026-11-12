import { describe, expect, it } from 'vitest';
import {
  clearSteerAnchor,
  consumeSteerAnchor,
  rememberSteerAnchor,
} from '../../renderer/utils/steer-anchor';

describe('steer anchor', () => {
  it('returns the latest send-now id once', () => {
    rememberSteerAnchor('s1', 'msg-a');
    rememberSteerAnchor('s1', 'msg-b');
    expect(consumeSteerAnchor('s1')).toBe('msg-b');
    expect(consumeSteerAnchor('s1')).toBeUndefined();
  });

  it('drops a pending anchor when the session stops', () => {
    rememberSteerAnchor('s2', 'msg-c');
    clearSteerAnchor('s2');
    expect(consumeSteerAnchor('s2')).toBeUndefined();
  });
});
