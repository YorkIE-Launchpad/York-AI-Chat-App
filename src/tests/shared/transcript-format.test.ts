import { describe, expect, it } from 'vitest';
import { buildTranscriptText, formatSegmentLine } from '../../shared/meetings/transcript-format';

describe('transcript-format', () => {
  it('formats labeled and unlabeled lines', () => {
    expect(formatSegmentLine({ text: 'hi', speaker: 'Ada' })).toBe('Ada: hi');
    expect(formatSegmentLine({ text: 'hi', speaker: null })).toBe('hi');
    expect(formatSegmentLine({ text: '  ', speaker: 'Ada' })).toBe('');
  });

  it('joins segments', () => {
    expect(
      buildTranscriptText([
        { text: 'one', speaker: 'A' },
        { text: 'two', speaker: 'B' },
      ])
    ).toBe('A: one\nB: two');
  });
});
