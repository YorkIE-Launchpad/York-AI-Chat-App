import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

function readChatView() {
  const filePath = path.resolve(__dirname, '../src/renderer/components/ChatView.tsx');
  const chatDir = path.resolve(__dirname, '../src/renderer/components/chat');
  return [
    fs.readFileSync(filePath, 'utf8'),
    ...fs.readdirSync(chatDir).map((f) => fs.readFileSync(path.join(chatDir, f), 'utf8')),
  ].join('\n');
}

describe('chat view width layout', () => {
  it('uses a centered responsive messages container', () => {
    const source = readChatView();
    expect(source).toContain('max-w-[820px]');
    expect(source).toContain('lg:px-8');
  });

  it('observes message container via ref instead of hard-coded class selector', () => {
    const source = readChatView();
    expect(source).toContain('messagesContainerRef');
    expect(source).not.toContain("querySelector('.max-w-3xl')");
  });
});
