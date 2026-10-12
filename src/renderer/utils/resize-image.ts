/** Resize and compress an image so its base64 stays under the 5MB model limit. */
export async function resizeImageIfNeeded(blob: Blob): Promise<Blob> {
  // Claude API limit is 5MB for base64 encoded images
  // Base64 encoding increases size by ~33%, so we target 3.75MB for the blob
  const MAX_BLOB_SIZE = 3.75 * 1024 * 1024; // 3.75MB

  if (blob.size <= MAX_BLOB_SIZE) {
    return blob; // No need to resize
  }

  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(blob);

    img.onload = () => {
      URL.revokeObjectURL(url);

      // Calculate scaling factor to reduce file size
      // We use a more aggressive approach: scale down until size is acceptable
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Failed to get canvas context'));
        return;
      }

      // Start with a scale factor based on size ratio
      const scale = Math.sqrt(MAX_BLOB_SIZE / blob.size);
      const quality = 0.9;

      const attemptCompress = (currentScale: number, currentQuality: number): Promise<Blob> => {
        canvas.width = Math.floor(img.width * currentScale);
        canvas.height = Math.floor(img.height * currentScale);

        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

        return new Promise((resolveBlob) => {
          canvas.toBlob(
            (compressedBlob) => {
              if (!compressedBlob) {
                reject(new Error('Failed to compress image'));
                return;
              }

              // If still too large, try again with lower quality or scale
              if (
                compressedBlob.size > MAX_BLOB_SIZE &&
                (currentQuality > 0.5 || currentScale > 0.3)
              ) {
                const newQuality = Math.max(0.5, currentQuality - 0.1);
                const newScale = currentQuality <= 0.5 ? currentScale * 0.9 : currentScale;
                attemptCompress(newScale, newQuality).then(resolveBlob);
              } else {
                resolveBlob(compressedBlob);
              }
            },
            blob.type || 'image/jpeg',
            currentQuality
          );
        });
      };

      attemptCompress(scale, quality).then(resolve).catch(reject);
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to load image'));
    };

    img.src = url;
  });
}
