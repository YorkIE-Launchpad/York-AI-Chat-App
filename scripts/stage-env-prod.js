/**
 * Stage production env for electron-builder extraResources.
 *
 * electron-builder ignores `.env*` source files (secret-safety default), so we
 * stage as `env.prod` (no leading dot). Runtime still loads it as the prod env.
 * Prefers local `.env.prod`; falls back to `.env.prod.example`.
 *
 * The staged file ships as plaintext inside every installed app, so it must only hold
 * public config (URLs, OAuth client IDs). Secrets belong on the York backend.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(PROJECT_ROOT, '.bundle-resources', 'env');
// Non-dot name so electron-builder will actually copy the file into Resources.
const OUT_FILE = path.join(OUT_DIR, 'env.prod');
const CANDIDATES = ['.env.prod', '.env.prod.example'];

const FORBIDDEN_KEY_PATTERN = /(SECRET|API_KEY|PRIVATE_KEY|PASSWORD|ACCESS_TOKEN|REFRESH_TOKEN)/i;

/** Keys with a non-empty value whose names look like credentials. */
function findForbiddenEnvKeys(text) {
  const forbidden = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, value] = match;
    const unquoted = value.trim().replace(/^["']|["']$/g, '');
    if (unquoted && FORBIDDEN_KEY_PATTERN.test(key)) {
      forbidden.push(key);
    }
  }
  return forbidden;
}

function main() {
  const sourceName = CANDIDATES.find((name) => fs.existsSync(path.join(PROJECT_ROOT, name)));
  if (!sourceName) {
    console.error(
      '[stage-env-prod] Missing .env.prod and .env.prod.example — cannot stage production env.'
    );
    process.exit(1);
  }

  const sourcePath = path.join(PROJECT_ROOT, sourceName);
  const forbidden = findForbiddenEnvKeys(fs.readFileSync(sourcePath, 'utf8'));
  if (forbidden.length > 0) {
    console.error(
      `[stage-env-prod] ${sourceName} contains secrets that would ship inside the app: ${forbidden.join(', ')}.\n` +
        '  Remove them from the desktop env and configure them on the York backend instead.'
    );
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.copyFileSync(sourcePath, OUT_FILE);
  // Remove legacy staged dotfile if present from older builds.
  const legacy = path.join(OUT_DIR, '.env.prod');
  if (fs.existsSync(legacy)) {
    fs.unlinkSync(legacy);
  }
  console.log(`[stage-env-prod] Staged ${sourceName} → ${path.relative(PROJECT_ROOT, OUT_FILE)}`);
}

if (require.main === module) {
  main();
}

module.exports = { findForbiddenEnvKeys };
