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
const {
  installMacOSLauncherWrapper,
  MACOS_MAIN_CODE_IDENTIFIER,
} = require('./install-macos-launcher-wrapper');

const ROOT = path.resolve(__dirname, '..');
const MAIN_ENTITLEMENTS = path.join(ROOT, 'resources/entitlements.mac.plist');
const MATTER_WIDGET_ENTITLEMENTS = path.join(
  ROOT,
  'native/macos-matter-widget/MatterWidgetExtension/MatterWidgetExtension.entitlements'
);
const MATTER_WIDGET_SYNC_ENTITLEMENTS = path.join(
  ROOT,
  'native/macos-matter-widget/matter-widget-sync/MatterWidgetSync.entitlements'
);
const MATTER_WIDGET_BUNDLE_ID = 'ie.york.app.MatterWidget';
const MATTER_WIDGET_SYNC_ID = 'ie.york.app.MatterWidgetSync';
const SPEECH_HELPER_BUNDLE_ID = 'ie.york.vecos.speech-helper';
const { verifyMacAppSignatureStrict } = require('./verify-macos-app-signature');

function resolveSigningIdentity() {
  if (process.env.CSC_NAME) {
    return process.env.CSC_NAME;
  }
  if (process.env.CSC_IDENTITY) {
    return process.env.CSC_IDENTITY;
  }
  try {
    const out = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
      encoding: 'utf8',
    });
    const match = out.match(/"(Developer ID Application:[^"]+)"/);
    if (match) {
      return match[1];
    }
  } catch {
    // ignore
  }
  return null;
}

function distributionCodesignArgs(identity) {
  return ['--force', '--options', 'runtime', '--timestamp', '--sign', identity];
}

function signMacOSLauncherWrapper(appPath, executableName, identity) {
  const macosDir = path.join(appPath, 'Contents', 'MacOS');
  const launcherPath = path.join(macosDir, executableName);
  const realPath = `${launcherPath}.real`;
  if (!fs.existsSync(realPath)) {
    return;
  }
  console.log(
    `[notarize] Signing macOS jitless launcher (trampoline + .real as ${MACOS_MAIN_CODE_IDENTIFIER})...`
  );
  // Same identifier on trampoline and Electron stub: Squirrel.Mac uses
  // SecCodeCopySelf on the running *.real process and requires the update
  // .app to satisfy that designated requirement.
  execFileSync(
    'codesign',
    [
      ...distributionCodesignArgs(identity),
      '--identifier',
      MACOS_MAIN_CODE_IDENTIFIER,
      '--entitlements',
      MAIN_ENTITLEMENTS,
      realPath,
    ],
    { stdio: 'inherit' }
  );
  execFileSync(
    'codesign',
    [
      ...distributionCodesignArgs(identity),
      '--identifier',
      MACOS_MAIN_CODE_IDENTIFIER,
      '--entitlements',
      MAIN_ENTITLEMENTS,
      launcherPath,
    ],
    { stdio: 'inherit' }
  );
}

function signNestedBundlesForNotarization(appPath, executableName) {
  const identity = resolveSigningIdentity();
  if (!identity) {
    throw new Error(
      '[notarize] No Developer ID Application identity found (CSC_NAME / CSC_IDENTITY / Keychain). ' +
        'Auto-update builds must be signed before upload:s3.'
    );
  }

  const wrapper = installMacOSLauncherWrapper({
    appBundlePath: appPath,
    executableName,
  });
  if (wrapper.installed) {
    console.log('[notarize] Installed macOS jitless launcher wrapper (signed in this hook)');
  }

  const speechHelper = path.join(
    appPath,
    'Contents',
    'Resources',
    'tools',
    'York GrowthOS.app'
  );
  if (fs.existsSync(speechHelper)) {
    console.log('[notarize] Signing nested speech helper bundle...');
    execFileSync(
      'codesign',
      [
        ...distributionCodesignArgs(identity),
        '--deep',
        '--identifier',
        SPEECH_HELPER_BUNDLE_ID,
        speechHelper,
      ],
      { stdio: 'inherit' }
    );
  }

  const matterAppex = path.join(
    appPath,
    'Contents',
    'PlugIns',
    'MatterWidgetExtension.appex'
  );
  if (fs.existsSync(matterAppex)) {
    if (process.env.OMIT_MATTER_WIDGET_FOR_NOTARIZE === '1') {
      console.log('[notarize] OMIT_MATTER_WIDGET_FOR_NOTARIZE=1 — removing Matter widget extension');
      fs.rmSync(matterAppex, { recursive: true, force: true });
    } else {
      console.log('[notarize] Re-signing MatterWidgetExtension.appex for notarization...');
      try {
        execFileSync(
          'codesign',
          [
            ...distributionCodesignArgs(identity),
            '--identifier',
            MATTER_WIDGET_BUNDLE_ID,
            '--entitlements',
            MATTER_WIDGET_ENTITLEMENTS,
            matterAppex,
          ],
          { stdio: 'inherit' }
        );
      } catch (error) {
        console.warn(
          '[notarize] Matter widget Developer ID sign failed — removing extension so notarization can succeed.'
        );
        console.warn(
          '[notarize] For a notarized desktop widget, set MATTER_WIDGET_DEVELOPMENT_TEAM and provisioning profiles, then rebuild.'
        );
        fs.rmSync(matterAppex, { recursive: true, force: true });
      }
    }
  }

  const matterSyncHelper = path.join(
    appPath,
    'Contents',
    'Resources',
    'tools',
    'bin',
    'matter-widget-sync'
  );
  if (fs.existsSync(matterSyncHelper)) {
    console.log('[notarize] Signing matter-widget-sync (App Group writer)...');
    try {
      execFileSync(
        'codesign',
        [
          ...distributionCodesignArgs(identity),
          '--identifier',
          MATTER_WIDGET_SYNC_ID,
          '--entitlements',
          MATTER_WIDGET_SYNC_ENTITLEMENTS,
          matterSyncHelper,
        ],
        { stdio: 'inherit' }
      );
    } catch (error) {
      console.warn(
        '[notarize] matter-widget-sync sign failed — widget may stay empty (EPERM on Group Containers):',
        error instanceof Error ? error.message : error
      );
    }
  }

  signMacOSLauncherWrapper(appPath, executableName, identity);

  console.log(
    `[notarize] Re-signing main app bundle (identifier ${MACOS_MAIN_CODE_IDENTIFIER}, no --deep)...`
  );
  execFileSync(
    'codesign',
    [
      ...distributionCodesignArgs(identity),
      '--identifier',
      MACOS_MAIN_CODE_IDENTIFIER,
      '--entitlements',
      MAIN_ENTITLEMENTS,
      appPath,
    ],
    { stdio: 'inherit' }
  );

  verifyMacAppSignatureStrict(appPath, { label: 'post-sign' });
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
  signNestedBundlesForNotarization(appPath, appName);
  console.log(`[notarize] Notarizing ${appId} at ${appPath} (afterSign only) ...`);

  await notarize({
    appBundleId: appId,
    appPath,
    appleId: APPLE_ID,
    appleIdPassword: APPLE_ID_PASSWORD,
    teamId: APPLE_TEAM_ID,
  });

  console.log('[notarize] Done.');
  verifyMacAppSignatureStrict(appPath, { label: 'post-notarize', assessGatekeeper: true });
};
