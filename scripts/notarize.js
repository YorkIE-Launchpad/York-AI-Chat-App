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

const ROOT = path.resolve(__dirname, '..');
const MATTER_WIDGET_ENTITLEMENTS = path.join(
  ROOT,
  'native/macos-matter-widget/MatterWidgetExtension/MatterWidgetExtension.entitlements'
);
const MATTER_WIDGET_BUNDLE_ID = 'ie.york.app.MatterWidget';
const SPEECH_HELPER_BUNDLE_ID = 'ie.york.vecos.speech-helper';

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

function signNestedBundlesForNotarization(appPath) {
  const identity = resolveSigningIdentity();
  if (!identity) {
    console.warn(
      '[notarize] No Developer ID identity found — nested helpers may fail notarization.'
    );
    return;
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

  console.log('[notarize] Re-signing main app bundle (deep)...');
  execFileSync(
    'codesign',
    [...distributionCodesignArgs(identity), '--deep', appPath],
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
  signNestedBundlesForNotarization(appPath);
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
