import { authConfig } from '../../shared/auth-config';
import { extractHubDocumentS3Key, normalizeProfileImageUrl } from './hub-parse';

const cache = new Map<string, { dataUrl: string; expiresAt: number }>();
const CACHE_TTL_MS = 60 * 60 * 1000;
const PRESIGN_EXPIRES_SEC = 3600;

/** Test helper — clears the in-memory avatar data-URL cache. */
export function clearAvatarCache(): void {
  cache.clear();
}

function uniqueTokens(bearerTokens: string[]): string[] {
  return [...new Set(bearerTokens.map((t) => t.trim()).filter(Boolean))];
}

export function extractPresignedUrlFromBody(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const root = body as Record<string, unknown>;
  const data =
    root.data != null && typeof root.data === 'object'
      ? (root.data as Record<string, unknown>)
      : null;

  const candidates = [root.url, data?.url];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }
  return null;
}

async function fetchHubPresignedUrl(s3Key: string, bearerTokens: string[]): Promise<string | null> {
  const tokens = uniqueTokens(bearerTokens);
  if (tokens.length === 0) return null;

  const base = authConfig.hubApiUrl.replace(/\/$/, '');
  const url = new URL(`${base}/api/storage/presigned-url`);
  url.searchParams.set('key', s3Key);
  url.searchParams.set('expiresIn', String(PRESIGN_EXPIRES_SEC));

  for (const token of tokens) {
    try {
      const res = await fetch(url.toString(), {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
      });
      if (!res.ok) continue;
      const body = (await res.json()) as unknown;
      const signed = extractPresignedUrlFromBody(body);
      if (signed) return signed;
    } catch {
      // try next token
    }
  }
  return null;
}

async function fetchImageBuffer(
  imageUrl: string,
  bearerTokens: string[]
): Promise<{ buffer: Buffer; contentType: string } | null> {
  const tokens = uniqueTokens(bearerTokens);
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

  const s3Key = extractHubDocumentS3Key(normalized) ?? extractHubDocumentS3Key(imageUrl);
  let fetchUrl = normalized;
  if (s3Key) {
    const signed = await fetchHubPresignedUrl(s3Key, tokens);
    if (!signed) return null;
    fetchUrl = signed;
  }

  // Signed S3 URLs need no auth; pass empty tokens for that hop.
  const fetched = await fetchImageBuffer(fetchUrl, s3Key ? [] : tokens);
  if (!fetched) return null;

  const dataUrl = `data:${fetched.contentType};base64,${fetched.buffer.toString('base64')}`;
  cache.set(normalized, { dataUrl, expiresAt: Date.now() + CACHE_TTL_MS });
  return dataUrl;
}
