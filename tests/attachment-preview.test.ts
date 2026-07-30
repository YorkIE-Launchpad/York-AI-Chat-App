import { describe, it, expect } from 'vitest';
import {
  guessMimeFromFilename,
  isImageExtension,
  isPreviewableImage,
  resolveImageMimeType,
} from '../src/renderer/utils/attachment-preview';
import {
  isBrowserFileImage,
  normalizeSelectedFiles,
} from '../src/renderer/utils/load-composer-image';

describe('attachment-preview helpers', () => {
  it('detects image extensions', () => {
    expect(isImageExtension('photo.PNG')).toBe(true);
    expect(isImageExtension('1784714567634.jpeg')).toBe(true);
    expect(isImageExtension('doc.pdf')).toBe(false);
  });

  it('guesses mime from filename', () => {
    expect(guessMimeFromFilename('report.pdf')).toBe('application/pdf');
    expect(guessMimeFromFilename('shot.webp')).toBe('image/webp');
  });

  it('resolves previewable images from mime or extension', () => {
    expect(isPreviewableImage({ mimeType: 'image/png' })).toBe(true);
    expect(isPreviewableImage({ filename: 'a.jpg' })).toBe(true);
    expect(isPreviewableImage({ filename: 'a.pdf' })).toBe(false);
    expect(resolveImageMimeType({ filename: 'x.jpeg' })).toBe('image/jpeg');
  });
});

describe('load-composer-image helpers', () => {
  it('treats extension-only files as images', () => {
    expect(isBrowserFileImage({ name: 'shot.jpeg', type: '' } as File)).toBe(true);
    expect(isBrowserFileImage({ name: 'notes.pdf', type: '' } as File)).toBe(false);
  });

  it('normalizes legacy string selectFiles results', () => {
    expect(normalizeSelectedFiles(['/tmp/a.jpeg'])).toEqual([
      {
        path: '/tmp/a.jpeg',
        name: 'a.jpeg',
        size: 0,
        mimeType: 'image/jpeg',
      },
    ]);
  });
});
