/**
 * Pre-build validation script for electron-builder.
 *
 * Verifies that all required build artifacts and resources exist before
 * electron-builder packages the application. Exits 0 on success, 1 on failure.
 *
 * Supports a testable API via module.exports.runChecks(rootDir, platform).
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ANSI color codes
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

/**
 * @typedef {'fatal' | 'warn'} Severity
 * @typedef {{ label: string; relPath: string; type: 'file' | 'dir'; severity: Severity }} CheckSpec
 * @typedef {{ label: string; relPath: string; passed: boolean; severity: Severity }} CheckResult
 */

/**
 * Build the list of checks for the given platform and arch.
 *
 * @param {string} platform - Node.js process.platform value
 * @param {string} arch - Node.js process.arch value
 * @returns {CheckSpec[]}
 */
function buildCheckList(platform, arch) {
  /** @type {CheckSpec[]} */
  const checks = [
    // Common checks (all platforms, FATAL)
    {
      label: 'GUI Operate MCP server bundle',
      relPath: '.bundle-resources/mcp/gui-operate-server.js',
      type: 'file',
      severity: 'fatal',
    },
    {
      label: 'Software Dev MCP server bundle',
      relPath: '.bundle-resources/mcp/software-dev-server-example.js',
      type: 'file',
      severity: 'fatal',
    },
    {
      label: 'Electron main process output (dist-electron/)',
      relPath: 'dist-electron',
      type: 'dir',
      severity: 'fatal',
    },
    {
      label: 'Renderer output (dist/)',
      relPath: 'dist',
      type: 'dir',
      severity: 'fatal',
    },
    {
      label: 'Built-in skills directory (.claude/skills/)',
      relPath: '.claude/skills',
      type: 'dir',
      severity: 'fatal',
    },
    {
      label: 'Staged production env (.bundle-resources/env/env.prod)',
      relPath: '.bundle-resources/env/env.prod',
      type: 'file',
      severity: 'fatal',
    },
  ];

  if (platform === 'darwin') {
    checks.push(
      {
        label: `Node.js binary for macOS ${arch}`,
        relPath: `resources/node/darwin-${arch}/bin/node`,
        type: 'file',
        severity: 'fatal',
      },
      {
        label: 'Lima sandbox agent bundle (dist-lima-agent/index.js)',
        relPath: 'dist-lima-agent/index.js',
        type: 'file',
        severity: 'fatal',
      },
      {
        label: `Python runtime for macOS ${arch} (GUI automation)`,
        relPath: `resources/python/darwin-${arch}`,
        type: 'dir',
        severity: 'warn',
      },
      {
        label: `CLI tools for macOS ${arch} (cliclick)`,
        relPath: `resources/tools/darwin-${arch}`,
        type: 'dir',
        severity: 'warn',
      }
    );
  } else if (platform === 'win32') {
    checks.push(
      {
        label: 'Node.js binary for Windows x64',
        relPath: 'resources/node/win32-x64/node.exe',
        type: 'file',
        severity: 'fatal',
      },
      {
        label: 'WSL sandbox agent bundle (dist-wsl-agent/index.js)',
        relPath: 'dist-wsl-agent/index.js',
        type: 'file',
        severity: 'fatal',
      }
    );
  } else if (platform === 'linux') {
    checks.push({
      label: 'Node.js directory for Linux x64',
      relPath: 'resources/node/linux-x64',
      type: 'dir',
      severity: 'fatal',
    });
  }

  return checks;
}

/** Max hashed main-process chunks allowed before packaging (stale rebuilds). */
const MAX_HASHED_MAIN_CHUNKS = 5;

/**
 * Count Vite hashed main chunks (`index-<hash>.js`) in dist-electron/main.
 * A clean build should leave only the current chunk(s); hundreds means emptyOutDir failed.
 *
 * @param {string} rootDir
 * @returns {number}
 */
function countHashedMainChunks(rootDir) {
  const mainDir = path.join(rootDir, 'dist-electron', 'main');
  if (!fs.existsSync(mainDir)) {
    return 0;
  }
  return fs
    .readdirSync(mainDir)
    .filter((name) => /^index-[A-Za-z0-9_-]+\.js$/.test(name)).length;
}

/**
 * Run all pre-build checks and return results.
 *
 * @param {string} rootDir - Absolute path to the project root to check against
 * @param {string} platform - Node.js platform string (e.g. 'darwin', 'win32', 'linux')
 * @param {string} [arch] - Node.js arch string (e.g. 'x64', 'arm64'); defaults to process.arch
 * @returns {{ results: CheckResult[]; passed: number; warnings: number; failed: number; hasFatal: boolean }}
 */
function runChecks(rootDir, platform, arch) {
  const resolvedArch = arch || process.arch;
  const checks = buildCheckList(platform, resolvedArch);

  let passed = 0;
  let warnings = 0;
  let failed = 0;

  /** @type {CheckResult[]} */
  const results = [];

  for (const check of checks) {
    const absolutePath = path.join(rootDir, check.relPath);
    let exists = false;

    try {
      const stat = fs.statSync(absolutePath);
      exists = check.type === 'dir' ? stat.isDirectory() : stat.isFile();
    } catch {
      exists = false;
    }

    if (exists) {
      passed += 1;
      console.log(`${GREEN}[pass]${RESET} ${check.label}`);
      console.log(`       ${check.relPath}`);
    } else if (check.severity === 'warn') {
      warnings += 1;
      console.log(`${YELLOW}[warn]${RESET} ${check.label}`);
      console.log(`       ${check.relPath}`);
    } else {
      failed += 1;
      console.log(`${RED}[fail]${RESET} ${check.label}`);
      console.log(`       ${check.relPath}`);
    }

    results.push({
      label: check.label,
      relPath: check.relPath,
      passed: exists,
      severity: check.severity,
    });
  }

  // Guard against packaging multi-GB stale Vite electron output.
  const hashedChunkCount = countHashedMainChunks(rootDir);
  const staleChunksLabel = `Electron main hashed chunks (≤${MAX_HASHED_MAIN_CHUNKS})`;
  const staleChunksPath = 'dist-electron/main/index-*.js';
  if (hashedChunkCount <= MAX_HASHED_MAIN_CHUNKS) {
    passed += 1;
    console.log(`${GREEN}[pass]${RESET} ${staleChunksLabel}`);
    console.log(`       ${staleChunksPath} (${hashedChunkCount} found)`);
    results.push({
      label: staleChunksLabel,
      relPath: staleChunksPath,
      passed: true,
      severity: 'fatal',
    });
  } else {
    failed += 1;
    console.log(`${RED}[fail]${RESET} ${staleChunksLabel}`);
    console.log(
      `       ${staleChunksPath} (${hashedChunkCount} found — stale rebuilds will inflate app.asar; clean dist-electron and rebuild)`
    );
    results.push({
      label: staleChunksLabel,
      relPath: staleChunksPath,
      passed: false,
      severity: 'fatal',
    });
  }

  const hasFatal = failed > 0;
  return { results, passed, warnings, failed, hasFatal };
}

/**
 * CLI entry point: run checks against the project root and exit with appropriate code.
 */
function main() {
  const PROJECT_ROOT = path.join(__dirname, '..');

  console.log('\nRunning pre-build checks...\n');

  const { passed, warnings, failed, hasFatal } = runChecks(PROJECT_ROOT, process.platform);

  console.log(
    `\nPre-build check: ${passed} passed, ${warnings} warnings, ${failed} failed`
  );

  if (hasFatal) {
    console.log(
      `\n${RED}Build aborted. Fix the above issues before running electron-builder.${RESET}\n`
    );
    process.exit(1);
  }

  console.log('');
  process.exit(0);
}

module.exports = { runChecks, buildCheckList, countHashedMainChunks, MAX_HASHED_MAIN_CHUNKS };

if (require.main === module) {
  main();
}
