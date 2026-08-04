import { describe, expect, it } from 'vitest';
import {
  assertSlackWriteAllowed,
  isSlackWriteBlockedChannel,
  normalizeSlackChannelName,
} from '../src/main/mcp/slack-write-guard';

describe('slack write guard', () => {
  it('normalizes channel names', () => {
    expect(normalizeSlackChannelName('#General')).toBe('general');
    expect(normalizeSlackChannelName('  virtual-water-cooler  ')).toBe('virtual-water-cooler');
  });

  it('blocks general and virtual-water-cooler name forms', () => {
    for (const ref of [
      'general',
      '#general',
      'General',
      ' #GENERAL ',
      'virtual-water-cooler',
      '#virtual-water-cooler',
      'Virtual-Water-Cooler',
      'virtaul-water-cooler',
    ]) {
      expect(isSlackWriteBlockedChannel(ref)).toBe(true);
      expect(() => assertSlackWriteAllowed(ref)).toThrow(/not allowed/);
    }
  });

  it('allows other channels and does not treat IDs as names', () => {
    for (const ref of ['eng-team', '#random', 'C0123ABCDEF', 'D0123ABCDEF', '', null, undefined]) {
      expect(isSlackWriteBlockedChannel(ref)).toBe(false);
      expect(() => assertSlackWriteAllowed(ref)).not.toThrow();
    }
  });

  it('blocks after resolve when name is banned even if id was used', () => {
    expect(() => assertSlackWriteAllowed('general', 'C0GENERAL')).toThrow(/#general/);
    expect(() => assertSlackWriteAllowed(null, 'C0OTHER')).not.toThrow();
  });
});
