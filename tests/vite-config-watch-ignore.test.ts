import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const viteConfigPath = path.resolve(process.cwd(), 'vite.config.ts');
const viteConfigContent = readFileSync(viteConfigPath, 'utf8');

describe('vite watch ignores build artifacts', () => {
  it('ignores packaged and build output directories to avoid reload spam', () => {
    expect(viteConfigContent).toContain('const ignoredWatchPaths = [');
    expect(viteConfigContent).toContain("'**/release/**'");
    expect(viteConfigContent).toContain("'**/dist/**'");
    expect(viteConfigContent).toContain("'**/dist-electron/**'");
    expect(viteConfigContent).toContain('ignored: ignoredWatchPaths');
  });

  it('empties electron outDirs so hashed chunks do not accumulate', () => {
    expect(viteConfigContent).toContain("outDir: 'dist-electron/main'");
    expect(viteConfigContent).toContain("outDir: 'dist-electron/preload'");
    // Both electron builds must empty their outDir (renderer already does).
    const emptyOutDirCount = (viteConfigContent.match(/emptyOutDir:\s*true/g) || []).length;
    expect(emptyOutDirCount).toBeGreaterThanOrEqual(3);
  });
});
