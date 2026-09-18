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

export async function uploadFileToHubStorage(input: {
  filePath: string;
  folder: string;
  fileName?: string;
}): Promise<HubStorageUploadResult> {
  const tokens = await getHubBearerTokens();
  if (tokens.length === 0) {
    throw new Error('Sign in required to upload to Hub storage');
  }

  const buffer = readFileSync(input.filePath);
  const fileName = input.fileName?.trim() || basename(input.filePath);
  const folder = input.folder.trim();
  if (!folder) throw new Error('folder is required');

  const base = authConfig.hubApiUrl.replace(/\/$/, '');
  const url = `${base}/api/storage/upload`;

  const boundary = `----YorkHubUpload${Date.now()}`;
  const chunks: Buffer[] = [];
  const ext = fileName.includes('.') ? fileName.split('.').pop()?.toLowerCase() : '';
  const contentType =
    ext === 'html'
      ? 'text/html'
      : ext === 'md'
        ? 'text/markdown'
        : 'application/octet-stream';

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
    return { s3Key, url: signedUrl };
  }

  throw new Error('Hub storage upload failed');
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

export async function downloadHubObjectToBuffer(s3Key: string): Promise<Buffer> {
  const signedUrl = await fetchHubPresignedGetUrl(s3Key);
  const tokens = await getHubBearerTokens();
  const authAttempts: (string | undefined)[] = [undefined, ...tokens];
  for (const token of authAttempts) {
    const headers: Record<string, string> = { Accept: '*/*' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await hubHttpRequest(signedUrl, { headers, timeoutMs: 60_000 });
    if (!res.ok) continue;
    const buf = await res.arrayBuffer();
    return Buffer.from(buf);
  }
  throw new Error('Failed to download shared document from Hub');
}
