#!/usr/bin/env node
/**
 * macOS 26+ (Tahoe): V8 often fails CodeRange reservation at ElectronMain on Apple Silicon.
 * `--js-flags=--jitless` must be passed before V8 init (main-process JS is too late).
 *
 * The CFBundleExecutable must stay a Mach-O. A bash wrapper is signed as
 * "bundle with generic" (host => com.apple.bash). After exec, Squirrel.Mac
 * uses SecCodeCopySelf on `*.real`, whose identifier defaults to the product
 * name, and rejects updates signed as ie.york.app.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/** macOS major version at which we enable jitless (Tahoe = 26+). */
const MACOS_JITLESS_MIN_MAJOR = 26;

/**
 * Codesign identifier for the packaged main executable + jitless trampoline.
 *
 * Squirrel.Mac copies SecCodeCopySelf from the running Electron stub (`*.real`)
 * and requires the downloaded .app to satisfy that designated requirement.
 * Wrapper-era 4.5.x builds re-signed *.real without --identifier, so fielded
 * processes are `York GrowthOS` (the executable name), not `ie.york.app`.
 * Keep this stable so auto-update continues to work for those installs.
 */
const MACOS_MAIN_CODE_IDENTIFIER = 'York GrowthOS';

const TRAMPOLINE_MARKER = 'YORK_JITLESS_LAUNCHER';
const TRAMPOLINE_SOURCE = path.join(__dirname, '..', 'native', 'macos-jitless-launcher', 'main.c');

/**
 * @param {string} productVersion sw_vers -productVersion
 * @returns {boolean}
 */
function shouldUseJitlessOnMacOS(productVersion) {
  const major = parseInt(String(productVersion).split('.')[0], 10);
  return Number.isFinite(major) && major >= MACOS_JITLESS_MIN_MAJOR;
}

/**
 * @param {string} filePath
 * @returns {boolean}
 */
function isShellScript(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(2);
    const n = fs.readSync(fd, buf, 0, 2, 0);
    return n >= 2 && buf[0] === 0x23 && buf[1] === 0x21;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * @param {string} filePath
 * @returns {boolean}
 */
function isJitlessTrampoline(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    return buf.includes(Buffer.from(TRAMPOLINE_MARKER));
  } catch {
    return false;
  }
}

/**
 * @param {string} binaryPath
 * @returns {string[]}
 */
function machoArchitectures(binaryPath) {
  try {
    const out = execFileSync('lipo', ['-archs', binaryPath], { encoding: 'utf8' }).trim();
    return out.split(/\s+/).filter(Boolean);
  } catch {
    return ['arm64'];
  }
}

/**
 * @param {{ outputPath: string; archs: string[] }} options
 */
function compileJitlessTrampoline({ outputPath, archs }) {
  if (!fs.existsSync(TRAMPOLINE_SOURCE)) {
    throw new Error(`jitless trampoline source missing: ${TRAMPOLINE_SOURCE}`);
  }
  const args = ['-Os', `-DMACOS_JITLESS_MIN_MAJOR=${MACOS_JITLESS_MIN_MAJOR}`];
  for (const arch of archs) {
    args.push('-arch', arch === 'x64' ? 'x86_64' : arch);
  }
  args.push('-mmacosx-version-min=12.0', '-o', outputPath, TRAMPOLINE_SOURCE);
  execFileSync('clang', args, { stdio: 'inherit' });
  fs.chmodSync(outputPath, 0o755);
}

/**
 * @param {{ appBundlePath: string; executableName: string }} options
 * @returns {{ installed: boolean; reason?: string }}
 */
function installMacOSLauncherWrapper({ appBundlePath, executableName }) {
  if (!appBundlePath || !executableName) {
    return { installed: false, reason: 'missing appBundlePath or executableName' };
  }

  const macosDir = path.join(appBundlePath, 'Contents', 'MacOS');
  const launcherPath = path.join(macosDir, executableName);
  const realPath = `${launcherPath}.real`;

  if (!fs.existsSync(launcherPath)) {
    return { installed: false, reason: `executable not found: ${launcherPath}` };
  }

  if (fs.existsSync(realPath)) {
    if (isJitlessTrampoline(launcherPath) && !isShellScript(launcherPath)) {
      return { installed: false, reason: 'wrapper already installed' };
    }
    const archs = machoArchitectures(realPath);
    compileJitlessTrampoline({ outputPath: launcherPath, archs });
    return { installed: true };
  }

  if (isShellScript(launcherPath)) {
    return { installed: false, reason: 'shell launcher present without .real binary' };
  }

  fs.renameSync(launcherPath, realPath);
  compileJitlessTrampoline({
    outputPath: launcherPath,
    archs: machoArchitectures(realPath),
  });
  return { installed: true };
}

module.exports = {
  MACOS_JITLESS_MIN_MAJOR,
  MACOS_MAIN_CODE_IDENTIFIER,
  TRAMPOLINE_MARKER,
  shouldUseJitlessOnMacOS,
  installMacOSLauncherWrapper,
  isShellScript,
  isJitlessTrampoline,
};
