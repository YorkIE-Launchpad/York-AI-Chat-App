import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { buildMatterSessionTitle } from '../src/shared/matter-chat';

const matterPagePath = path.resolve(process.cwd(), 'src/renderer/components/matter/MatterPage.tsx');
const useIpcPath = path.resolve(process.cwd(), 'src/renderer/hooks/useIPC.ts');

describe('Matter chat workspace division', () => {
  it('opens signal Chat as an idle Hub session (no auto-run)', () => {
    const matterSource = fs.readFileSync(matterPagePath, 'utf8');
    const ipcSource = fs.readFileSync(useIpcPath, 'utf8');

    expect(matterSource).toContain('createSession(title, workingDir || undefined, { division: \'hub\' })');
    expect(matterSource).toContain('setMatterChatDraft(session.id');
    expect(matterSource).toContain('openSignalChat');
    expect(matterSource).not.toContain(
      "startSession('Matter', built.prompt, workingDir || undefined, { division: 'hub' })"
    );
    expect(matterSource).not.toContain('Help me resolve this Matter item:');

    expect(ipcSource).toContain("type: 'session.create'");
    expect(ipcSource).toContain("options?.division === 'hub'");
    expect(ipcSource).toContain('setActiveDivision({ kind: options.division })');
  });

  it('keeps Ask bar as startSession in Hub with contextual title', () => {
    const matterSource = fs.readFileSync(matterPagePath, 'utf8');
    expect(matterSource).toContain('handleAsk');
    expect(matterSource).toContain(
      'await startSession(title, built.prompt, workingDir || undefined, { division: \'hub\' })'
    );
    expect(matterSource).toContain('buildMatterSessionTitle');
  });
});

describe('buildMatterSessionTitle', () => {
  it('prefixes Matter and truncates long titles', () => {
    expect(buildMatterSessionTitle('Reply to Acme')).toBe('Matter · Reply to Acme');
    expect(buildMatterSessionTitle(null)).toBe('Matter');
    const long = buildMatterSessionTitle('A'.repeat(80));
    expect(long.startsWith('Matter · ')).toBe(true);
    expect(long.length).toBeLessThanOrEqual(50);
  });
});
