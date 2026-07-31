/**
 * Helpers for electron-updater generic feed metadata.
 * Used by upload-s3.js / after-pack.js; exported for unit tests.
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');

/** Must match electron-builder.yml publish.url and src/main/updater.ts */
const UPDATE_FEED_URL =
  'https://york-internal-apps.s3.ap-south-1.amazonaws.com/york-workos/latest';

/**
 * @param {string} filePath
 * @returns {string} SHA-512 digest as base64 (electron-updater format)
 */
function sha512Base64(filePath) {
  const hash = crypto.createHash('sha512');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('base64');
}

/**
 * @param {string} filePath
 * @returns {{ sha512: string; size: number }}
 */
function fileDigest(filePath) {
  const size = fs.statSync(filePath).size;
  return { sha512: sha512Base64(filePath), size };
}

/**
 * Cache dir name electron-builder writes into app-update.yml
 * (`sanitizedName.toLowerCase() + "-updater"`).
 * @param {string} packageName
 * @returns {string}
 */
function updaterCacheDirName(packageName) {
  const sanitized = String(packageName || 'app')
    .replace(/^@/, '')
    .replace(/[/\\?%*:|"<>]/g, '-');
  return `${sanitized.toLowerCase()}-updater`;
}

/**
 * Build Contents/Resources/app-update.yml for packaged apps.
 * electron-builder skips this for mac `dir` targets (only dmg/zip).
 *
 * @param {{
 *   url?: string;
 *   packageName?: string;
 *   updaterCacheDirName?: string;
 * }} [opts]
 * @returns {string}
 */
function buildAppUpdateYml(opts = {}) {
  const url = opts.url || UPDATE_FEED_URL;
  const cacheDir =
    opts.updaterCacheDirName ||
    updaterCacheDirName(opts.packageName || 'york-ie');
  return [
    'provider: generic',
    `url: ${url}`,
    `updaterCacheDirName: ${cacheDir}`,
    '',
  ].join('\n');
}

/**
 * Build latest-mac.yml contents for electron-updater generic provider.
 *
 * @param {{
 *   version: string;
 *   files: Array<{ url: string; sha512: string; size: number }>;
 *   releaseDate?: string;
 * }} opts
 * @returns {string}
 */
function buildLatestMacYml(opts) {
  const { version, files, releaseDate = new Date().toISOString() } = opts;
  if (!version || typeof version !== 'string') {
    throw new Error('buildLatestMacYml: version is required');
  }
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('buildLatestMacYml: at least one file is required');
  }

  const primary = files[0];
  const lines = [`version: ${version}`, 'files:'];

  for (const file of files) {
    if (!file.url || !file.sha512 || typeof file.size !== 'number') {
      throw new Error('buildLatestMacYml: each file needs url, sha512, and size');
    }
    lines.push(`  - url: ${file.url}`);
    lines.push(`    sha512: ${file.sha512}`);
    lines.push(`    size: ${file.size}`);
  }

  lines.push(`path: ${primary.url}`);
  lines.push(`sha512: ${primary.sha512}`);
  lines.push(`releaseDate: '${releaseDate}'`);
  lines.push('');

  return lines.join('\n');
}

module.exports = {
  UPDATE_FEED_URL,
  sha512Base64,
  fileDigest,
  updaterCacheDirName,
  buildAppUpdateYml,
  buildLatestMacYml,
};
