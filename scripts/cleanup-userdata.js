#!/usr/bin/env node
/**
 * Wipe York IE local app data so the next launch behaves like a fresh install.
 *
 * Usage:
 *   npm run clean:userdata              # interactive full wipe
 *   npm run clean:userdata -- --yes     # full wipe, no prompt
 *   npm run clean:userdata -- --history # chat DB only (keeps settings/keys)
 *   npm run clean:userdata -- --dry-run # show what would be deleted
 *
 * Quit the app (Cmd+Q / Alt+F4) before running.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const APP_DATA_NAME = 'york-ie';
const APP_ID = 'ie.york.app';

const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

/**
 * @param {string} platform
 * @param {string} home
 * @param {NodeJS.ProcessEnv} env
 */
function resolveCleanupTargets(platform, home, env) {
  /** @type {{ label: string; path: string; kind: 'dir' | 'file' | 'glob-prefix' }[]} */
  const targets = [];

  if (platform === 'darwin') {
    targets.push(
      {
        label: 'Application Support (userData)',
        path: path.join(home, 'Library', 'Application Support', APP_DATA_NAME),
        kind: 'dir',
      },
      {
        label: 'Caches',
        path: path.join(home, 'Library', 'Caches', APP_DATA_NAME),
        kind: 'dir',
      },
      {
        label: 'Preferences',
        path: path.join(home, 'Library', 'Preferences', `${APP_ID}.plist`),
        kind: 'file',
      },
      // Electron / Chromium sometimes also write under the product-style name
      {
        label: 'Caches (alt name)',
        path: path.join(home, 'Library', 'Caches', APP_ID),
        kind: 'dir',
      }
    );
  } else if (platform === 'win32') {
    const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const localAppData = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    targets.push(
      {
        label: 'Roaming userData',
        path: path.join(appData, APP_DATA_NAME),
        kind: 'dir',
      },
      {
        label: 'Local cache',
        path: path.join(localAppData, APP_DATA_NAME),
        kind: 'dir',
      }
    );
  } else {
    // Linux / other: Electron userData is typically ~/.config/<name>
    const xdgConfig = env.XDG_CONFIG_HOME || path.join(home, '.config');
    const xdgCache = env.XDG_CACHE_HOME || path.join(home, '.cache');
    targets.push(
      {
        label: 'Config (userData)',
        path: path.join(xdgConfig, APP_DATA_NAME),
        kind: 'dir',
      },
      {
        label: 'Cache',
        path: path.join(xdgCache, APP_DATA_NAME),
        kind: 'dir',
      }
    );
  }

  return targets;
}

/**
 * Chat history lives in userData/data/york-ie.db (+ WAL/SHM).
 * @param {string} platform
 * @param {string} home
 * @param {NodeJS.ProcessEnv} env
 */
function resolveHistoryDbPaths(platform, home, env) {
  const userData = resolveCleanupTargets(platform, home, env).find((t) =>
    /userData|Roaming|Config/i.test(t.label)
  );
  if (!userData) return [];

  const dbDir = path.join(userData.path, 'data');
  return [
    path.join(dbDir, 'york-ie.db'),
    path.join(dbDir, 'york-ie.db-wal'),
    path.join(dbDir, 'york-ie.db-shm'),
  ];
}

/**
 * @param {string} targetPath
 * @returns {boolean}
 */
function pathExists(targetPath) {
  try {
    fs.accessSync(targetPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} targetPath
 * @param {'dir' | 'file' | 'glob-prefix'} kind
 * @param {boolean} dryRun
 */
function removePath(targetPath, kind, dryRun) {
  if (!pathExists(targetPath)) {
    console.log(`  ${DIM}skip (missing)${RESET} ${targetPath}`);
    return false;
  }

  if (dryRun) {
    console.log(`  ${YELLOW}would delete${RESET} ${targetPath}`);
    return true;
  }

  if (kind === 'file') {
    fs.unlinkSync(targetPath);
  } else {
    fs.rmSync(targetPath, { recursive: true, force: true });
  }
  console.log(`  ${GREEN}deleted${RESET} ${targetPath}`);
  return true;
}

/**
 * @param {string} question
 * @returns {Promise<boolean>}
 */
function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  return {
    yes: flags.has('--yes') || flags.has('-y'),
    dryRun: flags.has('--dry-run'),
    historyOnly: flags.has('--history'),
    help: flags.has('--help') || flags.has('-h'),
  };
}

function printHelp() {
  console.log(`
York IE userdata cleanup

Usage:
  node scripts/cleanup-userdata.js [options]
  npm run clean:userdata -- [options]

Options:
  --yes, -y      Skip confirmation prompt
  --history      Delete chat DB only (keep settings / API keys)
  --dry-run      Print paths that would be removed
  --help, -h     Show this help

Quit the app completely before running.
`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    process.exit(0);
  }

  const platform = process.platform;
  const home = os.homedir();
  const env = process.env;

  console.log(`\nYork IE cleanup (${platform})${opts.dryRun ? ' [dry-run]' : ''}\n`);
  console.log(
    `${YELLOW}Quit York IE VECOS completely before continuing (Cmd+Q / Alt+F4).${RESET}\n`
  );

  /** @type {{ label: string; path: string; kind: 'dir' | 'file' | 'glob-prefix' }[]} */
  let plan = [];

  if (opts.historyOnly) {
    for (const dbPath of resolveHistoryDbPaths(platform, home, env)) {
      plan.push({ label: path.basename(dbPath), path: dbPath, kind: 'file' });
    }
    console.log('Mode: history only (SQLite chat DB)\n');
  } else {
    plan = resolveCleanupTargets(platform, home, env);
    console.log('Mode: full wipe (userData + caches + prefs)\n');
  }

  const existing = plan.filter((t) => pathExists(t.path));
  if (existing.length === 0) {
    console.log(`${DIM}Nothing to clean — no matching app data found.${RESET}\n`);
    process.exit(0);
  }

  for (const target of plan) {
    console.log(`${target.label}`);
    console.log(`  ${target.path}${pathExists(target.path) ? '' : ` ${DIM}(missing)${RESET}`}`);
  }
  console.log('');

  if (!opts.dryRun && !opts.yes) {
    const ok = await confirm(
      opts.historyOnly
        ? 'Delete chat history? [y/N] '
        : 'Delete ALL local app data (settings, keys, history)? [y/N] '
    );
    if (!ok) {
      console.log('Aborted.\n');
      process.exit(0);
    }
    console.log('');
  }

  let removed = 0;
  for (const target of plan) {
    if (removePath(target.path, target.kind, opts.dryRun)) removed += 1;
  }

  console.log(
    `\n${GREEN}Done.${RESET} ${removed} path(s) ${opts.dryRun ? 'would be removed' : 'removed'}.` +
      ` Reopen the app for a clean start.\n`
  );
}

main().catch((err) => {
  console.error(`${RED}Cleanup failed:${RESET}`, err);
  process.exit(1);
});
