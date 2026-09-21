import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { authConfig } from '../../shared/auth-config';
import { extractPresignedUrlFromBody } from '../auth/avatar-proxy';
import { ensureAuthenticatedSession } from '../auth/session';
import { hubHttpRequest } from '../auth/hub-http';

export function sharedDocHubFolder(docId: string): string {
  const id = docId.trim();
  return `guild-collaboration/york-shared-docs/${id}`;
}

function uniqueTokens(bearerTokens: string[]): string[] {
  return [...new Set(bearerTokens.map((t) => t.trim()).filter(Boolean))];
}

async function getHubBearerTokens(): Promise<string[]> {
  const session = await ensureAuthenticatedSession();
  return uniqueTokens([session.accessToken, session.idToken]);
}

export interface HubStorageUploadResult {
  s3Key: string;
  url: string;
  lastModified: string;
}

function extractS3KeyFromBody(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const root = body as Record<string, unknown>;
  const data =
    root.data != null && typeof root.data === 'object'
      ? (root.data as Record<string, unknown>)
      : null;
  for (const candidate of [root.s3Key, data?.s3Key]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return null;
}

function extractLastModifiedFromBody(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const root = body as Record<string, unknown>;
  const data =
    root.data != null && typeof root.data === 'object'
      ? (root.data as Record<string, unknown>)
      : null;
  for (const candidate of [
    root.lastModified,
    root.LastModified,
    data?.lastModified,
    data?.LastModified,
  ]) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return new Date(candidate.trim()).toISOString();
    }
  }
  return null;
}

function lastModifiedFromHttpDate(value: string | null): string | null {
  if (!value?.trim()) return null;
  const parsed = Date.parse(value.trim());
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toISOString();
}

export async function fetchHubObjectLastModified(s3Key: string): Promise<string> {
  const signedUrl = await fetchHubPresignedGetUrl(s3Key);
  const tokens = await getHubBearerTokens();
  const authAttempts: (string | undefined)[] = [undefined, ...tokens];
  for (const token of authAttempts) {
    const headers: Record<string, string> = { Accept: '*/*' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await hubHttpRequest(signedUrl, {
      method: 'HEAD',
      headers,
      timeoutMs: 12_000,
    });
    if (!res.ok) continue;
    const fromHeader = lastModifiedFromHttpDate(res.header('last-modified') ?? null);
    if (fromHeader) return fromHeader;
  }
  return new Date().toISOString();
}

function contentTypeForFileName(fileName: string, override?: string): string {
  if (override?.trim()) return override.trim();
  const ext = fileName.includes('.') ? fileName.split('.').pop()?.toLowerCase() : '';
  if (ext === 'html') return 'text/html';
  if (ext === 'md') return 'text/markdown';
  if (ext === 'json') return 'application/json';
  return 'application/octet-stream';
}

async function uploadHubStorageBuffer(input: {
  buffer: Buffer;
  folder: string;
  fileName: string;
  contentType?: string;
}): Promise<HubStorageUploadResult> {
  const tokens = await getHubBearerTokens();
  if (tokens.length === 0) {
    throw new Error('Sign in required to upload to Hub storage');
  }

  const buffer = input.buffer;
  const fileName = input.fileName.trim();
  const folder = input.folder.trim();
  if (!folder) throw new Error('folder is required');
  if (!fileName) throw new Error('fileName is required');

  const base = authConfig.hubApiUrl.replace(/\/$/, '');
  const url = `${base}/api/storage/upload`;

  const boundary = `----YorkHubUpload${Date.now()}`;
  const chunks: Buffer[] = [];
  const contentType = contentTypeForFileName(fileName, input.contentType);

  chunks.push(Buffer.from(`--${boundary}\r\n`));
  chunks.push(
    Buffer.from(
      `Content-Disposition: form-data; name="folder"\r\n\r\n${folder}\r\n`
    )
  );
  chunks.push(Buffer.from(`--${boundary}\r\n`));
  chunks.push(
    Buffer.from(
      `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${contentType}\r\n\r\n`
    )
  );
  chunks.push(buffer);
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));

  const body = Buffer.concat(chunks);

  for (const token of tokens) {
    const res = await hubHttpRequest(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
      timeoutMs: 60_000,
    });
    if (!res.ok) continue;
    const json = await res.json<unknown>();
    const s3Key = extractS3KeyFromBody(json);
    if (!s3Key) continue;
    const signedUrl = extractPresignedUrlFromBody(json) ?? '';
    const fromBody = extractLastModifiedFromBody(json);
    const lastModified = fromBody ?? (await fetchHubObjectLastModified(s3Key));
    return { s3Key, url: signedUrl, lastModified };
  }

  throw new Error('Hub storage upload failed');
}

export async function uploadBufferToHubStorage(input: {
  buffer: Buffer;
  folder: string;
  fileName: string;
  contentType?: string;
}): Promise<HubStorageUploadResult> {
  return uploadHubStorageBuffer(input);
}

export async function uploadFileToHubStorage(input: {
  filePath: string;
  folder: string;
  fileName?: string;
}): Promise<HubStorageUploadResult> {
  const buffer = readFileSync(input.filePath);
  const fileName = input.fileName?.trim() || basename(input.filePath);
  return uploadHubStorageBuffer({ buffer, folder: input.folder, fileName });
}

export async function fetchHubPresignedGetUrl(s3Key: string): Promise<string> {
  const tokens = await getHubBearerTokens();
  const base = authConfig.hubApiUrl.replace(/\/$/, '');
  const url = new URL(`${base}/api/storage/presigned-url`);
  url.searchParams.set('key', s3Key);
  url.searchParams.set('expiresIn', '3600');

  for (const token of tokens) {
    const res = await hubHttpRequest(url.toString(), {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      timeoutMs: 12_000,
    });
    if (!res.ok) continue;
    const body = await res.json<unknown>();
    const signed = extractPresignedUrlFromBody(body);
    if (signed) return signed;
  }
  throw new Error('Could not presign Hub object');
}

export async function downloadHubObjectToBuffer(
  s3Key: string
): Promise<{ buffer: Buffer; lastModified: string }> {
  const signedUrl = await fetchHubPresignedGetUrl(s3Key);
  const tokens = await getHubBearerTokens();
  const authAttempts: (string | undefined)[] = [undefined, ...tokens];
  for (const token of authAttempts) {
    const headers: Record<string, string> = { Accept: '*/*' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await hubHttpRequest(signedUrl, { headers, timeoutMs: 60_000 });
    if (!res.ok) continue;
    const buf = await res.arrayBuffer();
    const fromHeader = lastModifiedFromHttpDate(res.header('last-modified') ?? null);
    const lastModified = fromHeader ?? (await fetchHubObjectLastModified(s3Key));
    return { buffer: Buffer.from(buf), lastModified };
  }
  throw new Error('Failed to download shared document from Hub');
}

export function isRemoteS3Newer(remoteIso: string, localIso: string): boolean {
  const remoteMs = Date.parse(remoteIso);
  const localMs = Date.parse(localIso);
  if (Number.isNaN(remoteMs)) return false;
  if (Number.isNaN(localMs) || !localIso.trim()) return Boolean(remoteIso.trim());
  return remoteMs > localMs;
}
