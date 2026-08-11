/**
 * Electron app version header for York backend min-version gate.
 * Backend rejects requests missing this header or below MIN_CLIENT_VERSION.
 */

export const YORK_APP_VERSION_HEADER = 'x-york-app-version';

/** Attach app version header for proxy / backend HTTP calls. */
export function withAppVersionHeader<T extends { headers?: Record<string, string> }>(
  model: T,
  version: string | undefined | null
): T {
  const v = version?.trim();
  if (!v) return model;
  return {
    ...model,
    headers: {
      ...(model.headers || {}),
      [YORK_APP_VERSION_HEADER]: v,
    },
  };
}

/** Headers object slice for fetch / OpenAI defaultHeaders. */
export function appVersionHeaders(version: string | undefined | null): Record<string, string> {
  const v = version?.trim();
  if (!v) return {};
  return { [YORK_APP_VERSION_HEADER]: v };
}
