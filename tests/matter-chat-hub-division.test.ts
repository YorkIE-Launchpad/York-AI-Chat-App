import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const matterPagePath = path.resolve(process.cwd(), 'src/renderer/components/matter/MatterPage.tsx');
const useIpcPath = path.resolve(process.cwd(), 'src/renderer/hooks/useIPC.ts');

describe('Matter chat workspace division', () => {
  it('opens Matter action chats in the Hub workspace', () => {
    const matterSource = fs.readFileSync(matterPagePath, 'utf8');
    const ipcSource = fs.readFileSync(useIpcPath, 'utf8');

    expect(matterSource).toContain(
      "startSession('Matter', built.prompt, workingDir || undefined, { division: 'hub' })"
    );
    expect(ipcSource).toContain("options?.division === 'hub'");
    expect(ipcSource).toContain('setActiveDivision({ kind: options.division })');
  });
});
