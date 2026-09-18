#!/usr/bin/env node
'use strict';

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { MACOS_MAIN_CODE_IDENTIFIER } = require('./install-macos-launcher-wrapper');

function codesignDump(target) {
  const result = spawnSync('codesign', ['-dv', '--verbose=4', target], { encoding: 'utf8' });
  return `${result.stdout || ''}${result.stderr || ''}`;
}

function dumpField(dump, key) {
  const match = dump.match(new RegExp(`^${key}=(.*)$`, 'm'));
  return match ? match[1].trim() : '';
}

/**
 * Fail fast if a .app is not valid for Squirrel / electron-updater on macOS.
 * @param {string} appPath
 * @param {{ label?: string; assessGatekeeper?: boolean }} [opts]
 */
function verifyMacAppSignatureStrict(appPath, opts = {}) {
  const label = opts.label ? `${opts.label}: ` : '';
  const errors = [];

  try {
    execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath], {
      stdio: 'pipe',
      encoding: 'utf8',
    });
  } catch (error) {
    const detail =
      (error && typeof error === 'object' && 'stderr' in error && error.stderr) ||
      (error instanceof Error ? error.message : String(error));
    errors.push(`codesign --strict: ${detail}`);
  }

  const dump = codesignDump(appPath);
  const appIdentifier = dumpField(dump, 'Identifier');
  const format = dumpField(dump, 'Format');
  const team = dumpField(dump, 'TeamIdentifier');

  if (format.includes('generic')) {
    errors.push(
      `main executable is not Mach-O (Format=${format || 'unknown'}). ` +
        'A bash CFBundleExecutable breaks Squirrel.Mac auto-update.'
    );
  }

  if (appIdentifier && appIdentifier !== MACOS_MAIN_CODE_IDENTIFIER) {
    errors.push(
      `app codesign identifier is "${appIdentifier}", expected "${MACOS_MAIN_CODE_IDENTIFIER}" ` +
        '(must match the running Electron stub for Squirrel.Mac).'
    );
  }

  const macosDir = path.join(appPath, 'Contents', 'MacOS');
  if (fs.existsSync(macosDir)) {
    for (const name of fs.readdirSync(macosDir)) {
      if (!name.endsWith('.real')) continue;
      const realBin = path.join(macosDir, name);
      try {
        execFileSync('codesign', ['--verify', '--verbose=2', realBin], {
          stdio: 'pipe',
          encoding: 'utf8',
        });
      } catch (error) {
        const detail =
          (error && typeof error === 'object' && 'stderr' in error && error.stderr) ||
          (error instanceof Error ? error.message : String(error));
        errors.push(`unsigned or invalid jitless binary ${name}: ${detail}`);
      }
      const realDump = codesignDump(realBin);
      const realIdentifier = dumpField(realDump, 'Identifier');
      if (realIdentifier && realIdentifier !== MACOS_MAIN_CODE_IDENTIFIER) {
        errors.push(
          `${name} codesign identifier is "${realIdentifier}", expected "${MACOS_MAIN_CODE_IDENTIFIER}".`
        );
      }
    }
  }

  if (team) {
    const squirrelReq =
      `identifier "${MACOS_MAIN_CODE_IDENTIFIER}" and anchor apple generic and ` +
      `certificate leaf[subject.OU] = "${team}"`;
    try {
      execFileSync('codesign', ['--verify', '--verbose=2', '-R', `=${squirrelReq}`, appPath], {
        stdio: 'pipe',
        encoding: 'utf8',
      });
    } catch (error) {
      const detail =
        (error && typeof error === 'object' && 'stderr' in error && error.stderr) ||
        (error instanceof Error ? error.message : String(error));
      errors.push(`Squirrel.Mac requirement check failed (${squirrelReq}): ${detail}`);
    }
  }

  if (opts.assessGatekeeper) {
    try {
      execFileSync('spctl', ['-a', '-vv', '-t', 'execute', appPath], {
        stdio: 'pipe',
        encoding: 'utf8',
      });
    } catch (error) {
      const detail =
        (error && typeof error === 'object' && 'stderr' in error && error.stderr) ||
        (error instanceof Error ? error.message : String(error));
      errors.push(`spctl assess: ${detail}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `${label}Code signature verification failed (auto-update will reject this build).\n${errors.join('\n')}`
    );
  }
}

module.exports = {
  verifyMacAppSignatureStrict,
};
