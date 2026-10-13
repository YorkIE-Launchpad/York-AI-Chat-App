import { useEffect, useId, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Lightbulb, X } from 'lucide-react';

interface TipModalProps {
  title: ReactNode;
  body: ReactNode;
  /** Illustration / animation shown above the title. */
  media?: ReactNode;
  /** Extra info shown on the left of the footer (e.g. a shortcut hint). */
  footerHint?: ReactNode;
  onDismiss: () => void;
}

/** Centered modal shell shared by all one-time tips. */
export function TipModal({ title, body, media, footerHint, onDismiss }: TipModalProps) {
  const { t } = useTranslation();
  const titleId = useId();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onDismiss();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onDismiss]);

  return createPortal(
    <div
      className="fixed inset-0 z-[150] flex items-center justify-center bg-black/20 p-4 backdrop-blur-sm animate-fade-in"
      role="presentation"
      onClick={onDismiss}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="card w-full max-w-sm p-5 shadow-elevated animate-slide-up"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <span className="inline-flex items-center gap-1 rounded-full bg-accent-muted px-2 py-0.5 text-[11px] font-medium text-accent">
            <Lightbulb className="h-3 w-3" />
            {t('tips.badge')}
          </span>
          <button
            type="button"
            onClick={onDismiss}
            className="rounded-md p-0.5 text-text-muted hover:bg-surface-hover hover:text-text-primary"
            title={t('tips.dismiss')}
            aria-label={t('tips.dismiss')}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {media}

        <h3 id={titleId} className="mt-3 text-sm font-semibold text-text-primary">
          {title}
        </h3>
        <p className="mt-1 text-xs leading-relaxed text-text-secondary">{body}</p>

        <div className="mt-3 flex items-center justify-between gap-2">
          <span className="text-[11px] text-text-muted">{footerHint}</span>
          <button type="button" className="btn btn-primary" onClick={onDismiss} autoFocus>
            {t('tips.gotIt')}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
