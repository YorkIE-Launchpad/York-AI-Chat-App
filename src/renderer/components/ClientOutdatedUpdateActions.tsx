import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw } from 'lucide-react';
import { useUpdaterStatus } from '../hooks/useUpdaterStatus';

interface ClientOutdatedUpdateActionsProps {
  className?: string;
  /** Kick off an update check when this CTA mounts (default true). */
  autoCheck?: boolean;
}

/**
 * Inline update status + primary action for HTTP 426 / client_outdated errors.
 */
export function ClientOutdatedUpdateActions({
  className = '',
  autoCheck = true,
}: ClientOutdatedUpdateActionsProps) {
  const { t } = useTranslation();
  const {
    status: updaterStatus,
    checking,
    installing,
    checkForUpdates,
    quitAndInstall,
  } = useUpdaterStatus();
  const didAutoCheck = useRef(false);

  useEffect(() => {
    if (!autoCheck || didAutoCheck.current) return;
    if (updaterStatus.status === 'unsupported') return;
    if (
      updaterStatus.status === 'ready' ||
      updaterStatus.status === 'downloading' ||
      updaterStatus.status === 'available' ||
      updaterStatus.status === 'checking'
    ) {
      return;
    }
    didAutoCheck.current = true;
    void checkForUpdates();
  }, [autoCheck, checkForUpdates, updaterStatus.status]);

  if (updaterStatus.status === 'unsupported') {
    return (
      <div
        className={`rounded-xl border border-border bg-surface-muted/60 px-3 py-2.5 space-y-1 ${className}`}
        role="status"
      >
        <p className="text-sm text-text-primary">{t('chat.clientOutdatedTitle')}</p>
        <p className="text-xs text-text-secondary">{t('chat.clientOutdatedUnsupported')}</p>
      </div>
    );
  }

  const isChecking = checking || updaterStatus.status === 'checking';
  const showRestart = updaterStatus.status === 'ready';
  const showCheck =
    !showRestart &&
    updaterStatus.status !== 'downloading' &&
    updaterStatus.status !== 'available';

  return (
    <div
      className={`rounded-xl border border-accent/30 bg-accent/5 px-3 py-2.5 space-y-2 ${className}`}
      role="status"
    >
      <p className="text-sm font-medium text-text-primary">{t('chat.clientOutdatedTitle')}</p>

      {isChecking && <p className="text-xs text-text-muted">{t('general.updateChecking')}</p>}
      {updaterStatus.status === 'available' && updaterStatus.version && (
        <p className="text-xs text-text-secondary">
          {t('general.updateAvailable', { version: updaterStatus.version })}
        </p>
      )}
      {updaterStatus.status === 'downloading' && (
        <p className="text-xs text-text-secondary">
          {t('general.updateDownloading', { percent: updaterStatus.percent ?? 0 })}
        </p>
      )}
      {showRestart && updaterStatus.version && (
        <p className="text-xs text-text-secondary">
          {t('general.updateReady', { version: updaterStatus.version })}
        </p>
      )}
      {updaterStatus.status === 'error' && (
        <p className="text-xs text-error">{updaterStatus.message || t('general.updateError')}</p>
      )}

      {showRestart ? (
        <button
          type="button"
          onClick={() => void quitAndInstall()}
          disabled={installing}
          className="inline-flex items-center gap-2 rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50 transition-opacity"
        >
          <RefreshCw className={`h-4 w-4 ${installing ? 'animate-spin' : ''}`} />
          {t('general.restartToUpdate')}
        </button>
      ) : null}

      {showCheck ? (
        <button
          type="button"
          onClick={() => void checkForUpdates()}
          disabled={isChecking}
          className="inline-flex items-center gap-2 rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50 transition-opacity"
        >
          <RefreshCw className={`h-4 w-4 ${isChecking ? 'animate-spin' : ''}`} />
          {t('general.checkForUpdates')}
        </button>
      ) : null}
    </div>
  );
}
