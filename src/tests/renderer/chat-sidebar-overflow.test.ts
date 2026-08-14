/**
 * Regression: long/right-aligned chat bubbles were painting under the left sidebar.
 *
 * Root cause: `.message-user { width: fit-content; margin-left: auto }` plus a
 * flex `items-end` parent lets an unconstrained max-content width overflow to
 * the left. Guards live in source as Tailwind/CSS class contracts.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

function readSrc(relativePath: string): string {
  return readFileSync(join(root, relativePath), 'utf8');
}

describe('chat column does not overflow under the sidebar', () => {
  it('caps user bubbles at 90% and does not use margin-left: auto', () => {
    const css = readSrc('renderer/styles/globals.css');
    const userRule = css.slice(css.indexOf('.message-user {'), css.indexOf('.prose-chat'));
    expect(userRule).toContain('max-width: 90%');
    expect(userRule).not.toMatch(/max-width:\s*100%/);
    expect(userRule).not.toMatch(/margin-left:\s*auto/);
  });

  it('keeps the sidebar in flex flow so chat cannot slide under it', () => {
    const sidebar = readSrc('renderer/components/Sidebar.tsx');
    expect(sidebar).toContain('shrink-0');
    expect(sidebar).toContain('relative z-20');
  });

  it('clips the message scroller and constrains bubble width', () => {
    const chatView = readSrc('renderer/components/ChatView.tsx');
    expect(chatView).toContain('overflow-x-hidden');
    expect(chatView).toContain('min-w-0');

    const messageCard = readSrc('renderer/components/MessageCard.tsx');
    expect(messageCard).toContain('min-w-0 max-w-full');
    expect(messageCard).toContain('w-fit max-w-[90%]');
  });
});
