#!/usr/bin/env node
/**
 * Rebuild better-sqlite3 for the pinned Electron version.
 *
 * better-sqlite3 v13 ships Node prebuilds and skips node-gyp unless force_build=1.
 * Electron must load a binary compiled for its ABI — not the bundled Node prebuild.
 */
'use strict';

const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const BSQL = path.join(ROOT, 'node_modules', 'better-sqlite3');
const electronVersion = require(path.join(ROOT, 'node_modules/electron/package.json')).version;
const builtNode = path.join(BSQL, 'build', 'Release', 'better_sqlite3.node');

if (!fs.existsSync(BSQL)) {
  console.error('[rebuild] better-sqlite3 is not installed');
  process.exit(1);
}

console.log(`[rebuild] better-sqlite3 for Electron ${electronVersion} (${process.platform}-${process.arch})`);

execSync(
  `npx node-gyp rebuild --release --runtime=electron --target=${electronVersion} --disturl=https://electronjs.org/headers -- -Dforce_build=1`,
  { cwd: BSQL, stdio: 'inherit' }
);

if (!fs.existsSync(builtNode)) {
  console.error(`[rebuild] Expected native module at ${builtNode}`);
  process.exit(1);
}

// v13 resolves prebuilds/*.node before build/Release — remove Node prebuilds so Electron
// loads the Electron-compiled addon (and shrink packaged asar slightly).
const prebuildsDir = path.join(BSQL, 'prebuilds');
if (fs.existsSync(prebuildsDir)) {
  for (const name of fs.readdirSync(prebuildsDir)) {
    if (!name.endsWith('.node')) continue;
    fs.unlinkSync(path.join(prebuildsDir, name));
  }
  console.log('[rebuild] removed Node prebuilds (Electron uses build/Release/better_sqlite3.node)');
}

console.log('[rebuild] ok');
