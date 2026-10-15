import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { chunkMrkdwn, markdownToMrkdwn } from './mrkdwn.js';

describe('markdownToMrkdwn', () => {
  it('converts headings, emphasis, strikethrough and lists', () => {
    const input = [
      '## Summary',
      'This is **important** and *subtle* and ~~gone~~.',
      '- first',
      '  - nested',
      '* [x] done',
      '1. one',
      '---',
    ].join('\n');
    assert.equal(
      markdownToMrkdwn(input),
      [
        '*Summary*',
        'This is *important* and _subtle_ and ~gone~.',
        '• first',
        '    ◦ nested',
        '• ☑ done',
        '1. one',
        '──────────',
      ].join('\n')
    );
  });

  it('turns http(s) links into Slack links and leaves other schemes as text', () => {
    assert.equal(
      markdownToMrkdwn('See [the docs](https://example.com/a?b=1&c=2) or <https://x.io>.'),
      'See <https://example.com/a?b=1&amp;c=2|the docs> or <https://x.io>.'
    );
    assert.equal(markdownToMrkdwn('[click](javascript:alert(1))'), '[click](javascript:alert(1))');
  });

  it('never lets desktop text produce mentions or broadcasts', () => {
    const out = markdownToMrkdwn('Hey <!channel> and <@U123> [x](https://a.io|<!here>)');
    assert.ok(!out.includes('<!channel>'));
    assert.ok(!out.includes('<@U123>'));
    assert.ok(!out.includes('<!here>'));
  });

  it('keeps code verbatim (escaped) and drops the fence language', () => {
    const out = markdownToMrkdwn('Run `a **b**`:\n```ts\nif (a < b && **c**) {}\n```');
    assert.equal(out, 'Run `a **b**`:\n```\nif (a &lt; b &amp;&amp; **c**) {}\n```');
  });

  it('keeps quotes as Slack quotes', () => {
    assert.equal(markdownToMrkdwn('> **Note** a > b'), '> *Note* a &gt; b');
  });

  it('renders tables as an aligned code block', () => {
    const out = markdownToMrkdwn('| Name | Qty |\n|---|---:|\n| **Apples** | 3 |\n| Kiwi | 12 |');
    assert.equal(
      out,
      ['```', 'Name    Qty', '──────  ───', 'Apples  3', 'Kiwi    12', '```'].join('\n')
    );
  });

  it('closes an unterminated code fence', () => {
    assert.equal(markdownToMrkdwn('```\nopen'), '```\nopen\n```');
  });
});

describe('chunkMrkdwn', () => {
  it('keeps code blocks balanced across chunks', () => {
    const body = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
    const chunks = chunkMrkdwn(`intro\n\`\`\`\n${body}\n\`\`\``, 500);
    assert.ok(chunks.length > 1);
    for (const chunk of chunks) {
      assert.ok(chunk.length <= 500);
      assert.equal((chunk.match(/^```/gm)?.length ?? 0) % 2, 0, chunk);
    }
  });
});
