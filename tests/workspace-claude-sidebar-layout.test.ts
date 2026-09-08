import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const sidebarPath = path.resolve(process.cwd(), 'src/renderer/components/Sidebar.tsx');
const switcherPath = path.resolve(process.cwd(), 'src/renderer/components/DivisionSwitcher.tsx');

describe('Claude-style workspace sidebar framing', () => {
  it('uses a header-variant workspace switcher as the chat-tree title', () => {
    const sidebar = fs.readFileSync(sidebarPath, 'utf8');
    expect(sidebar).toContain('variant="header"');
    expect(sidebar).not.toContain('Choose Workspace');
    expect(sidebar).not.toContain('groupSessionsByDate');
    expect(sidebar).not.toContain("t('sidebar.today')");
    expect(sidebar).toContain('sortSessionsLatestFirst');
    expect(sidebar).toContain('border-l border-border-muted');
  });

  it('shows collapsible personal folders when Folders workspace is active', () => {
    const sidebar = fs.readFileSync(sidebarPath, 'utf8');
    expect(sidebar).toContain('isFoldersWorkspace');
    expect(sidebar).toContain('displayFolders');
    expect(sidebar).toContain('toggleFolderCollapsed');
    expect(sidebar).toContain('selectPersonalFolder');
    expect(sidebar).toContain('sessionsByFolderId');
    expect(sidebar).toContain('createPersonalFolder');
    expect(sidebar).toContain('New folder name');
  });
  it('keeps a workspace kind icon on the collapsed rail', () => {
    const sidebar = fs.readFileSync(sidebarPath, 'utf8');
    expect(sidebar).toContain('workspaceKindIcon');
    expect(sidebar).toContain('Workspace: ${workspaceName}');
  });

  it('DivisionSwitcher header variant shows identity vs select-workspace empty state', () => {
    const switcher = fs.readFileSync(switcherPath, 'utf8');
    expect(switcher).toContain("variant?: 'default' | 'header'");
    expect(switcher).toContain('Select workspace');
    expect(switcher).toContain('divisionKindSubtitle');
    expect(switcher).toContain('isHeader');
    expect(switcher).toContain('enterFoldersWorkspace');
    expect(switcher).not.toContain('FolderPlus');
    expect(switcher).not.toContain('New folder name');
  });
});
