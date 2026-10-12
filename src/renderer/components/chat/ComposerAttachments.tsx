import { Mic, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ExternalReferenceContent } from '../../../shared/external-reference';
import { AttachmentImageThumb, ExternalReferenceChip, FileAttachmentChip } from '../attachments';
import type { AttachedMeeting } from '../MeetingPicker';

export interface ComposerImage {
  url: string;
  base64: string;
  mediaType: string;
}

interface ComposerAttachmentsProps {
  images: ComposerImage[];
  files: Array<{ name: string; path: string }>;
  meetings: AttachedMeeting[];
  references: ExternalReferenceContent[];
  onRemoveImage: (index: number) => void;
  onRemoveFile: (index: number) => void;
  onRemoveMeeting: (meetingId: string) => void;
  onToggleMeetingTranscript: (meetingId: string, include: boolean) => void;
  onRemoveReference: (reference: ExternalReferenceContent) => void;
}

const removeChipButton =
  'flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-text-muted opacity-0 transition-opacity hover:bg-error/10 hover:text-error group-hover:opacity-100 focus-visible:opacity-100';

/** Everything attached to the next message, shown above the composer. */
export function ComposerAttachments({
  images,
  files,
  meetings,
  references,
  onRemoveImage,
  onRemoveFile,
  onRemoveMeeting,
  onToggleMeetingTranscript,
  onRemoveReference,
}: ComposerAttachmentsProps) {
  const { t } = useTranslation();
  if (!images.length && !files.length && !meetings.length && !references.length) return null;

  return (
    <div className="mb-2.5 space-y-2">
      {images.length > 0 ? (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          {images.map((img, index) => (
            <AttachmentImageThumb
              key={img.url || `pasted-image-${index}`}
              src={img.url}
              alt={t('common.pastedImageAlt', { index: index + 1 })}
              variant="grid"
              removeButton={
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemoveImage(index);
                  }}
                  title={t('common.removeImage')}
                  aria-label={t('common.removeImage')}
                  className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-error text-white opacity-0 transition-opacity group-hover:opacity-100"
                >
                  <X className="h-3 w-3" />
                </button>
              }
            />
          ))}
        </div>
      ) : null}

      {files.map((file, index) => (
        <FileAttachmentChip
          key={file.path || `attached-file-${index}`}
          filename={file.name}
          className="group"
          removeButton={
            <button
              type="button"
              onClick={() => onRemoveFile(index)}
              title={t('common.removeFile')}
              aria-label={t('common.removeFile')}
              className={removeChipButton}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          }
        />
      ))}

      {meetings.map((meeting) => (
        <div
          key={meeting.meetingId}
          className="group flex items-center gap-2.5 rounded-lg border border-border-subtle bg-surface px-3 py-2"
        >
          <Mic className="h-4 w-4 shrink-0 text-accent" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-medium text-text-primary">{meeting.title}</p>
            <label className="mt-0.5 flex items-center gap-1.5 text-[11px] text-text-muted">
              <input
                type="checkbox"
                checked={Boolean(meeting.includeTranscript)}
                onChange={(e) => onToggleMeetingTranscript(meeting.meetingId, e.target.checked)}
                className="h-3.5 w-3.5 accent-accent"
              />
              {t('meetings.includeTranscript')}
            </label>
          </div>
          <button
            type="button"
            onClick={() => onRemoveMeeting(meeting.meetingId)}
            title={t('common.removeMeeting')}
            aria-label={t('common.removeMeeting')}
            className={removeChipButton}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}

      {references.map((reference) => (
        <ExternalReferenceChip
          key={`${reference.source}:${reference.externalId}`}
          reference={reference}
          className="group"
          removeButton={
            <button
              type="button"
              onClick={() => onRemoveReference(reference)}
              title={t('references.remove')}
              aria-label={t('references.remove')}
              className={removeChipButton}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          }
        />
      ))}
    </div>
  );
}
