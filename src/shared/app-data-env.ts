/**
 * Resolve the Electron userData directory name for this process.
 *
 * Packaged / default → `york-ie`
 * Local `npm run dev` → `york-ie-dev`
 * Explicit override → `york-ie-<YORK_IE_APP_DATA_ENV>`
 *
 * Free of Electron imports so MCP child processes and Node scripts can reuse it.
 */
import * as os from 'os';
import * as path from 'path';

export const BASE_APP_DATA_NAME = 'york-ie';
export const APP_DATA_ENV_VAR = 'YORK_IE_APP_DATA_ENV';
export const APP_DATA_NAME_VAR = 'YORK_IE_APP_DATA_NAME';

export interface ResolveAppDataDirOptions {
  platform?: NodeJS.Platform;
  home?: string;
  env?: NodeJS.ProcessEnv;
}

function sanitizeEnvSuffix(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '-');
}

/**
 * Prefer YORK_IE_APP_DATA_ENV; else `dev` when the Vite dev server is active; else `default`.
 */
export function resolveAppDataEnv(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env[APP_DATA_ENV_VAR]?.trim();
  if (explicit) {
    return sanitizeEnvSuffix(explicit);
  }
  if (env.VITE_DEV_SERVER_URL?.trim()) {
    return 'dev';
  }
  return 'default';
}

/**
 * Folder name under Application Support / APPDATA / XDG config.
 * Prefer YORK_IE_APP_DATA_NAME when already resolved by the main process bootstrap.
 */
export function resolveAppDataName(env: NodeJS.ProcessEnv = process.env): string {
  const explicitName = env[APP_DATA_NAME_VAR]?.trim();
  if (explicitName) {
    return explicitName;
  }

  const appEnv = resolveAppDataEnv(env);
  if (!appEnv || appEnv === 'default') {
    return BASE_APP_DATA_NAME;
  }
  return `${BASE_APP_DATA_NAME}-${appEnv}`;
}

/**
 * Absolute userData directory for the current platform (non-Electron callers).
 */
export function resolveAppDataDir(options: ResolveAppDataDirOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? os.homedir();
  const env = options.env ?? process.env;
  const name = resolveAppDataName(env);

  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', name);
  }
  if (platform === 'win32') {
    return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), name);
  }
  const xdgConfig = env.XDG_CONFIG_HOME || path.join(home, '.config');
  return path.join(xdgConfig, name);
}
