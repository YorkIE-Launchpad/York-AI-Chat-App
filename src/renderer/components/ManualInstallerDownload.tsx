import { useTranslation } from 'react-i18next';
import { Download } from 'lucide-react';
import type { ManualUpdateDownloadResult } from '../../shared/updater-types';

interface ManualInstallerDownloadProps {
  downloading: boolean;
  result: ManualUpdateDownloadResult | null;
  onDownload: () => void;
  compact?: boolean;
  className?: string;
}

/**
 * Fallback when in-place update fails: open the version-pinned DMG so the user can
 * replace the app in /Applications by hand.
 */
export function ManualInstallerDownload({
  downloading,
  result,
  onDownload,
  compact = false,
  className = '',
}: ManualInstallerDownloadProps) {
  const { t } = useTranslation();
  const textSize = compact ? 'text-[10px]' : 'text-xs';

  return (
    <div className={`space-y-1.5 ${className}`}>
      <button
        type="button"
        onClick={onDownload}
        disabled={downloading}
        title={t('general.downloadInstaller')}
        className={`inline-flex items-center justify-center gap-2 rounded-lg border border-border text-text-primary hover:bg-surface-hover disabled:opacity-50 transition-colors ${
          compact ? 'w-full px-3 py-2 text-xs' : 'px-3.5 py-2 text-sm'
        }`}
      >
        <Download className={`h-4 w-4 ${downloading ? 'animate-pulse' : ''}`} />
        {result?.success && result.version
          ? t('general.downloadInstallerVersion', { version: result.version })
          : t('general.downloadInstaller')}
      </button>

      {result?.success ? (
        <ol className={`${textSize} text-text-secondary list-decimal pl-4 space-y-0.5`}>
          <li>{t('general.manualInstallStepQuit')}</li>
          <li>{t('general.manualInstallStepOpenDmg')}</li>
          <li>{t('general.manualInstallStepReplace')}</li>
          <li>{t('general.manualInstallStepLaunch')}</li>
        </ol>
      ) : result?.error ? (
        <p className={`${textSize} text-error`} role="alert">
          {t('general.downloadInstallerFailed', { error: result.error })}
        </p>
      ) : (
        <p className={`${textSize} text-text-muted`}>{t('general.downloadInstallerHint')}</p>
      )}
    </div>
  );
}
