import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// Content split across MessageCard, message/ sub-components, and shared attachments/
function readAttachmentUiSource() {
  const messageCardPath = path.resolve(__dirname, '../src/renderer/components/MessageCard.tsx');
  const messageDir = path.resolve(__dirname, '../src/renderer/components/message');
  const attachmentsDir = path.resolve(__dirname, '../src/renderer/components/attachments');
  return [
    fs.readFileSync(messageCardPath, 'utf8'),
    ...fs.readdirSync(messageDir).map((f) => fs.readFileSync(path.join(messageDir, f), 'utf8')),
    ...fs
      .readdirSync(attachmentsDir)
      .map((f) => fs.readFileSync(path.join(attachmentsDir, f), 'utf8')),
  ].join('\n');
}

describe('message card file attachment layout', () => {
  it('keeps user bubble shrinkable in flex layouts', () => {
    const source = readAttachmentUiSource();
    expect(source).toContain('max-w-[80%] min-w-0 break-words');
  });

  it('prevents file attachment row overflow with long filenames', () => {
    const source = readAttachmentUiSource();
    expect(source).toContain('max-w-full min-w-0');
    expect(source).toContain('overflow-hidden');
    expect(source).toContain('text-sm text-text-primary truncate');
    expect(source).toContain('FileAttachmentChip');
    expect(source).toContain('FileAttachmentBlock');
  });

  it('opens images in a fullscreen lightbox', () => {
    const source = readAttachmentUiSource();
    expect(source).toContain('ImageLightbox');
    expect(source).toContain('AttachmentImageThumb');
    expect(source).toContain("event.key === 'Escape'");
    expect(source).toContain('bg-black/90');
    expect(source).toContain('titlebar-no-drag');
  });
});
