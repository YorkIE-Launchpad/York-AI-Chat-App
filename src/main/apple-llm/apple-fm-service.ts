import { execFile, spawn, type ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import {
  APPLE_LLM_CONTEXT_WINDOW,
  APPLE_LLM_DISPLAY_NAME,
  APPLE_LLM_MODEL_ID,
  formatAppleLlmModelName,
  resolveAppleLlmBaseUrl,
  resolveAppleLlmPort,
  type AppleLlmStatus,
  type AppleLlmUnavailableReason,
} from '../../shared/apple-llm-config';
import type { ProviderModelInfo } from '../../renderer/types';
import { log, logWarn } from '../utils/logger';
import { listMacBundledToolsSearchRoots } from '../utils/macos-bundled-tools';

const execFileAsync = promisify(execFile);

export interface AppleLlmModelInfo extends ProviderModelInfo {
  contextWindow?: number;
}

export interface FmRunResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface AppleServerSpec {
  executable: string;
  args: string[];
}

/** Injectable seams for tests; production prefers the bundled helper, falls back to `fm`. */
export interface AppleFmDeps {
  platform?: NodeJS.Platform;
  /** Bundled `york-apple-llm` path; `null` forces the `fm` fallback. */
  helperPath?: string | null;
  fmBinaryExists?: () => boolean;
  runFm?: (args: string[]) => Promise<FmRunResult>;
  runHelper?: (helperPath: string, args: string[]) => Promise<FmRunResult>;
  probeServer?: (baseUrl: string) => Promise<boolean>;
  spawnServer?: (spec: AppleServerSpec) => ChildProcess;
}

const FM_CANDIDATE_PATHS = ['/usr/bin/fm', '/usr/local/bin/fm'];
export const APPLE_LLM_HELPER_NAME = 'york-apple-llm';
const STATUS_CACHE_TTL_MS = 15_000;
const SERVER_START_TIMEOUT_MS = 15_000;

let statusCache: { expiresAt: number; status: AppleLlmStatus } | null = null;
let serverChild: ChildProcess | null = null;
let ensureInFlight: Promise<AppleLlmStatus> | null = null;

/**
 * Locate the bundled FoundationModels helper. Unlike `fm`, it needs no
 * `sudo fm license`, so it is the primary backend on Jamf-managed Macs.
 * `resources/tools` is gitignored, so dev builds only get it after
 * `npm run build:apple-llm`; the `fm` path remains as a fallback.
 */
export function resolveAppleLlmHelperPath(): string | null {
  if (process.platform !== 'darwin') return null;
  const fromEnv = process.env.YORK_APPLE_LLM_HELPER?.trim();
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  for (const root of listMacBundledToolsSearchRoots()) {
    const candidate = path.join(root, 'bin', APPLE_LLM_HELPER_NAME);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function parseFmLicenseAgreed(text: string): boolean | null {
  if (/not agreed/i.test(text)) return false;
  if (/\bagreed\b/i.test(text)) return true;
  return null;
}

export function parseFmAvailability(text: string): {
  available: boolean;
  reason?: AppleLlmStatus['reason'];
  message?: string;
} {
  const trimmed = text.trim();
  if (/does not support Apple Intelligence/i.test(trimmed)) {
    return {
      available: false,
      reason: 'apple-intelligence-unavailable',
      message: 'This device does not support Apple Intelligence.',
    };
  }
  const unavailable = trimmed.match(/unavailable[:\s-]*(.*)/i);
  if (/unavailable/i.test(trimmed)) {
    return {
      available: false,
      reason: 'model-unavailable',
      message: unavailable?.[1]?.trim() || trimmed,
    };
  }
  if (/available/i.test(trimmed)) {
    return { available: true };
  }
  return { available: false, reason: 'unknown', message: trimmed || undefined };
}

const KNOWN_REASONS = new Set<AppleLlmUnavailableReason>([
  'unsupported-platform',
  'fm-missing',
  'license-required',
  'apple-intelligence-unavailable',
  'model-unavailable',
  'unknown',
]);

/** Parse the helper's one-line `availability` JSON. Returns null when unparseable. */
export function parseHelperAvailability(text: string): {
  available: boolean;
  reason?: AppleLlmStatus['reason'];
  message?: string;
} | null {
  try {
    const parsed = JSON.parse(text.trim()) as Record<string, unknown>;
    if (typeof parsed.available !== 'boolean') return null;
    const reason =
      typeof parsed.reason === 'string' &&
      KNOWN_REASONS.has(parsed.reason as AppleLlmUnavailableReason)
        ? (parsed.reason as AppleLlmStatus['reason'])
        : parsed.available
          ? undefined
          : 'unknown';
    return {
      available: parsed.available,
      reason,
      message: typeof parsed.message === 'string' ? parsed.message : undefined,
    };
  } catch {
    return null;
  }
}

async function runExecutable(executable: string, args: string[]): Promise<FmRunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(executable, args, { timeout: 8000 });
    return { stdout: String(stdout), stderr: String(stderr), code: 0 };
  } catch (error) {
    const err = error as { stdout?: unknown; stderr?: unknown; code?: unknown; message?: string };
    return {
      stdout: typeof err.stdout === 'string' ? err.stdout : '',
      stderr: typeof err.stderr === 'string' ? err.stderr : err.message || 'command failed',
      code: typeof err.code === 'number' ? err.code : 1,
    };
  }
}

async function defaultProbeServer(baseUrl: string): Promise<boolean> {
  const origin = baseUrl.replace(/\/v1\/?$/, '');
  for (const route of ['/health', '/v1/models']) {
    try {
      const res = await fetch(`${origin}${route}`, {
        signal: AbortSignal.timeout(1500),
      });
      if (res.ok) return true;
    } catch {
      // try next route
    }
  }
  return false;
}

function defaultSpawnServer(spec: AppleServerSpec): ChildProcess {
  const child = spawn(spec.executable, spec.args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    logWarn('[AppleLLM] server:', chunk.toString().trim());
  });
  child.on('exit', () => {
    if (serverChild === child) serverChild = null;
  });
  return child;
}

interface ResolvedDeps {
  platform: NodeJS.Platform;
  helperPath: string | null;
  fmBinaryExists: () => boolean;
  runFm: (args: string[]) => Promise<FmRunResult>;
  runHelper: (helperPath: string, args: string[]) => Promise<FmRunResult>;
  probeServer: (baseUrl: string) => Promise<boolean>;
  spawnServer: (spec: AppleServerSpec) => ChildProcess;
}

function resolveDeps(deps?: AppleFmDeps): ResolvedDeps {
  return {
    platform: deps?.platform ?? process.platform,
    helperPath: deps?.helperPath !== undefined ? deps.helperPath : resolveAppleLlmHelperPath(),
    fmBinaryExists: deps?.fmBinaryExists ?? (() => FM_CANDIDATE_PATHS.some((p) => existsSync(p))),
    runFm: deps?.runFm ?? ((args) => runExecutable('fm', args)),
    runHelper: deps?.runHelper ?? ((helperPath, args) => runExecutable(helperPath, args)),
    probeServer: deps?.probeServer ?? defaultProbeServer,
    spawnServer: deps?.spawnServer ?? defaultSpawnServer,
  };
}

/**
 * Detect Apple Local LLM readiness without starting the server.
 * Backend order: bundled FoundationModels helper (no admin rights) → `fm` CLI.
 */
export async function getAppleLlmStatus(
  deps?: AppleFmDeps,
  options?: { forceRefresh?: boolean }
): Promise<AppleLlmStatus> {
  const now = Date.now();
  if (!deps && !options?.forceRefresh && statusCache && statusCache.expiresAt > now) {
    return statusCache.status;
  }
  const d = resolveDeps(deps);
  const baseUrl = resolveAppleLlmBaseUrl();

  const finish = (status: AppleLlmStatus): AppleLlmStatus => {
    if (!deps) statusCache = { expiresAt: now + STATUS_CACHE_TTL_MS, status };
    return status;
  };

  if (d.platform !== 'darwin') {
    return finish({
      available: false,
      serverRunning: false,
      reason: 'unsupported-platform',
      message: 'Apple Local LLM requires macOS on Apple silicon.',
    });
  }

  const serverRunning = await d.probeServer(baseUrl);

  // Primary: bundled helper — no license, no sudo, works under Jamf.
  if (d.helperPath) {
    const result = await d.runHelper(d.helperPath, ['availability']);
    const parsed = parseHelperAvailability(result.stdout || result.stderr);
    if (parsed) {
      return finish({
        available: parsed.available,
        serverRunning,
        reason: parsed.reason,
        message: parsed.message,
        backend: 'foundation-models-helper',
      });
    }
    logWarn(
      '[AppleLLM] Helper availability check was unparseable; falling back to fm:',
      result.stderr
    );
  }

  // Fallback: `fm` CLI (dev machines / builds without the helper).
  if (!d.fmBinaryExists()) {
    return finish({
      available: false,
      serverRunning,
      reason: 'fm-missing',
      message: 'Apple Local LLM needs macOS 26+ (bundled helper missing and no `fm` CLI found).',
    });
  }

  const license = await d.runFm(['license', '--status']);
  const agreed = parseFmLicenseAgreed(`${license.stdout}\n${license.stderr}`);
  if (agreed === false) {
    return finish({
      available: false,
      serverRunning,
      reason: 'license-required',
      backend: 'fm-cli',
      message:
        "This build uses the fm CLI, which needs a one-time 'sudo fm license'. Ask IT to push it via Jamf (scripts/jamf/), or use a build with the bundled Apple helper.",
    });
  }

  const availability = await d.runFm(['available', '--model', APPLE_LLM_MODEL_ID]);
  const parsedFm = parseFmAvailability(`${availability.stdout}\n${availability.stderr}`);
  if (!parsedFm.available) {
    return finish({
      available: false,
      serverRunning,
      reason:
        parsedFm.reason === 'unknown' && agreed === null ? 'license-required' : parsedFm.reason,
      message: parsedFm.message,
      backend: 'fm-cli',
    });
  }

  return finish({ available: true, serverRunning, backend: 'fm-cli' });
}

/** Models for the picker: a single on-device `system` model, only when usable. */
export async function listAppleLlmModels(deps?: AppleFmDeps): Promise<AppleLlmModelInfo[]> {
  const status = await getAppleLlmStatus(deps);
  if (!status.available) return [];
  return [
    {
      id: APPLE_LLM_MODEL_ID,
      name: formatAppleLlmModelName(APPLE_LLM_MODEL_ID),
      contextWindow: APPLE_LLM_CONTEXT_WINDOW,
    },
  ];
}

/**
 * Start the local server (bundled helper preferred, else `fm serve`) on
 * loopback if it is not already answering, and wait until it is healthy.
 * The child is owned by the app and stopped on quit via {@link stopAppleLlmServer}.
 */
export async function ensureAppleLlmServer(deps?: AppleFmDeps): Promise<AppleLlmStatus> {
  if (ensureInFlight) return ensureInFlight;
  ensureInFlight = (async () => {
    const d = resolveDeps(deps);
    const baseUrl = resolveAppleLlmBaseUrl();
    // Called on every chat turn: when our own server is already up, skip
    // the availability subprocess (it served the previous turn fine).
    if (serverChild && !serverChild.killed && (await d.probeServer(baseUrl))) {
      return {
        available: true,
        serverRunning: true,
        backend: d.helperPath ? 'foundation-models-helper' : 'fm-cli',
      };
    }
    const status = await getAppleLlmStatus(deps, { forceRefresh: true });
    if (!status.available) {
      throw new Error(status.message || `${APPLE_LLM_DISPLAY_NAME} is not available on this Mac.`);
    }
    if (status.serverRunning) return status;

    const port = resolveAppleLlmPort();
    const spec: AppleServerSpec = d.helperPath
      ? { executable: d.helperPath, args: ['serve', '--port', String(port)] }
      : { executable: 'fm', args: ['serve', '--host', '127.0.0.1', '--port', String(port)] };
    log(`[AppleLLM] Starting ${spec.executable} ${spec.args.join(' ')} → ${baseUrl}`);
    serverChild = d.spawnServer(spec);
    const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await d.probeServer(baseUrl)) {
        const ready: AppleLlmStatus = {
          available: true,
          serverRunning: true,
          backend: status.backend,
        };
        statusCache = { expiresAt: Date.now() + STATUS_CACHE_TTL_MS, status: ready };
        return ready;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(
      'The Apple Local LLM server did not become healthy in time. Try again, or restart GrowthOS.'
    );
  })();
  try {
    return await ensureInFlight;
  } finally {
    ensureInFlight = null;
  }
}

export function stopAppleLlmServer(): void {
  if (serverChild && !serverChild.killed) {
    serverChild.kill();
  }
  serverChild = null;
}

export function resetAppleLlmStateForTests(): void {
  statusCache = null;
  ensureInFlight = null;
  serverChild = null;
}
