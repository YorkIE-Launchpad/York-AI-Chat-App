import { describe, expect, it } from 'vitest';
import { compactTranscript } from '../src/main/memory/memory-utils';

describe('compactTranscript', () => {
  it('labels turns with 1-based indices', () => {
    const text = compactTranscript([
      { role: 'user', content: ' hello ' },
      { role: 'assistant', content: 'hi' },
    ]);
    expect(text).toBe('[1] user: hello\n[2] assistant: hi');
  });

  it('truncates oversized turns', () => {
    const text = compactTranscript([{ role: 'user', content: 'x'.repeat(5_000) }], {
      maxTurnChars: 500,
    });
    expect(text.length).toBeLessThan(600);
    expect(text).toContain('chars omitted');
  });

  it('drops middle turns to fit the total budget while keeping original labels', () => {
    const turns = Array.from({ length: 200 }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user',
      content: `message ${i + 1} ${'y'.repeat(200)}`,
    }));
    const text = compactTranscript(turns, { maxTotalChars: 5_000 });
    expect(text.length).toBeLessThanOrEqual(5_200);
    expect(text.startsWith('[1] user: message 1 ')).toBe(true);
    expect(text).toContain('[200] assistant: message 200 ');
    expect(text).toMatch(/\[\.\.\. turns \d+-\d+ omitted \(\d+ turns\) \.\.\.\]/);
  });
});
