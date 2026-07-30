import { useEffect, useState, memo } from 'react';
import { useAppStore } from '../../store';
import type { FileAttachmentContent, Message } from '../../types';
import { resolvePathAgainstWorkspace } from '../../../shared/workspace-path';
import { isPreviewableImage, resolveImageMimeType } from '../../utils/attachment-preview';
import { AttachmentImageThumb, FileAttachmentChip } from '../attachments';

interface FileAttachmentBlockProps {
  block: FileAttachmentContent;
  isUser: boolean;
  message?: Message;
}

export const FileAttachmentBlock = memo(function FileAttachmentBlock({
  block,
  isUser,
  message,
}: FileAttachmentBlockProps) {
  const cwd = useAppStore((s) => {
    if (!message?.sessionId) return undefined;
    return s.sessions.find((session) => session.id === message.sessionId)?.cwd;
  });

  const mimeType =
    resolveImageMimeType({
      filename: block.filename,
      mimeType: block.mimeType,
    }) ?? block.mimeType;

  const canBeImage = isPreviewableImage({
    filename: block.filename,
    mimeType,
  });

  const initialSrc =
    canBeImage && mimeType && block.inlineDataBase64
      ? `data:${mimeType};base64,${block.inlineDataBase64}`
      : null;

  const [previewSrc, setPreviewSrc] = useState<string | null>(initialSrc);

  useEffect(() => {
    if (previewSrc || !canBeImage) return;

    let cancelled = false;
    const load = async () => {
      const relativeOrAbsolute = (block.relativePath || '').trim();
      if (!relativeOrAbsolute || !window.electronAPI?.files?.readAsDataUrl) {
        return;
      }
      const absolutePath = resolvePathAgainstWorkspace(relativeOrAbsolute, cwd);
      try {
        const result = await window.electronAPI.files.readAsDataUrl(absolutePath);
        if (!cancelled && result.success && result.dataUrl) {
          setPreviewSrc(result.dataUrl);
        }
      } catch (err) {
        console.warn('[FileAttachmentBlock] preview load failed:', err);
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [previewSrc, canBeImage, block.relativePath, cwd]);

  if (previewSrc) {
    return (
      <div className={`${isUser ? 'inline-block' : ''}`}>
        <AttachmentImageThumb src={previewSrc} alt={block.filename} />
      </div>
    );
  }

  return <FileAttachmentChip filename={block.filename} />;
});
