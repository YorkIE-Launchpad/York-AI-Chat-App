import { ArrowUpRight, MessageSquareText } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { MatterChatContextSummary } from '../../../shared/matter-chat';

interface ChatEmptyStateProps {
  matterContext?: MatterChatContextSummary | null;
}

/** Shown before the first message: the Today item this chat came from, or a blank-chat prompt. */
export function ChatEmptyState({ matterContext }: ChatEmptyStateProps) {
  const { t } = useTranslation();

  if (matterContext) {
    const fields = [
      { label: t('matter.chatContextWhy'), value: matterContext.whyItMatters },
      { label: t('matter.chatContextSuggested'), value: matterContext.suggestedAction },
    ].filter((f) => f.value);
    return (
      <div className="mx-auto mt-6 w-full max-w-[640px] rounded-[14px] border border-border-subtle bg-surface p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted">
              {t('matter.chatContextTitle')}
              {matterContext.sourceLabel ? ` · ${matterContext.sourceLabel}` : ''}
            </p>
            <h3 className="mt-1 text-[15px] font-semibold text-text-primary">
              {matterContext.title}
            </h3>
            {matterContext.summary ? (
              <p className="mt-1.5 text-[13.5px] leading-6 text-text-secondary">
                {matterContext.summary}
              </p>
            ) : null}
          </div>
          {matterContext.url ? (
            <button
              type="button"
              className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[12px] font-medium text-accent-text hover:bg-accent/10"
              onClick={() => {
                const url = matterContext.url;
                if (url) void window.electronAPI?.openExternal?.(url);
              }}
            >
              {t('matter.chatContextOpenSource')}
              <ArrowUpRight className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
        {fields.length > 0 ? (
          <dl className="mt-3 grid gap-3 border-t border-border-muted pt-3 sm:grid-cols-2">
            {fields.map((field) => (
              <div key={field.label}>
                <dt className="text-[11px] font-medium text-text-muted">{field.label}</dt>
                <dd className="mt-0.5 text-[13px] leading-5 text-text-secondary">{field.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        <p className="mt-3 text-[12px] text-text-muted">{t('matter.chatContextWaiting')}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center gap-2 py-28 text-center">
      <span className="mb-1 flex h-10 w-10 items-center justify-center rounded-xl border border-border-subtle bg-surface text-accent">
        <MessageSquareText className="h-5 w-5" />
      </span>
      <p className="text-[17px] font-semibold tracking-[-0.01em] text-text-primary">
        {t('chat.empty.title')}
      </p>
      <p className="max-w-sm text-[13.5px] leading-6 text-text-muted">{t('chat.empty.hint')}</p>
    </div>
  );
}
