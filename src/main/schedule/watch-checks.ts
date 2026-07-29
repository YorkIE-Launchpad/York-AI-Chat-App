/**
 * Lightweight condition checks for WatchTask reactive polling.
 */
import { createHash } from 'crypto';
import { readFileSync, statSync } from 'fs';
import { spawn } from 'child_process';
import type {
  AgentWatchCheckConfig,
  CommandWatchCheckConfig,
  FileWatchCheckConfig,
  HttpWatchCheckConfig,
  WatchCompareMode,
  WatchConfig,
} from '../../shared/loop/types';
import { logWarn } from '../utils/logger';

export interface WatchCheckResult {
  changed: boolean;
  state: string;
  summary: string;
}

export async function checkWatchCondition(
  watchConfig: WatchConfig,
  cwd: string,
  options?: {
    runAgentCheck?: (prompt: string) => Promise<{ changed: boolean; summary: string }>;
  }
): Promise<WatchCheckResult> {
  const previous = watchConfig.lastState ?? null;
  let state: string;
  let summary: string;

  switch (watchConfig.checkType) {
    case 'http':
      ({ state, summary } = await checkHttp(
        watchConfig.checkConfig as HttpWatchCheckConfig,
        watchConfig.compareMode
      ));
      break;
    case 'command':
      ({ state, summary } = await checkCommand(
        watchConfig.checkConfig as CommandWatchCheckConfig,
        cwd
      ));
      break;
    case 'file':
      ({ state, summary } = checkFile(watchConfig.checkConfig as FileWatchCheckConfig));
      break;
    case 'agent': {
      const cfg = watchConfig.checkConfig as AgentWatchCheckConfig;
      if (!options?.runAgentCheck) {
        throw new Error('Agent watch check requires runAgentCheck');
      }
      const result = await options.runAgentCheck(cfg.checkPrompt);
      state = JSON.stringify({ changed: result.changed, summary: result.summary });
      summary = result.summary;
      // Agent check encodes change directly
      const changed = result.changed || (previous !== null && previous !== state);
      return { changed: previous === null ? result.changed : changed, state, summary };
    }
    default:
      throw new Error(`Unsupported watch check type: ${String(watchConfig.checkType)}`);
  }

  const changed = previous === null ? true : previous !== state;
  return { changed, state, summary };
}

async function checkHttp(
  config: HttpWatchCheckConfig,
  compareMode: WatchCompareMode
): Promise<{ state: string; summary: string }> {
  const response = await fetch(config.url, {
    method: 'GET',
    redirect: 'follow',
    signal: AbortSignal.timeout(30_000),
  });
  const status = response.status;
  const bodyText = await response.text();

  if (compareMode === 'status') {
    return {
      state: `status:${status}`,
      summary: `HTTP ${status} for ${config.url}`,
    };
  }

  let material = bodyText;
  if (compareMode === 'jsonpath' && config.bodySelector) {
    try {
      const json = JSON.parse(bodyText) as unknown;
      material = String(selectDotPath(json, config.bodySelector));
    } catch {
      material = bodyText;
    }
  } else if (compareMode === 'regex' && config.bodySelector) {
    try {
      const re = new RegExp(config.bodySelector);
      const match = bodyText.match(re);
      material = match ? match[0] : '';
    } catch {
      logWarn('[WatchCheck] Invalid regex selector');
      material = bodyText;
    }
  }

  const hash = createHash('sha256').update(material).digest('hex').slice(0, 32);
  return {
    state: `http:${status}:${hash}`,
    summary: `HTTP ${status} hash=${hash.slice(0, 8)}`,
  };
}

async function checkCommand(
  config: CommandWatchCheckConfig,
  cwd: string
): Promise<{ state: string; summary: string }> {
  const result = await runShell(config.command, cwd);
  const hash = createHash('sha256').update(result.stdout).digest('hex').slice(0, 32);
  return {
    state: `cmd:${result.exitCode}:${hash}`,
    summary: `exit ${result.exitCode} hash=${hash.slice(0, 8)}`,
  };
}

function checkFile(config: FileWatchCheckConfig): { state: string; summary: string } {
  const stats = statSync(config.path);
  const content = readFileSync(config.path);
  const hash = createHash('sha256').update(content).digest('hex').slice(0, 32);
  return {
    state: `file:${stats.mtimeMs}:${hash}`,
    summary: `mtime=${stats.mtimeMs} hash=${hash.slice(0, 8)}`,
  };
}

function selectDotPath(value: unknown, path: string): unknown {
  const parts = path.split('.').filter(Boolean);
  let current: unknown = value;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function runShell(
  command: string,
  cwd: string
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('Watch command timed out'));
    }, 60_000);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (stdout.length > 512_000) stdout = stdout.slice(0, 512_000);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > 128_000) stderr = stderr.slice(0, 128_000);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}
