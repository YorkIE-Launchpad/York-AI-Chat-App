import { describe, expect, it } from 'vitest';
import { parseMemoryHref } from '../src/renderer/utils/memory-cite-link';
import { memoryCiteHref } from '../src/main/memory/memory-tools';
import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('memory citation hrefs', () => {
  it('builds memory:{id} cite hrefs for tool results', () => {
    expect(memoryCiteHref('session:abc')).toBe('memory:session:abc');
  });

  it('parses memory: and memory:// citation hrefs', () => {
    expect(parseMemoryHref('memory:session:abc')).toBe('session:abc');
    expect(parseMemoryHref('memory://chunk-1')).toBe('chunk-1');
    expect(parseMemoryHref('MEMORY:core/prefs')).toBe('core/prefs');
    expect(parseMemoryHref('https://example.com')).toBeNull();
    expect(parseMemoryHref('#fragment')).toBeNull();
    expect(parseMemoryHref(undefined)).toBeNull();
    expect(parseMemoryHref('memory:')).toBeNull();
  });
});

describe('memory citation wiring', () => {
  const agentRunnerContent = readFileSync(
    path.resolve(process.cwd(), 'src/main/agent/agent-runner.ts'),
    'utf8'
  );
  const memoryToolsContent = readFileSync(
    path.resolve(process.cwd(), 'src/main/memory/memory-tools.ts'),
    'utf8'
  );
  const contentBlockView = readFileSync(
    path.resolve(process.cwd(), 'src/renderer/components/message/ContentBlockView.tsx'),
    'utf8'
  );

  it('teaches the model to cite memory hits with memory:{id}', () => {
    expect(agentRunnerContent).toContain('[Title](memory:{id})');
    expect(agentRunnerContent).toContain('Never invent http URLs for memory');
  });

  it('includes cite: memory:{id} in memory tool formatting', () => {
    expect(memoryToolsContent).toContain('cite: ${memoryCiteHref(result.id)}');
    expect(memoryToolsContent).toContain('export function memoryCiteHref');
  });

  it('opens memory cites in chat and demotes non-openable hrefs', () => {
    expect(contentBlockView).toContain('parseMemoryHref');
    expect(contentBlockView).toContain('MemorySourceDetailPanel');
    expect(contentBlockView).toContain('setMemorySourceId(memoryId)');
    expect(contentBlockView).toContain('return <span>{children}</span>');
    expect(contentBlockView).toContain('/^(?:https?:|mailto:)/i');
    expect(contentBlockView).not.toContain('/^(?:https?:|mailto:|#)/i');
  });

  it('allows memory protocol in markdown sanitize schema', () => {
    const messageMarkdown = readFileSync(
      path.resolve(process.cwd(), 'src/renderer/components/MessageMarkdown.tsx'),
      'utf8'
    );
    expect(messageMarkdown).toContain("'memory'");
    expect(messageMarkdown).toContain('href: [...(defaultSchema.protocols?.href || []), \'memory\']');
  });
});
