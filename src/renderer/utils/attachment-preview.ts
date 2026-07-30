const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

const ALLOWED_IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

const EXTENSION_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
  txt: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
  zip: 'application/zip',
};

export function getFileExtension(filename: string): string {
  const normalized = filename.trim().toLowerCase();
  const lastDot = normalized.lastIndexOf('.');
  if (lastDot === -1 || lastDot === normalized.length - 1) {
    return '';
  }
  return normalized.slice(lastDot + 1);
}

export function guessMimeFromFilename(filename: string): string {
  const ext = getFileExtension(filename);
  return EXTENSION_MIME[ext] ?? 'application/octet-stream';
}

export function isImageExtension(filename: string): boolean {
  return IMAGE_EXTENSIONS.has(getFileExtension(filename));
}

export function isAllowedImageMimeType(mimeType: string | undefined): boolean {
  return Boolean(mimeType && ALLOWED_IMAGE_MIME_TYPES.has(mimeType));
}

/** True when we can render a photo thumbnail (mime and/or filename). */
export function isPreviewableImage(opts: { filename?: string; mimeType?: string }): boolean {
  if (isAllowedImageMimeType(opts.mimeType)) {
    return true;
  }
  if (opts.filename && isImageExtension(opts.filename)) {
    return true;
  }
  return false;
}

export function resolveImageMimeType(opts: {
  filename?: string;
  mimeType?: string;
}): 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' | null {
  if (isAllowedImageMimeType(opts.mimeType)) {
    return opts.mimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  }
  if (!opts.filename) return null;
  const guessed = guessMimeFromFilename(opts.filename);
  if (isAllowedImageMimeType(guessed)) {
    return guessed as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  }
  return null;
}

export { ALLOWED_IMAGE_MIME_TYPES };
