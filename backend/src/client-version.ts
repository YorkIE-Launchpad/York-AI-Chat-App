import type { NextFunction, Request, Response } from 'express';

/** Header Electron sends with app.getVersion() on every backend request. */
export const YORK_APP_VERSION_HEADER = 'x-york-app-version';

/** Default minimum client version when MIN_CLIENT_VERSION is unset. */
export const DEFAULT_MIN_CLIENT_VERSION = '3.3.1';

export function getMinClientVersion(): string {
  const fromEnv = process.env.MIN_CLIENT_VERSION?.trim();
  return fromEnv || DEFAULT_MIN_CLIENT_VERSION;
}

/** Strip leading `v` and whitespace. */
export function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/i, '');
}

/**
 * True when the value looks like a usable major.minor.patch (optional prerelease).
 * Rejects empty / non-numeric cores so garbage headers cannot bypass the gate.
 */
export function isValidClientVersion(version: string): boolean {
  const normalized = normalizeVersion(version);
  if (!normalized) return false;
  const [core] = normalized.split('-', 2);
  const parts = core.split('.');
  if (parts.length < 1 || parts.length > 4) return false;
  return parts.every((p) => /^\d+$/.test(p));
}

/**
 * Compare two semver-like strings (major.minor.patch[-prerelease]).
 * Returns -1 if a < b, 0 if equal, 1 if a > b.
 */
export function compareSemver(a: string, b: string): number {
  const na = normalizeVersion(a);
  const nb = normalizeVersion(b);
  if (!na || !nb) return 0;

  const [aCore, aPre = ''] = na.split('-', 2);
  const [bCore, bPre = ''] = nb.split('-', 2);

  const aParts = aCore.split('.').map((p) => parseInt(p, 10) || 0);
  const bParts = bCore.split('.').map((p) => parseInt(p, 10) || 0);
  const len = Math.max(aParts.length, bParts.length, 3);

  for (let i = 0; i < len; i++) {
    const av = aParts[i] ?? 0;
    const bv = bParts[i] ?? 0;
    if (av < bv) return -1;
    if (av > bv) return 1;
  }

  // Release (no pre) sorts after prerelease of same core
  if (aPre && !bPre) return -1;
  if (!aPre && bPre) return 1;
  if (aPre < bPre) return -1;
  if (aPre > bPre) return 1;
  return 0;
}

function readHeaderValue(req: Request, name: string): string | undefined {
  const raw = req.headers[name];
  if (Array.isArray(raw)) return raw[0]?.trim() || undefined;
  return typeof raw === 'string' ? raw.trim() || undefined : undefined;
}

export type ClientVersionCheckResult =
  | { ok: true; clientVersion: string; minVersion: string }
  | {
      ok: false;
      clientVersion: string | null;
      minVersion: string;
      reason: 'missing' | 'invalid' | 'outdated';
    };

/** Pure check used by middleware and tests. */
export function checkClientVersion(
  clientVersionHeader: string | undefined | null,
  minVersion: string = getMinClientVersion()
): ClientVersionCheckResult {
  const clientVersion = clientVersionHeader?.trim() || '';
  if (!clientVersion) {
    return { ok: false, clientVersion: null, minVersion, reason: 'missing' };
  }
  if (!isValidClientVersion(clientVersion)) {
    return { ok: false, clientVersion, minVersion, reason: 'invalid' };
  }
  if (compareSemver(clientVersion, minVersion) < 0) {
    return { ok: false, clientVersion, minVersion, reason: 'outdated' };
  }
  return { ok: true, clientVersion, minVersion };
}

/** User-facing message that states required vs current version. */
export function clientOutdatedMessage(
  minVersion: string,
  clientVersion: string | null
): string {
  if (clientVersion) {
    return `Please update York IE GrowthOS to continue. This app is v${normalizeVersion(clientVersion)}; v${normalizeVersion(minVersion)} or newer is required.`;
  }
  return `Please update York IE GrowthOS to continue. v${normalizeVersion(minVersion)} or newer is required (client version was not reported).`;
}

/**
 * Reject requests from clients older than MIN_CLIENT_VERSION (default 3.3.1),
 * or clients that omit / send a non-semver X-York-App-Version header.
 */
export async function requireMinClientVersion(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const clientVersion = readHeaderValue(req, YORK_APP_VERSION_HEADER);
  const result = checkClientVersion(clientVersion);

  if (!result.ok) {
    res.status(426).json({
      error: 'client_outdated',
      message: clientOutdatedMessage(result.minVersion, result.clientVersion),
      minVersion: result.minVersion,
      clientVersion: result.clientVersion,
    });
    return;
  }

  next();
}
