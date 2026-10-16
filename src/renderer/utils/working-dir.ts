/** Strip trailing separators so `/a/b` and `/a/b/` compare as the same folder. */
export function normalizeWorkingDir(path: string): string {
  const unified = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return unified || '/';
}

export function isSameWorkingDir(
  left: string | null | undefined,
  right: string | null | undefined
): boolean {
  if (!left || !right) return false;
  return normalizeWorkingDir(left) === normalizeWorkingDir(right);
}

/** True when the composer is using a folder the user picked, not the app default. */
export function isCustomWorkingDir(
  current: string | null | undefined,
  fallback: string | null | undefined
): boolean {
  if (!current) return false;
  if (!fallback) return true;
  return !isSameWorkingDir(current, fallback);
}

export function workingDirLabel(path: string): string {
  const parts = normalizeWorkingDir(path).split('/').filter(Boolean);
  return parts[parts.length - 1] || path;
}
