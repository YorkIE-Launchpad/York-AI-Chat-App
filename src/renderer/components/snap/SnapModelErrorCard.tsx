import { useTranslation } from 'react-i18next';
import { AlertTriangle, ImageOff, RefreshCw } from 'lucide-react';
import { ModelSelector } from '../ModelSelector';
import { useAppStore } from '../../store';
import { isAutoModelId } from '../../../shared/auto-model';
import { isImageInputUnsupportedError, SESSION_ERROR_PREFIX } from '../../../shared/screen-snap';

interface SnapModelErrorCardProps {
  message: string;
  onRetry?: () => void;
  retrying?: boolean;
}

function cleanErrorText(message: string): string {
  return message.replace(SESSION_ERROR_PREFIX, '').trim();
}

function modelLabel(model: string | undefined): string | null {
  if (!model || isAutoModelId(model)) return null;
  const parts = model.split('/');
  return parts[parts.length - 1] || model;
}

/**
 * Inline error for the snap panel. Model errors (e.g. a text-only model given a
 * screenshot) get a plain-language explanation and a model picker to fix it.
 */
export function SnapModelErrorCard({ message, onRetry, retrying }: SnapModelErrorCardProps) {
  const { t } = useTranslation();
  const model = useAppStore((state) => modelLabel(state.appConfig?.model));
  const imageUnsupported = isImageInputUnsupportedError(message);

  return (
    <div className="snap-no-drag rounded-2xl border border-amber-500/40 bg-surface p-3">
      <div className="flex items-start gap-2.5">
        <div className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-amber-500/15 text-amber-600 dark:text-amber-400">
          {imageUnsupported ? (
            <ImageOff className="h-4 w-4" />
          ) : (
            <AlertTriangle className="h-4 w-4" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-text-primary">
            {imageUnsupported ? t('snap.modelNoImagesTitle') : t('snap.errorTitle')}
          </p>
          <p className="mt-0.5 text-xs leading-relaxed text-text-secondary">
            {imageUnsupported
              ? model
                ? t('snap.modelNoImagesBody', { model })
                : t('snap.modelNoImagesBodyGeneric')
              : cleanErrorText(message)}
          </p>
          {imageUnsupported ? (
            <details className="mt-1 text-[11px] text-text-muted">
              <summary className="cursor-pointer select-none">{t('snap.errorDetails')}</summary>
              <p className="mt-1 break-words">{cleanErrorText(message)}</p>
            </details>
          ) : null}
        </div>
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-2 pl-9">
        <span className="text-[11px] text-text-muted">{t('snap.changeModel')}</span>
        <div className="rounded-xl border border-border">
          <ModelSelector />
        </div>
        {onRetry ? (
          <button
            type="button"
            onClick={onRetry}
            disabled={retrying}
            className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
          >
            <RefreshCw className={`h-3 w-3 ${retrying ? 'animate-spin' : ''}`} />
            {t('snap.tryAgain')}
          </button>
        ) : null}
      </div>
    </div>
  );
}
