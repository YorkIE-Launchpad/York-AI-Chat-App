import { describe, expect, it } from 'vitest';
import { linkCitationMarkers, splitSources } from '../../renderer/utils/citations';

describe('splitSources', () => {
  it('splits a trailing Sources list into numbered citations', () => {
    const text = [
      'Finance approved the price [1]. Dana asked to keep the team [2].',
      '',
      'Sources:',
      '- [Pricing thread](https://mail.google.com/x)',
      '2. [ACME-12](https://york.atlassian.net/browse/ACME-12) — renewal ticket',
      '- York Hub — client Acme',
    ].join('\n');
    const { body, sources } = splitSources(text);
    expect(body).toBe('Finance approved the price [1]. Dana asked to keep the team [2].');
    expect(sources).toEqual([
      { n: 1, title: 'Pricing thread', url: 'https://mail.google.com/x' },
      { n: 2, title: 'ACME-12 — renewal ticket', url: 'https://york.atlassian.net/browse/ACME-12' },
      { n: 3, title: 'York Hub — client Acme' },
    ]);
  });

  it('accepts bold and heading variants, and ignores Sources inside code fences', () => {
    expect(splitSources('Hi\n\n**Sources:**\n- https://a.com').sources).toHaveLength(1);
    expect(splitSources('Hi\n\n## Sources\n1. [A](https://a.com)').sources).toHaveLength(1);
    expect(splitSources('```\nSources:\n- x\n```').sources).toHaveLength(0);
  });

  it('leaves text without a list untouched', () => {
    const text = 'Sources: none were used.';
    expect(splitSources(text)).toEqual({ body: text, sources: [] });
  });
});

describe('linkCitationMarkers', () => {
  it('links markers within range and skips links, code and out-of-range numbers', () => {
    const out = linkCitationMarkers(
      'A [1]. B [1, 2]. C [9]. D [x](https://e.com). `arr[1]` E [2](https://f.com)',
      2
    );
    expect(out).toBe(
      'A [1](cite:1). B [1](cite:1)[2](cite:2). C [9]. D [x](https://e.com). `arr[1]` E [2](https://f.com)'
    );
  });

  it('does nothing without sources', () => {
    expect(linkCitationMarkers('Item [1]', 0)).toBe('Item [1]');
  });
});
