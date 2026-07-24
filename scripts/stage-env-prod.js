/**
 * Stage production env for electron-builder extraResources.
 *
 * electron-builder ignores `.env*` source files (secret-safety default), so we
 * stage as `env.prod` (no leading dot). Runtime still loads it as the prod env.
 * Prefers local `.env.prod`; falls back to `.env.prod.example`.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(PROJECT_ROOT, '.bundle-resources', 'env');
// Non-dot name so electron-builder will actually copy the file into Resources.
const OUT_FILE = path.join(OUT_DIR, 'env.prod');
const CANDIDATES = ['.env.prod', '.env.prod.example'];

function main() {
  const sourceName = CANDIDATES.find((name) => fs.existsSync(path.join(PROJECT_ROOT, name)));
  if (!sourceName) {
    console.error(
      '[stage-env-prod] Missing .env.prod and .env.prod.example — cannot stage production env.'
    );
    process.exit(1);
  }

  const sourcePath = path.join(PROJECT_ROOT, sourceName);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.copyFileSync(sourcePath, OUT_FILE);
  // Remove legacy staged dotfile if present from older builds.
  const legacy = path.join(OUT_DIR, '.env.prod');
  if (fs.existsSync(legacy)) {
    fs.unlinkSync(legacy);
  }
  console.log(`[stage-env-prod] Staged ${sourceName} → ${path.relative(PROJECT_ROOT, OUT_FILE)}`);
}

main();
