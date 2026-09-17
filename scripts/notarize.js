/**
 * afterSign hook for electron-builder.
 *
 * Notarizes the macOS .app bundle so it passes Gatekeeper on end-user machines.
 *
 * Required env vars (set in CI or locally):
 *   APPLE_ID              – Apple ID email
 *   APPLE_ID_PASSWORD     – App-specific password (NOT your Apple ID password)
 *   APPLE_TEAM_ID         – 10-char team identifier from developer.apple.com
 *
 * Missing credentials abort the build (pre-build-check also fails early on darwin).
 * Escape hatch for intentional unsigned packaging only:
 *   CSC_IDENTITY_AUTO_DISCOVERY=false
 *
 * Note: mac.notarize is set to false in electron-builder.yml so electron-builder's
 * built-in notarization does not run in addition to this hook (which would double
 * upload/poll time for large apps).
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { notarize } = require('@electron/notarize');

function signNestedSpeechHelper(appPath) {
  const identity = process.env.CSC_NAME || process.env.CSC_IDENTITY;
  if (!identity) {
    return;
  }
  const helperApp = path.join(
    appPath,
    'Contents',
    'Resources',
    'tools',
    'York GrowthOS.app'
  );
  if (!fs.existsSync(helperApp)) {
    return;
  }
  console.log('[notarize] Signing nested speech helper bundle...');
  execFileSync(
    'codesign',
    [
      '--force',
      '--deep',
      '--options',
      'runtime',
      '--sign',
      identity,
      '--identifier',
      'ie.york.vecos.speech-helper',
      helperApp,
    ],
    { stdio: 'inherit' }
  );
  execFileSync(
    'codesign',
    ['--force', '--deep', '--options', 'runtime', '--sign', identity, appPath],
    { stdio: 'inherit' }
  );
}

exports.default = async function afterSign(context) {
  const { electronPlatformName, appOutDir } = context;

  if (electronPlatformName !== 'darwin') {
    return;
  }

  const appId = 'ie.york.app';
  const appName = context.packager.appInfo.productFilename;
  const appPath = `${appOutDir}/${appName}.app`;

  const { APPLE_ID, APPLE_ID_PASSWORD, APPLE_TEAM_ID } = process.env;

  if (!APPLE_ID || !APPLE_ID_PASSWORD || !APPLE_TEAM_ID) {
    // Unsigned CI / smoke packaging only — never silently ship a signed build without notarizing.
    if (process.env.CSC_IDENTITY_AUTO_DISCOVERY === 'false') {
      console.log(
        '[notarize] Skipping — unsigned build (CSC_IDENTITY_AUTO_DISCOVERY=false).'
      );
      return;
    }
    throw new Error(
      '[notarize] Missing APPLE_ID, APPLE_ID_PASSWORD, or APPLE_TEAM_ID. ' +
        'Set notarization credentials, or CSC_IDENTITY_AUTO_DISCOVERY=false for an unsigned build.'
    );
  }

  // Built-in electron-builder notarization is disabled (mac.notarize: false).
  signNestedSpeechHelper(appPath);
  console.log(`[notarize] Notarizing ${appId} at ${appPath} (afterSign only) ...`);

  await notarize({
    appBundleId: appId,
    appPath,
    appleId: APPLE_ID,
    appleIdPassword: APPLE_ID_PASSWORD,
    teamId: APPLE_TEAM_ID,
  });

  console.log('[notarize] Done.');
};
