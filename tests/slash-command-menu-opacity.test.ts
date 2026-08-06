import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const menuPath = path.resolve(process.cwd(), 'src/renderer/components/SlashCommandMenu.tsx');

describe('SlashCommandMenu opacity', () => {
  it('portals with a fully solid surface background (no translucent blur composite)', () => {
    const source = fs.readFileSync(menuPath, 'utf8');
    expect(source).toContain('createPortal');
    expect(source).toContain("backgroundColor: 'var(--color-surface)'");
    expect(source).toContain('opacity: 1');
    expect(source).toContain("backdropFilter: 'none'");
    expect(source).not.toMatch(/className="[^"]*bg-background\/\d+/);
    expect(source).not.toContain('backdrop-blur');
  });
});
