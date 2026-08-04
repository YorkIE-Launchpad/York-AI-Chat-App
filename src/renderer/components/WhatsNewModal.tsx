import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Sparkles } from 'lucide-react';
import type { WhatsNewPayload } from '../../shared/whats-new-types';
import { MessageMarkdown } from './MessageMarkdown';

interface WhatsNewModalProps {
  payload: WhatsNewPayload;
  onDismiss: () => void;
}

export function WhatsNewModal({ payload, onDismiss }: WhatsNewModalProps) {
  const { t } = useTranslation();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onDismiss();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onDismiss]);

  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/20 p-4 backdrop-blur-sm animate-fade-in"
      role="presentation"
      onClick={onDismiss}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="whats-new-title"
        className="card flex max-h-[min(80vh,640px)] w-full max-w-lg flex-col p-6 shadow-elevated animate-slide-up"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start gap-4">
          <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-xl bg-accent-muted">
            <Sparkles className="h-6 w-6 text-accent" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="whats-new-title" className="text-lg font-semibold text-text-primary">
              {t('whatsNew.title', { version: payload.toVersion })}
            </h2>
            <p className="mt-1 text-sm text-text-secondary">
              {t('whatsNew.subtitle', { fromVersion: payload.fromVersion })}
            </p>
          </div>
        </div>

        <div className="mt-4 min-h-0 flex-1 overflow-y-auto rounded-xl bg-surface-muted p-4">
          <MessageMarkdown normalizedText={payload.markdown} />
        </div>

        <div className="mt-6 flex justify-end">
          <button type="button" className="btn btn-primary" onClick={onDismiss} autoFocus>
            {t('whatsNew.gotIt')}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
