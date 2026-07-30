import {
  guessMimeFromFilename,
  isImageExtension,
  resolveImageMimeType,
} from './attachment-preview';

export type ComposerImage = {
  url: string;
  base64: string;
  mediaType: string;
};

export type SelectedFileInfo = {
  path: string;
  name: string;
  size: number;
  mimeType: string;
  dataUrl?: string;
};

function dataUrlToBlob(dataUrl: string): { blob: Blob; base64: string; mimeType: string } {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) {
    throw new Error('Invalid data URL');
  }
  const header = dataUrl.slice(0, comma);
  const base64 = dataUrl.slice(comma + 1);
  const mimeType = /data:([^;]+)/.exec(header)?.[1] || 'application/octet-stream';
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return { blob: new Blob([bytes], { type: mimeType }), base64, mimeType };
}

async function composerImageFromDataUrl(
  dataUrl: string,
  fileName: string,
  resizeImageIfNeeded: (blob: Blob) => Promise<Blob>,
  blobToBase64: (blob: Blob) => Promise<string>
): Promise<ComposerImage> {
  const { blob } = dataUrlToBlob(dataUrl);
  const resizedBlob = await resizeImageIfNeeded(blob);
  const base64 = await blobToBase64(resizedBlob);
  const mediaType =
    resolveImageMimeType({
      filename: fileName,
      mimeType: resizedBlob.type || blob.type,
    }) || 'image/jpeg';

  return {
    url: URL.createObjectURL(resizedBlob),
    base64,
    mediaType,
  };
}

/** Load a local image path into composer image state (thumbnail + base64). */
export async function loadComposerImageFromPath(
  filePath: string,
  fileName: string,
  resizeImageIfNeeded: (blob: Blob) => Promise<Blob>,
  blobToBase64: (blob: Blob) => Promise<string>,
  dataUrl?: string
): Promise<ComposerImage | null> {
  if (!isImageExtension(fileName)) {
    return null;
  }

  try {
    if (dataUrl) {
      return await composerImageFromDataUrl(dataUrl, fileName, resizeImageIfNeeded, blobToBase64);
    }

    const api = window.electronAPI?.files?.readAsDataUrl;
    if (!api) {
      console.warn('[attachments] files.readAsDataUrl is unavailable');
      return null;
    }

    const result = await api(filePath);
    if (!result.success || !result.dataUrl) {
      console.warn('[attachments] readAsDataUrl failed:', result.error);
      return null;
    }

    return await composerImageFromDataUrl(
      result.dataUrl,
      fileName,
      resizeImageIfNeeded,
      blobToBase64
    );
  } catch (err) {
    console.error('[attachments] Failed to process local image:', err);
    return null;
  }
}

export function isBrowserFileImage(file: File): boolean {
  if (file.type.startsWith('image/')) {
    return true;
  }
  return isImageExtension(file.name);
}

export function mimeForAttachedFile(fileName: string, fallbackType?: string): string {
  if (fallbackType && fallbackType !== 'application/octet-stream') {
    return fallbackType;
  }
  return guessMimeFromFilename(fileName);
}

/** Normalize selectFiles IPC results (supports legacy string[] during hot reload). */
export function normalizeSelectedFiles(
  selected: Array<string | SelectedFileInfo>
): SelectedFileInfo[] {
  return selected.map((item) => {
    if (typeof item === 'string') {
      const name = item.split(/[/\\]/).pop() || 'unknown';
      return {
        path: item,
        name,
        size: 0,
        mimeType: guessMimeFromFilename(name),
      };
    }
    return item;
  });
}
