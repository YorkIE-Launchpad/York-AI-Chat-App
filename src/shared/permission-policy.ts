/**
 * Shared permission-ask policy (local dialog + remote gateway).
 */

/** How long a permission Ask dialog waits before auto-expiring. */
export const PERMISSION_ASK_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * How long the local permission dialog waits before auto-approving.
 * Must stay well below the agent's idle timeout so an unanswered ask
 * doesn't abort the whole turn.
 */
export const PERMISSION_AUTO_APPROVE_MS = 60 * 1000;

const PREVIEW_MAX_CHARS = 2000;

/**
 * Build a compact preview of tool input for the permission dialog.
 * Keeps path/file fields and summarizes large string payloads (e.g. Write content).
 */
export function truncatePermissionInputPreview(
  input: Record<string, unknown>,
  maxChars: number = PREVIEW_MAX_CHARS
): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'string') {
      const lower = key.toLowerCase();
      const isPathLike =
        lower === 'path' ||
        lower === 'file_path' ||
        lower === 'filepath' ||
        lower === 'file' ||
        lower.endsWith('_path');

      if (isPathLike) {
        out[key] = value;
        continue;
      }

      if (value.length > maxChars) {
        out[key] = `${value.slice(0, maxChars)}…`;
        out[`${key}_truncated`] = true;
        out[`${key}_length`] = value.length;
      } else {
        out[key] = value;
      }
      continue;
    }

    if (value !== null && typeof value === 'object') {
      try {
        const serialized = JSON.stringify(value);
        if (serialized.length > maxChars) {
          out[key] = `${serialized.slice(0, maxChars)}…`;
          out[`${key}_truncated`] = true;
          out[`${key}_length`] = serialized.length;
        } else {
          out[key] = value;
        }
      } catch {
        out[key] = '[unserializable]';
      }
      continue;
    }

    out[key] = value;
  }

  return out;
}

/**
 * Applies user edits from the approval dialog onto the tool input in place (the agent
 * executes with this same object). Only string fields that already exist — top level or
 * one object level deep — may change, so edits can never add arguments or change types.
 */
export function applyPermissionEdits(
  input: Record<string, unknown>,
  edits: Record<string, unknown>
): void {
  for (const [key, value] of Object.entries(edits)) {
    const current = input[key];
    if (typeof current === 'string' && typeof value === 'string') {
      input[key] = value;
    } else if (
      current &&
      typeof current === 'object' &&
      !Array.isArray(current) &&
      value &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      const nested = current as Record<string, unknown>;
      for (const [nestedKey, nestedValue] of Object.entries(value as Record<string, unknown>)) {
        if (typeof nested[nestedKey] === 'string' && typeof nestedValue === 'string') {
          nested[nestedKey] = nestedValue;
        }
      }
    }
  }
}
