import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const welcomeViewPath = path.resolve(process.cwd(), 'src/renderer/components/WelcomeView.tsx');

describe('WelcomeView Claude-style layout', () => {
  it('uses a narrower editorial landing column with York GrowthOS branding', () => {
    const source = fs.readFileSync(welcomeViewPath, 'utf8');
    expect(source).toContain('max-w-[840px]');
    expect(source).toContain('York GrowthOS');
  });

  it('uses a softer rounded composer shell instead of the previous generic card class', () => {
    const source = fs.readFileSync(welcomeViewPath, 'utf8');
    expect(source).toContain('rounded-[1.9rem]');
    expect(source).toContain('shadow-soft');
  });

  it('includes an inline model selector on the welcome composer', () => {
    const source = fs.readFileSync(welcomeViewPath, 'utf8');
    expect(source).toContain("import { ModelSelector } from './ModelSelector';");
    expect(source).toContain('<ModelSelector />');
  });

  it('shows Matter briefings instead of connector quick-action chips', () => {
    const source = fs.readFileSync(welcomeViewPath, 'utf8');
    expect(source).toContain('WelcomeMatterBriefing');
    expect(source).not.toContain('getQuickActions');
    expect(source).not.toContain('regenerateQuickActions');
    expect(source).not.toContain('WELCOME_ICON_MAP');
  });

  it('pins the welcome composer to the bottom of the viewport', () => {
    const source = fs.readFileSync(welcomeViewPath, 'utf8');
    expect(source).toContain('mt-auto shrink-0 pt-7');
    expect(source).not.toContain('my-auto space-y-7');
  });
});
