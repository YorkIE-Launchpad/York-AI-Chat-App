import { normalizeProfileImageUrl } from './hub-parse';

const cache = new Map<string, { dataUrl: string; expiresAt: number }>();
const CACHE_TTL_MS = 60 * 60 * 1000;

async function fetchImageBuffer(
  imageUrl: string,
  bearerTokens: string[]
): Promise<{ buffer: Buffer; contentType: string } | null> {
  const tokens = [...new Set(bearerTokens.map((t) => t.trim()).filter(Boolean))];
  const authAttempts: (string | undefined)[] = [undefined, ...tokens];

  for (const token of authAttempts) {
    const headers: Record<string, string> = { Accept: 'image/*,*/*' };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    try {
      const res = await fetch(imageUrl, { headers });
      if (!res.ok) continue;
      const contentType = res.headers.get('content-type')?.split(';')[0]?.trim() || '';
      if (!contentType.startsWith('image/')) continue;
      const buffer = Buffer.from(await res.arrayBuffer());
      return { buffer, contentType };
    } catch {
      // try next auth mode
    }
  }
  return null;
}

export async function resolveAvatarDataUrl(
  imageUrl: string,
  bearerTokens: string | string[] | null
): Promise<string | null> {
  const normalized = normalizeProfileImageUrl(imageUrl);
  const cached = cache.get(normalized);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.dataUrl;
  }

  const tokens =
    bearerTokens == null ? [] : Array.isArray(bearerTokens) ? bearerTokens : [bearerTokens];
  const fetched = await fetchImageBuffer(normalized, tokens);
  if (!fetched) return null;

  const dataUrl = `data:${fetched.contentType};base64,${fetched.buffer.toString('base64')}`;
  cache.set(normalized, { dataUrl, expiresAt: Date.now() + CACHE_TTL_MS });
  return dataUrl;
}
