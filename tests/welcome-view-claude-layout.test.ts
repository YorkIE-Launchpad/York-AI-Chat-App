import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const welcomeViewPath = path.resolve(process.cwd(), 'src/renderer/components/WelcomeView.tsx');

describe('WelcomeView as the Today home', () => {
  it('renders the Today board inside a wide page column', () => {
    const source = fs.readFileSync(welcomeViewPath, 'utf8');
    expect(source).toContain('max-w-[1180px]');
    expect(source).toContain('<TodayBoard matter={matter} hero={hero} />');
  });

  it('uses the rounded composer with an accent focus ring', () => {
    const source = fs.readFileSync(welcomeViewPath, 'utf8');
    expect(source).toContain('rounded-[14px]');
    expect(source).toContain('focus-within:ring-accent/15');
  });

  it('includes an inline model selector on the welcome composer', () => {
    const source = fs.readFileSync(welcomeViewPath, 'utf8');
    expect(source).toContain("import { ModelSelector } from './ModelSelector';");
    expect(source).toContain('<ModelSelector />');
  });

  it('shows tools status and Today briefing instead of connector quick-action chips', () => {
    const source = fs.readFileSync(welcomeViewPath, 'utf8');
    expect(source).toContain('<ToolsHealthNote />');
    expect(source).toContain('useMatterToday');
    expect(source).not.toContain('getQuickActions');
    expect(source).not.toContain('regenerateQuickActions');
    expect(source).not.toContain('WELCOME_ICON_MAP');
  });

  it('lets the shell focus the composer (New chat / ⌘N)', () => {
    const source = fs.readFileSync(welcomeViewPath, 'utf8');
    expect(source).toContain('FOCUS_COMPOSER_EVENT');
  });

  it('shows New chats in {workspace} when a division is selected', () => {
    const source = fs.readFileSync(welcomeViewPath, 'utf8');
    expect(source).toContain("import { divisionLabel } from '../../shared/workspace-division'");
    expect(source).toContain("t('today.newChatsIn', { workspace: divisionLabel(activeDivision) })");
  });
});
