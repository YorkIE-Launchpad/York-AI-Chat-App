#!/usr/bin/env node
/**
 * Patch the local Electron macOS host so Dock / Cmd-Tab / menu bar show
 * "York IE VECOS" during `npm run dev`.
 *
 * Info.plist CFBundle* alone is not enough: macOS often keeps the display
 * name from the filesystem name `Electron.app`. This script renames the
 * bundle, updates electron's path.txt, replaces the icon, re-signs ad-hoc
 * (required for Electron 41+ OS notifications), and re-registers the app
 * with Launch Services.
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const PRODUCT_NAME = 'York IE VECOS';
const BUNDLE_ID = 'ie.york.vecos.dev';
const BUNDLE_NAME = `${PRODUCT_NAME}.app`;
const ROOT = path.resolve(__dirname, '..');
const ELECTRON_DIR = path.join(ROOT, 'node_modules', 'electron');
const DIST_DIR = path.join(ELECTRON_DIR, 'dist');
const PATH_TXT = path.join(ELECTRON_DIR, 'path.txt');
const ICON_SRC = path.join(ROOT, 'resources', 'icon.icns');
const STOCK_APP = path.join(DIST_DIR, 'Electron.app');
const BRANDED_APP = path.join(DIST_DIR, BUNDLE_NAME);

if (process.platform !== 'darwin') {
  process.exit(0);
}

if (!fs.existsSync(DIST_DIR)) {
  console.warn('[brand:electron] electron dist not found — skip');
  process.exit(0);
}

function plutilReplace(plist, key, value) {
  execFileSync('plutil', ['-replace', key, '-string', value, plist], { stdio: 'inherit' });
}

/** Prefer branded bundle; rename stock Electron.app when needed. */
function resolveAppBundle() {
  if (fs.existsSync(BRANDED_APP)) {
    // Fresh electron install may recreate Electron.app alongside a leftover branded copy
    if (fs.existsSync(STOCK_APP)) {
      fs.rmSync(BRANDED_APP, { recursive: true, force: true });
      fs.renameSync(STOCK_APP, BRANDED_APP);
    }
    return BRANDED_APP;
  }
  if (fs.existsSync(STOCK_APP)) {
    fs.renameSync(STOCK_APP, BRANDED_APP);
    return BRANDED_APP;
  }
  return null;
}

const appBundle = resolveAppBundle();
if (!appBundle) {
  console.warn('[brand:electron] no Electron.app / branded app found — skip');
  process.exit(0);
}

const infoPlist = path.join(appBundle, 'Contents', 'Info.plist');
const iconDst = path.join(appBundle, 'Contents', 'Resources', 'electron.icns');

if (fs.existsSync(ICON_SRC)) {
  fs.copyFileSync(ICON_SRC, iconDst);
}

plutilReplace(infoPlist, 'CFBundleDisplayName', PRODUCT_NAME);
plutilReplace(infoPlist, 'CFBundleName', PRODUCT_NAME);
// Distinct id so Launch Services does not keep serving cached "Electron" metadata
plutilReplace(infoPlist, 'CFBundleIdentifier', BUNDLE_ID);

const MEETING_USAGE = {
  NSMicrophoneUsageDescription:
    'York IE VECOS needs microphone access to capture your voice during meetings.',
  NSAudioCaptureUsageDescription:
    'York IE VECOS needs system audio access to capture meeting audio from Zoom, Meet, and other apps.',
  NSScreenCaptureUsageDescription:
    'York IE VECOS needs screen and system audio recording for meeting capture and GUI automation.',
};
for (const [key, value] of Object.entries(MEETING_USAGE)) {
  plutilReplace(infoPlist, key, value);
}

fs.writeFileSync(PATH_TXT, `${BUNDLE_NAME}/Contents/MacOS/Electron`, 'utf8');

// Electron 41+ uses UNNotification, which requires a valid code signature.
// Patching Info.plist / icon invalidates the stock signature — re-sign ad-hoc.
function resignBrandedApp(bundlePath) {
  try {
    execFileSync(
      'codesign',
      ['--force', '--deep', '--sign', '-', '--identifier', BUNDLE_ID, bundlePath],
      { stdio: 'inherit' }
    );
  } catch (error) {
    console.error('[brand:electron] codesign failed — OS notifications will not work in dev:', error);
    process.exitCode = 1;
    return false;
  }

  try {
    execFileSync('codesign', ['--verify', '--verbose=2', bundlePath], { stdio: 'inherit' });
    console.log(`[brand:electron] codesign ok (${BUNDLE_ID})`);
    return true;
  } catch (error) {
    console.error(
      '[brand:electron] codesign verify failed — OS notifications will not work in dev:',
      error
    );
    process.exitCode = 1;
    return false;
  }
}

resignBrandedApp(appBundle);

// Refresh Launch Services + Spotlight metadata for this bundle.
// Without unregister/re-register, macOS often keeps serving cached "Electron".
const lsregister =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
if (fs.existsSync(lsregister)) {
  spawnSync(lsregister, ['-u', appBundle], { stdio: 'ignore' });
  spawnSync(lsregister, ['-u', STOCK_APP], { stdio: 'ignore' });
  spawnSync(lsregister, ['-f', '-R', '-trusted', appBundle], { stdio: 'ignore' });
}
spawnSync('touch', [appBundle], { stdio: 'ignore' });
spawnSync('mdimport', [appBundle], { stdio: 'ignore' });

const resolved = require(path.join(ELECTRON_DIR, 'index.js'));
console.log(`[brand:electron] "${PRODUCT_NAME}" → ${appBundle}`);
console.log(`[brand:electron] electron binary → ${resolved}`);
