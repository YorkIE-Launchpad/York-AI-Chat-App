#!/usr/bin/env node

/**
 * Bump the app release version in package.json + package-lock.json.
 * Does not create a git commit or tag (upload:s3 creates v{version} after publish).
 *
 * Usage:
 *   npm run version:bump -- patch
 *   npm run version:bump -- minor
 *   npm run version:bump -- major
 *   npm run version:bump -- 2.3.0
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PKG_PATH = path.join(ROOT, 'package.json');
const LOCK_PATH = path.join(ROOT, 'package-lock.json');

const SEMVER_RE = /^\d+\.\d+\.\d+$/;

/**
 * @param {string} version
 * @returns {{ major: number; minor: number; patch: number }}
 */
function parseSemver(version) {
  if (!SEMVER_RE.test(version)) {
    throw new Error(`Invalid semver "${version}" (expected x.y.z)`);
  }
  const [major, minor, patch] = version.split('.').map(Number);
  return { major, minor, patch };
}

/**
 * @param {string} current
 * @param {'major' | 'minor' | 'patch' | string} target
 * @returns {string}
 */
function nextVersion(current, target) {
  if (target === 'major' || target === 'minor' || target === 'patch') {
    const parts = parseSemver(current);
    if (target === 'major') {
      parts.major += 1;
      parts.minor = 0;
      parts.patch = 0;
    } else if (target === 'minor') {
      parts.minor += 1;
      parts.patch = 0;
    } else {
      parts.patch += 1;
    }
    return `${parts.major}.${parts.minor}.${parts.patch}`;
  }

  parseSemver(target);
  if (target === current) {
    throw new Error(`Version is already ${current}`);
  }
  return target;
}

/**
 * @param {string} version
 * @returns {void}
 */
function writeVersion(version) {
  const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
  pkg.version = version;
  fs.writeFileSync(PKG_PATH, `${JSON.stringify(pkg, null, 2)}\n`);

  if (fs.existsSync(LOCK_PATH)) {
    const lock = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
    lock.version = version;
    if (lock.packages && lock.packages['']) {
      lock.packages[''].version = version;
    }
    fs.writeFileSync(LOCK_PATH, `${JSON.stringify(lock, null, 2)}\n`);
  }
}

/**
 * @param {string[]} argv
 * @returns {void}
 */
function main(argv) {
  const target = argv[2];
  if (!target) {
    console.error(
      'Usage: npm run version:bump -- <patch|minor|major|x.y.z>\n' +
        'Example: npm run version:bump -- patch'
    );
    process.exit(1);
  }

  const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
  const current = pkg.version;
  const next = nextVersion(current, target);
  writeVersion(next);
  console.log(`[version:bump] ${current} → ${next}`);
}

if (require.main === module) {
  try {
    main(process.argv);
  } catch (err) {
    console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

module.exports = { parseSemver, nextVersion, writeVersion };
