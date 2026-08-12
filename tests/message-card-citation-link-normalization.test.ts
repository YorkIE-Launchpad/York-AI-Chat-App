import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Content split across MessageCard.tsx and the message/ sub-components directory
const messageCardPath = path.resolve(process.cwd(), 'src/renderer/components/MessageCard.tsx');
const messageMarkdownPath = path.resolve(
  process.cwd(),
  'src/renderer/components/MessageMarkdown.tsx'
);
const messageDir = path.resolve(process.cwd(), 'src/renderer/components/message');
const messageCardContent = [
  fs.readFileSync(messageCardPath, 'utf8'),
  ...fs.readdirSync(messageDir).map((f) => fs.readFileSync(path.join(messageDir, f), 'utf8')),
].join('\n');
const messageMarkdownContent = fs.readFileSync(messageMarkdownPath, 'utf8');

describe('MessageCard citation link normalization', () => {
  it('normalizes citation-style ~[title](url)~ to regular markdown links before render', () => {
    expect(messageCardContent).toContain('function normalizeCitationMarkdownLinks');
    expect(messageCardContent).toContain(
      "return markdown.replace(/~\\[(.+?)\\]\\(([^)\\s]+)\\)~/g, '[$1]($2)');"
    );
    expect(messageCardContent).toContain(
      'normalizeLocalFileMarkdownLinks(normalizeLatexDelimiters(text))'
    );
  });

  it('opens memory:{id} cites and demotes non-openable source hrefs', () => {
    expect(messageCardContent).toContain('parseMemoryHref');
    expect(messageCardContent).toContain('MemorySourceDetailPanel');
    expect(messageCardContent).toContain('return <span>{children}</span>');
  });

  it('disables remark-gfm single-tilde strikethrough parsing for safety', () => {
    expect(messageMarkdownContent).toContain('singleTilde: false');
    expect(messageMarkdownContent).toContain('REMARK_PLUGINS');
  });

  it('allows memory: href protocol through sanitize so citations remain clickable', () => {
    expect(messageMarkdownContent).toContain("'memory'");
    expect(messageMarkdownContent).toContain('protocols');
  });
});
