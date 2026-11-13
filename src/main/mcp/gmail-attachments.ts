import { mkdir, readFile, writeFile } from 'fs/promises';
import * as path from 'path';
import { OFFICE_MIME_FORMATS, extractOfficeText } from '../utils/office-text';
import { EMPTY_PDF_TEXT_MESSAGE, extractPdfText } from '../utils/pdf-text';

export const MAX_GMAIL_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const TEXT_EXCERPT_LIMIT = 8_000;

export type GmailAttachmentRef = {
  filename: string;
  mimeType: string;
  size: number;
  attachmentId: string;
  partId: string;
};

type GmailPart = {
  partId?: unknown;
  mimeType?: unknown;
  filename?: unknown;
  headers?: unknown;
  body?: { attachmentId?: unknown; size?: unknown; data?: unknown };
  parts?: unknown;
};

function asPart(value: unknown): GmailPart | null {
  if (!value || typeof value !== 'object') return null;
  return value as GmailPart;
}

function headerValue(part: GmailPart, name: string): string {
  if (!Array.isArray(part.headers)) return '';
  for (const header of part.headers) {
    if (!header || typeof header !== 'object') continue;
    const headerName = (header as { name?: unknown }).name;
    const headerText = (header as { value?: unknown }).value;
    if (typeof headerName === 'string' && headerName.toLowerCase() === name) {
      return typeof headerText === 'string' ? headerText : '';
    }
  }
  return '';
}

function filenameFromHeader(value: string): string {
  const encoded = /filename\*\s*=\s*(?:[^']*'')?([^;]+)/i.exec(value);
  if (encoded?.[1]) {
    const raw = encoded[1].trim().replace(/^"|"$/g, '');
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  const plain = /filename\s*=\s*"([^"]+)"|filename\s*=\s*([^;\s]+)/i.exec(value);
  return (plain?.[1] || plain?.[2] || '').trim();
}

function partFilename(part: GmailPart): string {
  const direct = typeof part.filename === 'string' ? part.filename.trim() : '';
  if (direct) return direct;
  return (
    filenameFromHeader(headerValue(part, 'content-disposition')) ||
    filenameFromHeader(headerValue(part, 'content-type'))
  );
}

const MIME_EXTENSIONS: Record<string, string> = {
  'application/pdf': '.pdf',
  'application/zip': '.zip',
  'application/json': '.json',
  'text/csv': '.csv',
  'text/plain': '.txt',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
};

function fallbackFilename(part: GmailPart, mimeType: string): string {
  const partId = typeof part.partId === 'string' && part.partId ? part.partId : 'file';
  const ext = MIME_EXTENSIONS[mimeType] || '';
  return `attachment-${partId}${ext}`;
}

function isAttachmentPart(part: GmailPart, filename: string, attachmentId: string): boolean {
  const mimeType = typeof part.mimeType === 'string' ? part.mimeType : '';
  if (mimeType.startsWith('multipart/')) return false;
  const disposition = headerValue(part, 'content-disposition');
  const markedAttachment = /attachment/i.test(disposition);
  if (filename || markedAttachment) return true;
  if (!attachmentId) return false;
  return mimeType !== 'text/plain' && mimeType !== 'text/html';
}

export function listGmailAttachments(payload: unknown): GmailAttachmentRef[] {
  const found: GmailAttachmentRef[] = [];
  const seen = new Set<string>();

  const walk = (node: unknown) => {
    const part = asPart(node);
    if (!part) return;
    const children = Array.isArray(part.parts) ? part.parts : [];
    for (const child of children) walk(child);

    const mimeType = typeof part.mimeType === 'string' ? part.mimeType : 'application/octet-stream';
    const attachmentId =
      typeof part.body?.attachmentId === 'string' ? part.body.attachmentId.trim() : '';
    const filename = partFilename(part);
    if (!isAttachmentPart(part, filename, attachmentId)) return;

    const size = typeof part.body?.size === 'number' && part.body.size > 0 ? part.body.size : 0;
    const partId = typeof part.partId === 'string' ? part.partId : '';
    const key = attachmentId || `${partId}:${filename}:${size}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({
      filename: filename || fallbackFilename(part, mimeType),
      mimeType,
      size,
      attachmentId,
      partId,
    });
  };

  walk(payload);
  return found;
}

export function extractReadableBody(payload: unknown): string {
  const part = asPart(payload);
  if (!part) return '';

  const mimeType = typeof part.mimeType === 'string' ? part.mimeType : '';
  const attachmentId = typeof part.body?.attachmentId === 'string' ? part.body.attachmentId : '';
  const filename = partFilename(part);
  const children = Array.isArray(part.parts) ? part.parts : [];
  const childText = children
    .map((child) => extractReadableBody(child))
    .filter(Boolean)
    .join('\n')
    .trim();

  if (isAttachmentPart(part, filename, attachmentId)) {
    return childText;
  }

  const data = typeof part.body?.data === 'string' ? part.body.data : '';
  const own =
    data && (mimeType.startsWith('text/') || mimeType === '' || !mimeType.startsWith('multipart/'))
      ? decodeBase64Url(data).toString('utf8')
      : '';
  return [own, childText].filter(Boolean).join('\n').trim();
}

export function findInlineAttachmentData(payload: unknown, target: GmailAttachmentRef): string {
  let data = '';
  const walk = (node: unknown) => {
    if (data) return;
    const part = asPart(node);
    if (!part) return;
    const children = Array.isArray(part.parts) ? part.parts : [];
    for (const child of children) walk(child);
    const partId = typeof part.partId === 'string' ? part.partId : '';
    const attachmentId =
      typeof part.body?.attachmentId === 'string' ? part.body.attachmentId.trim() : '';
    const matchesId = target.attachmentId && attachmentId === target.attachmentId;
    const matchesPart = target.partId && partId === target.partId;
    if (!matchesId && !matchesPart) return;
    if (typeof part.body?.data === 'string' && part.body.data.trim()) {
      data = part.body.data;
    }
  };
  walk(payload);
  return data;
}

export function decodeBase64Url(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

export function safeAttachmentFilename(filename: string): string {
  const base = path.basename(filename).replace(/[/\\]/g, '').replace(/^\.+/, '').trim();
  const cleaned = base.replace(/[^\w.\- ()[\]]+/g, '_').slice(0, 180);
  return cleaned || 'attachment';
}

export function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size < 0) return 'unknown size';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export function formatAttachmentListing(attachments: GmailAttachmentRef[]): string {
  if (attachments.length === 0) return '';
  const lines = attachments.map(
    (item) =>
      `- ${item.filename} | ${item.mimeType} | ${formatBytes(item.size)} | attachment_id=${item.attachmentId || '(inline)'}`
  );
  return [
    `Attachments (${attachments.length}). Save them with download_attachment (message_id plus attachment_id, or message_id alone for every file):`,
    ...lines,
  ].join('\n');
}

export function selectAttachments(
  attachments: GmailAttachmentRef[],
  attachmentId: string,
  filename: string
): GmailAttachmentRef[] {
  if (attachmentId) {
    const match = attachments.find((item) => item.attachmentId === attachmentId);
    if (match) return [match];
    return [
      {
        filename: filename || 'attachment',
        mimeType: 'application/octet-stream',
        size: 0,
        attachmentId,
        partId: '',
      },
    ];
  }
  if (filename) {
    const needle = filename.toLowerCase();
    const matches = attachments.filter((item) => item.filename.toLowerCase() === needle);
    if (matches.length === 0) {
      const partial = attachments.filter((item) => item.filename.toLowerCase().includes(needle));
      if (partial.length > 0) return partial;
    }
    return matches;
  }
  return attachments;
}

export async function saveAttachmentFile(
  directory: string,
  filename: string,
  bytes: Buffer
): Promise<string> {
  if (bytes.length > MAX_GMAIL_ATTACHMENT_BYTES) {
    throw new Error(
      `Attachment is too large to download (limit ${MAX_GMAIL_ATTACHMENT_BYTES / 1024 / 1024} MB).`
    );
  }
  await mkdir(directory, { recursive: true });
  const safe = safeAttachmentFilename(filename);
  const ext = path.extname(safe);
  const stem = ext ? safe.slice(0, -ext.length) : safe;
  for (let i = 0; i < 100; i += 1) {
    const name = i === 0 ? safe : `${stem}-${i}${ext}`;
    const candidate = path.join(directory, name);
    try {
      await writeFile(candidate, bytes, { flag: 'wx' });
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  throw new Error('Could not choose a unique filename for the attachment.');
}

export async function excerptAttachmentText(
  filePath: string,
  mimeType: string
): Promise<string | null> {
  try {
    if (
      mimeType.startsWith('text/') ||
      mimeType === 'application/json' ||
      mimeType === 'application/xml' ||
      mimeType === 'application/javascript'
    ) {
      const text = await readFile(filePath, 'utf8');
      const trimmed = text.trim();
      return trimmed ? trimmed.slice(0, TEXT_EXCERPT_LIMIT) : null;
    }
    if (mimeType === 'application/pdf' || filePath.toLowerCase().endsWith('.pdf')) {
      const text = (await extractPdfText(filePath)).trim();
      if (!text || text === EMPTY_PDF_TEXT_MESSAGE) return null;
      return text.slice(0, TEXT_EXCERPT_LIMIT);
    }
    const office = OFFICE_MIME_FORMATS[mimeType];
    if (office) {
      const text = (await extractOfficeText(filePath, office)).trim();
      return text ? text.slice(0, TEXT_EXCERPT_LIMIT) : null;
    }
  } catch {
    return null;
  }
  return null;
}
