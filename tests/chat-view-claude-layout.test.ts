import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const chatViewPath = path.resolve(process.cwd(), 'src/renderer/components/ChatView.tsx');
const chatDir = path.resolve(process.cwd(), 'src/renderer/components/chat');

function readChatView() {
  return [
    fs.readFileSync(chatViewPath, 'utf8'),
    ...fs.readdirSync(chatDir).map((f) => fs.readFileSync(path.join(chatDir, f), 'utf8')),
  ].join('\n');
}

describe('ChatView Claude-style layout', () => {
  it('uses a narrower conversation column shared by messages and composer', () => {
    const source = readChatView();
    expect(source).toContain('max-w-[820px]');
  });

  it('uses a quieter header with workspace eyebrow and compact connector badge', () => {
    const source = readChatView();
    expect(source).toContain("import { divisionLabel } from '../../shared/workspace-division'");
    expect(source).toContain('divisionLabel(activeDivision)');
    expect(source).toContain('York GrowthOS');
    expect(source).toContain('bg-background/88');
    expect(source).toContain('border-border-muted');
  });

  it('uses the shared composer card with an accent focus ring and round send button', () => {
    const source = readChatView();
    expect(source).toContain('rounded-[14px] border border-border bg-surface');
    expect(source).toContain('focus-within:ring-accent/15');
    expect(source).toContain('<ArrowUp');
    expect(source).toContain('shadow-soft');
  });
  it('auto-adjusts follow-up composer height with typed content', () => {
    const source = readChatView();
    expect(source).toContain('adjustTextareaHeight');
    expect(source).toContain('maxHeight = 200');
  });
});
