const DEFAULT_EXPIRY_BUFFER = 60;

export function getTokenPayload(token: string | null | undefined): { exp?: number } | null {
  if (!token || typeof token !== 'string') return null;
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = parts[1];
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const json = decodeURIComponent(
      atob(base64)
        .split('')
        .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
        .join('')
    );
    return JSON.parse(json) as { exp?: number };
  } catch {
    return null;
  }
}

export function isTokenExpired(
  token: string | null | undefined,
  bufferSec = DEFAULT_EXPIRY_BUFFER
): boolean {
  if (!token) return true;
  const payload = getTokenPayload(token);
  if (!payload || typeof payload.exp !== 'number') return true;
  const nowSeconds = Math.floor(Date.now() / 1000);
  return payload.exp <= nowSeconds + bufferSec;
}

export function isTokenExpiringSoon(
  token: string | null | undefined,
  bufferSeconds = 5 * 60
): boolean {
  const payload = getTokenPayload(token);
  if (!payload || typeof payload.exp !== 'number') return false;
  const nowSeconds = Math.floor(Date.now() / 1000);
  return payload.exp <= nowSeconds + bufferSeconds;
}
