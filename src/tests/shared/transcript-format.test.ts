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

  it('rebuilds labeled text when speakers are patched on existing segments', () => {
    const segments: Array<{ text: string; speaker: string | null }> = [
      { text: 'hello', speaker: null },
      { text: 'world', speaker: null },
    ];
    expect(buildTranscriptText(segments)).toBe('hello\nworld');
    segments[0].speaker = 'Grace';
    segments[1].speaker = 'Grace';
    expect(buildTranscriptText(segments)).toBe('Grace: hello\nGrace: world');
  });
});
