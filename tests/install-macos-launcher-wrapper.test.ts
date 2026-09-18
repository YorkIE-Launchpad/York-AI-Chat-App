import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MACOS_JITLESS_MIN_MAJOR,
  MACOS_MAIN_CODE_IDENTIFIER,
  TRAMPOLINE_MARKER,
  installMacOSLauncherWrapper,
  shouldUseJitlessOnMacOS,
} from '../scripts/install-macos-launcher-wrapper.js';

describe('shouldUseJitlessOnMacOS', () => {
  it(`enables jitless on macOS ${MACOS_JITLESS_MIN_MAJOR}+`, () => {
    expect(shouldUseJitlessOnMacOS('26.0')).toBe(true);
    expect(shouldUseJitlessOnMacOS('27.0')).toBe(true);
  });

  it('does not enable jitless on older macOS', () => {
    expect(shouldUseJitlessOnMacOS('15.6')).toBe(false);
  });
});

describe('MACOS_MAIN_CODE_IDENTIFIER', () => {
  it('matches the fielded Electron stub identifier Squirrel.Mac checks', () => {
    expect(MACOS_MAIN_CODE_IDENTIFIER).toBe('York GrowthOS');
  });
});

describe('installMacOSLauncherWrapper', () => {
  it('replaces the main executable with a Mach-O trampoline', () => {
    if (process.platform !== 'darwin') return;

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'york-jitless-'));
    const app = path.join(tmp, 'Fake.app');
    const macos = path.join(app, 'Contents', 'MacOS');
    fs.mkdirSync(macos, { recursive: true });
    const exe = path.join(macos, 'Fake');
    execFileSync('clang', ['-x', 'c', '-o', exe, '-'], {
      input: 'int main(void) { return 0; }\n',
    });
    fs.chmodSync(exe, 0o755);

    const result = installMacOSLauncherWrapper({
      appBundlePath: app,
      executableName: 'Fake',
    });
    expect(result.installed).toBe(true);
    expect(fs.existsSync(`${exe}.real`)).toBe(true);
    const launcher = fs.readFileSync(exe);
    expect(launcher.includes(Buffer.from(TRAMPOLINE_MARKER))).toBe(true);
    expect(launcher.subarray(0, 2).toString('ascii')).not.toBe('#!');

    const again = installMacOSLauncherWrapper({
      appBundlePath: app,
      executableName: 'Fake',
    });
    expect(again.installed).toBe(false);
    expect(again.reason).toBe('wrapper already installed');

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('replaces a leftover bash wrapper when .real already exists', () => {
    if (process.platform !== 'darwin') return;

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'york-jitless-bash-'));
    const app = path.join(tmp, 'Fake.app');
    const macos = path.join(app, 'Contents', 'MacOS');
    fs.mkdirSync(macos, { recursive: true });
    const exe = path.join(macos, 'Fake');
    execFileSync('clang', ['-x', 'c', '-o', `${exe}.real`, '-'], {
      input: 'int main(void) { return 0; }\n',
    });
    fs.writeFileSync(exe, '#!/bin/bash\nexec "$0.real" --js-flags="--jitless" "$@"\n', {
      mode: 0o755,
    });

    const result = installMacOSLauncherWrapper({
      appBundlePath: app,
      executableName: 'Fake',
    });
    expect(result.installed).toBe(true);
    expect(fs.readFileSync(exe).includes(Buffer.from(TRAMPOLINE_MARKER))).toBe(true);

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
