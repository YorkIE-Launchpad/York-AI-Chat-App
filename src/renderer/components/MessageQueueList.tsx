// Compact queue list above the composer (Cursor-style).
import { useTranslation } from 'react-i18next';
import { X, ListOrdered } from 'lucide-react';
import type { Message, ContentBlock } from '../types';

interface MessageQueueListProps {
  messages: Message[];
  onRemove: (messageId: string) => void;
  onClearAll: () => void;
}

function previewText(message: Message): string {
  const blocks = Array.isArray(message.content)
    ? (message.content as ContentBlock[])
    : [{ type: 'text' as const, text: String(message.content ?? '') }];

  const text = blocks
    .filter(
      (b): b is { type: 'text'; text: string } => b.type === 'text' && typeof b.text === 'string'
    )
    .map((b) => b.text.trim())
    .filter(Boolean)
    .join(' ');

  if (text) return text;

  const attachmentCount = blocks.filter(
    (b) =>
      b.type === 'image' ||
      b.type === 'file_attachment' ||
      b.type === 'meeting_attachment' ||
      b.type === 'external_reference'
  ).length;
  if (attachmentCount > 0) {
    return attachmentCount === 1 ? 'Attachment' : `${attachmentCount} attachments`;
  }
  return '';
}

export function MessageQueueList({ messages, onRemove, onClearAll }: MessageQueueListProps) {
  const { t } = useTranslation();
  if (messages.length === 0) return null;

  return (
    <div
      className="rounded-2xl border border-border-subtle bg-surface/80 shadow-soft overflow-hidden"
      role="region"
      aria-label={t('chat.queueListAria', { count: messages.length })}
    >
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border-muted/70">
        <div className="flex items-center gap-1.5 min-w-0">
          <ListOrdered className="w-3.5 h-3.5 text-accent shrink-0" aria-hidden />
          <span className="text-[12px] font-medium text-text-secondary truncate">
            {t('chat.queueListTitle', { count: messages.length })}
          </span>
        </div>
        <button
          type="button"
          onClick={onClearAll}
          className="text-[11px] font-medium text-text-muted hover:text-text-primary transition-colors shrink-0 px-1.5 py-0.5 rounded-md hover:bg-surface-hover"
        >
          {t('chat.queueClearAll')}
        </button>
      </div>

      <ul className="max-h-40 overflow-y-auto divide-y divide-border-muted/60">
        {messages.map((message, index) => {
          const preview = previewText(message);
          return (
            <li
              key={message.id}
              className="group flex items-center gap-2.5 px-3 py-2 hover:bg-surface-hover/60 transition-colors"
            >
              <span className="w-5 h-5 rounded-md bg-accent-muted text-accent text-[11px] font-semibold flex items-center justify-center shrink-0 tabular-nums">
                {index + 1}
              </span>
              <p className="flex-1 min-w-0 text-[13px] text-text-primary truncate leading-5">
                {preview || t('messageCard.emptyMessage')}
              </p>
              <button
                type="button"
                onClick={() => onRemove(message.id)}
                className="w-6 h-6 rounded-md flex items-center justify-center text-text-muted hover:text-error hover:bg-error/10 transition-colors shrink-0 opacity-70 group-hover:opacity-100"
                title={t('chat.queueRemove')}
                aria-label={t('chat.queueRemove')}
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
