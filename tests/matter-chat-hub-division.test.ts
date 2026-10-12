import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { buildMatterSessionTitle } from '../src/shared/matter-chat';

const todayHookPath = path.resolve(
  process.cwd(),
  'src/renderer/components/today/useMatterToday.ts'
);
const useIpcPath = path.resolve(process.cwd(), 'src/renderer/hooks/useIPC.ts');

describe('Matter chat workspace division', () => {
  it('opens item Chat from Today as an idle Hub session (no auto-run)', () => {
    const todaySource = fs.readFileSync(todayHookPath, 'utf8');
    const ipcSource = fs.readFileSync(useIpcPath, 'utf8');

    expect(todaySource).toContain('const openItemChat');
    expect(todaySource).toContain('buildMatterSessionTitle(item.title)');
    expect(todaySource).toContain("{ division: 'hub' }");
    expect(todaySource).toContain('setMatterChatDraft(session.id');
    expect(todaySource).not.toContain("startSession('Matter'");
    expect(todaySource).not.toContain('Help me resolve this Matter item:');

    expect(ipcSource).toContain("type: 'session.create'");
    expect(ipcSource).toContain("options?.division === 'hub'");
    expect(ipcSource).toContain('setActiveDivision({ kind: options.division })');
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
