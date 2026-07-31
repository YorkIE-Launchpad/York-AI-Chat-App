#!/usr/bin/env node

/**
 * Upload macOS release artifacts (DMG + zipped .app) to S3,
 * generate release notes from the previous git tag, upload them,
 * then create an annotated v{version} tag (skip if already present).
 *
 * Layout:
 *   s3://york-internal-apps/york-workos/{version}/{filename}
 *   s3://york-internal-apps/york-workos/latest/{stable-filename}
 *
 * Usage:
 *   npm run upload:s3
 *   npm run build:s3
 */

'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BUCKET = 'york-internal-apps';
const REGION = 'ap-south-1';
const PREFIX = 'york-workos';

const ROOT = path.resolve(__dirname, '..');
const RELEASE_DIR = path.join(ROOT, 'release');
const pkg = require(path.join(ROOT, 'package.json'));
const VERSION = pkg.version;
const TAG_NAME = `v${VERSION}`;

/** @type {Record<string, string>} */
const COMMIT_SECTIONS = {
  feat: 'Features',
  fix: 'Fixes',
  perf: 'Improvements',
  refactor: 'Improvements',
  revert: 'Improvements',
};

/**
 * Run a git command and return trimmed stdout, or null on failure.
 * @param {string[]} args
 * @returns {string | null}
 */
function git(args) {
  try {
    return execFileSync('git', args, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Public HTTPS URL for an S3 object key.
 * @param {string} key
 * @returns {string}
 */
function publicUrl(key) {
  const encoded = key
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `https://${BUCKET}.s3.${REGION}.amazonaws.com/${encoded}`;
}

/**
 * @returns {void}
 */
function requireAwsCli() {
  try {
    execFileSync('aws', ['--version'], { stdio: 'pipe' });
  } catch {
    console.error('ERROR: AWS CLI not found. Install awscli and configure credentials.');
    process.exit(1);
  }
}

/**
 * @returns {boolean}
 */
function tagExists(tag) {
  return git(['rev-parse', '--verify', `refs/tags/${tag}`]) !== null;
}

/**
 * Nearest ancestor tag used as the release-notes baseline.
 * @returns {string | null}
 */
function findPreviousTag() {
  if (tagExists(TAG_NAME)) {
    return git(['describe', '--tags', '--abbrev=0', `${TAG_NAME}^`]);
  }
  return git(['describe', '--tags', '--abbrev=0']);
}

/**
 * @param {string} subject
 * @returns {{ type: string; description: string } | null}
 */
function parseConventionalSubject(subject) {
  const trimmed = subject.trim();
  if (!trimmed) return null;
  if (/^Merge\b/i.test(trimmed)) return null;
  if (/^merge(\(.+\))?:/i.test(trimmed)) return null;

  const match = trimmed.match(/^(\w+)(?:\([^)]*\))?(!)?:\s*(.+)$/);
  if (!match) {
    return { type: 'other', description: trimmed };
  }

  const type = match[1].toLowerCase();
  if (type === 'merge') return null;

  return { type, description: match[3].trim() };
}

/**
 * Build markdown release notes from commits since the previous tag.
 * @param {string} outPath
 * @returns {{ previousTag: string | null; path: string }}
 */
function generateReleaseNotes(outPath) {
  const previousTag = findPreviousTag();
  const range = previousTag ? `${previousTag}..HEAD` : 'HEAD';
  const logOutput = git(['log', range, '--pretty=format:%s']) || '';
  const subjects = logOutput.split('\n').filter(Boolean);

  /** @type {Record<string, string[]>} */
  const groups = {
    Features: [],
    Fixes: [],
    Improvements: [],
    Other: [],
  };

  for (const subject of subjects) {
    const parsed = parseConventionalSubject(subject);
    if (!parsed) continue;

    const section = COMMIT_SECTIONS[parsed.type] || 'Other';
    groups[section].push(parsed.description);
  }

  const lines = [`# York WorkOS v${VERSION}`, ''];
  if (previousTag) {
    lines.push(`Changes since \`${previousTag}\`.`, '');
  } else {
    lines.push('Initial release.', '');
  }

  let hasItems = false;
  for (const section of ['Features', 'Fixes', 'Improvements', 'Other']) {
    const items = groups[section];
    if (items.length === 0) continue;
    hasItems = true;
    lines.push(`## ${section}`, '');
    for (const item of items) {
      lines.push(`- ${item}`);
    }
    lines.push('');
  }

  if (!hasItems) {
    lines.push('_No notable commits in this range._', '');
  }

  fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
  return { previousTag, path: outPath };
}

/**
 * Create annotated tag v{VERSION} if missing.
 * @returns {void}
 */
function createReleaseTag() {
  if (tagExists(TAG_NAME)) {
    console.log(`\n[upload-s3] Tag ${TAG_NAME} already exists — skipping.`);
    return;
  }

  console.log(`\n[upload-s3] Creating annotated tag ${TAG_NAME}`);
  execFileSync(
    'git',
    ['tag', '-a', TAG_NAME, '-m', `York WorkOS v${VERSION}`],
    { cwd: ROOT, stdio: 'inherit' }
  );
  console.log(`  ✓ Created ${TAG_NAME} (local only — push with: git push origin ${TAG_NAME})`);
}

/**
 * @returns {{ localPath: string; versionedKey: string; latestKey: string; label: string }[]}
 */
function discoverDmgs() {
  if (!fs.existsSync(RELEASE_DIR)) return [];

  return fs
    .readdirSync(RELEASE_DIR)
    .filter((f) => f.endsWith('.dmg'))
    .map((filename) => {
      const archMatch = filename.match(/-mac-([^.]+)\.dmg$/);
      const arch = archMatch ? archMatch[1] : 'unknown';
      const stable = `York-WorkOS-mac-${arch}.dmg`;
      return {
        localPath: path.join(RELEASE_DIR, filename),
        versionedKey: `${PREFIX}/${VERSION}/${filename}`,
        latestKey: `${PREFIX}/latest/${stable}`,
        label: filename,
      };
    });
}

/**
 * Zip each .app under release/mac-* and return upload descriptors.
 * @param {string} tmpDir
 * @returns {{ localPath: string; versionedKey: string; latestKey: string; label: string }[]}
 */
function discoverAndZipApps(tmpDir) {
  if (!fs.existsSync(RELEASE_DIR)) return [];

  const macDirs = fs
    .readdirSync(RELEASE_DIR)
    .filter((d) => d.startsWith('mac-'))
    .map((d) => path.join(RELEASE_DIR, d))
    .filter((p) => fs.statSync(p).isDirectory());

  /** @type {{ localPath: string; versionedKey: string; latestKey: string; label: string }[]} */
  const artifacts = [];

  for (const macDir of macDirs) {
    const arch = path.basename(macDir).replace(/^mac-/, '');
    const apps = fs.readdirSync(macDir).filter((f) => f.endsWith('.app'));

    for (const appName of apps) {
      const appPath = path.join(macDir, appName);
      if (!fs.statSync(appPath).isDirectory()) continue;

      const baseName = appName.replace(/\.app$/, '');
      const zipFilename = `${baseName}-${VERSION}-mac-${arch}.zip`;
      const zipPath = path.join(tmpDir, zipFilename);
      const stable = `York-WorkOS-mac-${arch}.zip`;

      console.log(`\n[upload-s3] Zipping ${appName} → ${zipFilename}`);
      execFileSync(
        'ditto',
        ['-c', '-k', '--sequesterRsrc', '--keepParent', appPath, zipPath],
        { stdio: 'inherit' }
      );

      const sizeMb = (fs.statSync(zipPath).size / 1024 / 1024).toFixed(1);
      console.log(`  ✓ ${sizeMb}MB`);

      artifacts.push({
        localPath: zipPath,
        versionedKey: `${PREFIX}/${VERSION}/${zipFilename}`,
        latestKey: `${PREFIX}/latest/${stable}`,
        label: zipFilename,
      });
    }
  }

  return artifacts;
}

/**
 * @param {string} localPath
 * @param {string} key
 * @returns {void}
 */
function uploadFile(localPath, key) {
  const s3Uri = `s3://${BUCKET}/${key}`;
  console.log(`  → ${s3Uri}`);
  /** @type {string[]} */
  const args = [
    's3',
    'cp',
    localPath,
    s3Uri,
    '--acl',
    'public-read',
    '--region',
    REGION,
  ];
  if (localPath.endsWith('.md')) {
    args.push('--content-type', 'text/markdown; charset=utf-8');
  }
  execFileSync('aws', args, { stdio: 'inherit' });
}

function main() {
  requireAwsCli();

  if (!fs.existsSync(RELEASE_DIR)) {
    console.error(`ERROR: No release directory at ${RELEASE_DIR}. Run npm run build first.`);
    process.exit(1);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'york-s3-upload-'));
  /** @type {string[]} */
  const urls = [];

  try {
    const dmgs = discoverDmgs();
    const apps = discoverAndZipApps(tmpDir);
    const all = [...dmgs, ...apps];

    if (all.length === 0) {
      console.error(
        'ERROR: No .dmg or .app artifacts found in release/. Run npm run build first.'
      );
      process.exit(1);
    }

    console.log(`\n[upload-s3] Uploading ${all.length} artifact(s) for v${VERSION}`);
    console.log(`  bucket: s3://${BUCKET}`);
    console.log(`  region: ${REGION}`);

    for (const artifact of all) {
      console.log(`\n[upload-s3] ${artifact.label}`);
      uploadFile(artifact.localPath, artifact.versionedKey);
      uploadFile(artifact.localPath, artifact.latestKey);
      urls.push(publicUrl(artifact.versionedKey));
      urls.push(publicUrl(artifact.latestKey));
    }

    const notesPath = path.join(tmpDir, 'RELEASE_NOTES.md');
    const { previousTag } = generateReleaseNotes(notesPath);
    const notesVersionedKey = `${PREFIX}/${VERSION}/RELEASE_NOTES.md`;
    const notesLatestKey = `${PREFIX}/latest/RELEASE_NOTES.md`;

    console.log(
      `\n[upload-s3] RELEASE_NOTES.md` +
        (previousTag ? ` (since ${previousTag})` : ' (initial release)')
    );
    uploadFile(notesPath, notesVersionedKey);
    uploadFile(notesPath, notesLatestKey);
    urls.push(publicUrl(notesVersionedKey));
    urls.push(publicUrl(notesLatestKey));

    createReleaseTag();

    console.log('\n════════════════════════════════════════');
    console.log(`  Upload complete — York WorkOS v${VERSION}`);
    console.log('════════════════════════════════════════');
    console.log('\nPublic URLs:\n');
    for (const url of urls) {
      console.log(`  ${url}`);
    }
    console.log('');
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
}

main();
