import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../store';
import type { ExternalReferenceContent } from '../../../shared/external-reference';
import { parseExternalReferenceUrl } from '../../../shared/external-reference-urls';
import { isImageExtension } from '../../utils/attachment-preview';
import {
  isBrowserFileImage,
  loadComposerImageFromPath,
  mimeForAttachedFile,
  normalizeSelectedFiles,
} from '../../utils/load-composer-image';
import { resizeImageIfNeeded } from '../../utils/resize-image';
import type { AttachedMeeting } from '../MeetingPicker';
import type { ComposerImage } from './ComposerAttachments';

export type AttachedFile = {
  name: string;
  path: string;
  size: number;
  type: string;
  inlineDataBase64?: string;
};

/** Images, files, meetings and tool references attached to the next message. */
export function useComposerAttachments(isElectron: boolean) {
  const { t } = useTranslation();
  const setGlobalNotice = useAppStore((s) => s.setGlobalNotice);
  const [pastedImages, setPastedImages] = useState<ComposerImage[]>([]);
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
  const [attachedMeetings, setAttachedMeetings] = useState<AttachedMeeting[]>([]);
  const [attachedReferences, setAttachedReferences] = useState<ExternalReferenceContent[]>([]);
  const [isDragging, setIsDragging] = useState(false);

  // Handle paste event for images
  const handlePaste = async (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    const pastedText = e.clipboardData?.getData('text/plain')?.trim() ?? '';
    const parsedRef = pastedText ? parseExternalReferenceUrl(pastedText) : null;
    const imageItems = items
      ? Array.from(items).filter((item) => item.type.startsWith('image/'))
      : [];

    if (parsedRef && imageItems.length === 0) {
      e.preventDefault();
      try {
        const lookedUp = window.electronAPI?.references?.lookupUrl
          ? await window.electronAPI.references.lookupUrl(pastedText)
          : null;
        const next: ExternalReferenceContent = lookedUp
          ? {
              type: 'external_reference',
              source: lookedUp.source,
              externalId: lookedUp.externalId,
              title: lookedUp.title,
              url: lookedUp.url,
              subtitle: lookedUp.subtitle,
              meta: lookedUp.meta,
            }
          : {
              type: 'external_reference',
              source: parsedRef.source,
              externalId: parsedRef.externalId,
              title: parsedRef.title || parsedRef.externalId,
              url: parsedRef.url,
              subtitle: parsedRef.subtitle,
              meta: parsedRef.meta,
            };
        setAttachedReferences((prev) =>
          prev.some((item) => item.source === next.source && item.externalId === next.externalId)
            ? prev
            : [...prev, next]
        );
      } catch {
        setAttachedReferences((prev) =>
          prev.some(
            (item) => item.source === parsedRef.source && item.externalId === parsedRef.externalId
          )
            ? prev
            : [
                ...prev,
                {
                  type: 'external_reference',
                  source: parsedRef.source,
                  externalId: parsedRef.externalId,
                  title: parsedRef.title || parsedRef.externalId,
                  url: parsedRef.url,
                  subtitle: parsedRef.subtitle,
                  meta: parsedRef.meta,
                },
              ]
        );
      }
      return;
    }

    if (!items) return;

    if (imageItems.length === 0) return;

    e.preventDefault();

    const newImages: Array<{ url: string; base64: string; mediaType: string }> = [];

    for (const item of imageItems) {
      const blob = item.getAsFile();
      if (!blob) continue;

      try {
        // Resize if needed to stay under API limit
        const resizedBlob = await resizeImageIfNeeded(blob);
        const base64 = await blobToBase64(resizedBlob);
        const url = URL.createObjectURL(resizedBlob);
        newImages.push({
          url,
          base64,
          mediaType: resizedBlob.type as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
        });
      } catch (err) {
        // Notify the user instead of silently dropping the error
        setGlobalNotice({
          id: `image-paste-failed-${Date.now()}`,
          type: 'warning',
          message: t('chat.imageProcessFailed'),
        });
      }
    }

    setPastedImages((prev) => [...prev, ...newImages]);
  };

  const blobToBase64 = (blob: Blob): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const result = reader.result;
        if (typeof result !== 'string') {
          reject(new Error('FileReader result is not a string'));
          return;
        }
        // Remove data URL prefix (e.g., "data:image/png;base64,")
        const parts = result.split(',');
        resolve(parts[1] || '');
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  };

  const removeImage = (index: number) => {
    setPastedImages((prev) => {
      const updated = [...prev];
      URL.revokeObjectURL(updated[index].url);
      updated.splice(index, 1);
      return updated;
    });
  };

  const removeFile = (index: number) => {
    setAttachedFiles((prev) => {
      const updated = [...prev];
      updated.splice(index, 1);
      return updated;
    });
  };

  const handleFileSelect = async () => {
    if (!isElectron || !window.electronAPI) {
      console.log('[ChatView] Not in Electron, file selection not available');
      return;
    }

    try {
      const selected = normalizeSelectedFiles(await window.electronAPI.selectFiles());
      if (selected.length === 0) return;

      const newFiles: AttachedFile[] = [];
      const newImages: Array<{ url: string; base64: string; mediaType: string }> = [];

      for (const file of selected) {
        if (isImageExtension(file.name)) {
          const image = await loadComposerImageFromPath(
            file.path,
            file.name,
            resizeImageIfNeeded,
            blobToBase64,
            file.dataUrl
          );
          if (image) {
            newImages.push(image);
            continue;
          }
        }

        newFiles.push({
          name: file.name,
          path: file.path,
          size: file.size,
          type: mimeForAttachedFile(file.name, file.mimeType),
        });
      }

      if (newImages.length > 0) {
        setPastedImages((prev) => [...prev, ...newImages]);
      }
      if (newFiles.length > 0) {
        setAttachedFiles((prev) => [...prev, ...newFiles]);
      }
    } catch (error) {
      console.error('[ChatView] Error selecting files:', error);
    }
  };

  // Handle drag and drop for images
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const files = Array.from(e.dataTransfer.files);
    const imageFiles = files.filter((file) => isBrowserFileImage(file));
    const otherFiles = files.filter((file) => !isBrowserFileImage(file));

    // Process images
    if (imageFiles.length > 0) {
      const newImages: Array<{ url: string; base64: string; mediaType: string }> = [];

      for (const file of imageFiles) {
        try {
          // Resize if needed to stay under API limit
          const resizedBlob = await resizeImageIfNeeded(file);
          const base64 = await blobToBase64(resizedBlob);
          const url = URL.createObjectURL(resizedBlob);
          newImages.push({
            url,
            base64,
            mediaType: resizedBlob.type || mimeForAttachedFile(file.name, file.type),
          });
        } catch (err) {
          // Notify the user instead of silently dropping the error
          setGlobalNotice({
            id: `image-drop-failed-${Date.now()}`,
            type: 'warning',
            message: t('chat.imageProcessFailed'),
          });
        }
      }

      setPastedImages((prev) => [...prev, ...newImages]);
    }

    // Process other files
    if (otherFiles.length > 0) {
      const newFiles = await Promise.all(
        otherFiles.map(async (file) => {
          const droppedPath = 'path' in file && typeof file.path === 'string' ? file.path : '';
          const inlineDataBase64 = droppedPath ? undefined : await blobToBase64(file);

          return {
            name: file.name,
            path: droppedPath,
            size: file.size,
            type: mimeForAttachedFile(file.name, file.type),
            inlineDataBase64,
          };
        })
      );

      setAttachedFiles((prev) => [...prev, ...newFiles]);
    }
  };

  return {
    pastedImages,
    setPastedImages,
    attachedFiles,
    setAttachedFiles,
    attachedMeetings,
    setAttachedMeetings,
    attachedReferences,
    setAttachedReferences,
    isDragging,
    blobToBase64,
    handlePaste,
    handleFileSelect,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    removeImage,
    removeFile,
  };
}
