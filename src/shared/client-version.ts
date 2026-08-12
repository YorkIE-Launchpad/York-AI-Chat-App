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

/** Shown when backend rejects requests with HTTP 426 (client too old). */
export const CLIENT_OUTDATED_USER_MESSAGE =
  'Please update York IE GrowthOS to continue. A newer version is required to use AI features.';

export const CLIENT_OUTDATED_UPDATE_HINT =
  'Use Check for updates below, then Restart to update when ready.';

export function parseClientOutdatedPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  if (record.error === 'client_outdated' && typeof record.message === 'string') {
    const message = record.message.trim();
    return message || null;
  }
  return null;
}

/** True when an error string looks like the backend min-version gate (HTTP 426). */
export function isClientOutdatedError(errorText: string): boolean {
  if (!errorText) return false;
  const lower = errorText.toLowerCase();
  return (
    /\b426\b/.test(errorText) ||
    lower.includes('client_outdated') ||
    lower.includes('please update york ie growthos')
  );
}

function extractClientOutdatedMessageFromText(errorText: string): string | null {
  const jsonMatch = errorText.match(/\{[\s\S]*"error"\s*:\s*"client_outdated"[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const message = parseClientOutdatedPayload(JSON.parse(jsonMatch[0]));
      if (message) return message;
    } catch {
      // ignore malformed JSON fragments
    }
  }

  const pleaseUpdate = errorText.match(/Please update York IE GrowthOS[^.]*(?:\.|$)/i);
  if (pleaseUpdate) return pleaseUpdate[0].trim();

  return null;
}

/** Best user-facing copy for a 426 / client_outdated error string. */
export function resolveClientOutdatedUserMessage(errorText: string): string {
  return extractClientOutdatedMessageFromText(errorText) || CLIENT_OUTDATED_USER_MESSAGE;
}

/** Resolve 426 response bodies from direct backend fetch calls. */
export function resolveClientOutdatedFromHttpResponse(
  status: number,
  payload: unknown,
  rawText?: string
): string | null {
  if (status !== 426) return null;
  const fromPayload = parseClientOutdatedPayload(payload);
  if (fromPayload) return fromPayload;
  if (rawText && isClientOutdatedError(rawText)) {
    return resolveClientOutdatedUserMessage(rawText);
  }
  return CLIENT_OUTDATED_USER_MESSAGE;
}
