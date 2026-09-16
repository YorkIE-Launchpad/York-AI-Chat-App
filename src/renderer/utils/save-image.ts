export interface ImageDownloadSource {
  base64: string;
  mediaType: string;
  fileName?: string;
}

export function extensionForImageMime(mediaType: string): string {
  switch (mediaType) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/webp':
      return 'webp';
    case 'image/gif':
      return 'gif';
    case 'image/png':
    default:
      return 'png';
  }
}

export function defaultImageDownloadName(mediaType: string): string {
  return `york-image-${Date.now()}.${extensionForImageMime(mediaType)}`;
}

export async function saveImageToDisk(
  source: ImageDownloadSource
): Promise<{ success: boolean; cancelled?: boolean; error?: string; path?: string }> {
  const fileName = source.fileName ?? defaultImageDownloadName(source.mediaType);
  const base64 = source.base64.trim();
  if (!base64) {
    return { success: false, error: 'Empty image data' };
  }

  if (window.electronAPI?.image?.saveToDisk) {
    return window.electronAPI.image.saveToDisk({
      base64,
      mediaType: source.mediaType,
      defaultFileName: fileName,
    });
  }

  try {
    const dataUrl = `data:${source.mediaType};base64,${base64}`;
    const anchor = document.createElement('a');
    anchor.href = dataUrl;
    anchor.download = fileName;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Download failed',
    };
  }
}
