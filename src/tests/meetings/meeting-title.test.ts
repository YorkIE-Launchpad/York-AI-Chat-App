import { describe, expect, it } from 'vitest';
import { resolveMeetingDisplayTitle } from '../../main/meetings/meeting-service';

describe('resolveMeetingDisplayTitle', () => {
  it('prefers Zoom topic over calendar title', () => {
    expect(resolveMeetingDisplayTitle('Zoom Live Topic', 'Calendar Event')).toBe('Zoom Live Topic');
  });

  it('falls back to calendar title', () => {
    expect(resolveMeetingDisplayTitle(null, 'AI Roadmap Sync')).toBe('AI Roadmap Sync');
  });

  it('uses Zoom Meeting when both are empty', () => {
    expect(resolveMeetingDisplayTitle('', '')).toBe('Zoom Meeting');
    expect(resolveMeetingDisplayTitle(null, undefined)).toBe('Zoom Meeting');
  });
});
