import { useTranslation } from 'react-i18next';
import { ExternalLink, KeyRound } from 'lucide-react';
import { useAppStore } from '../store';
import { needsOpenRouterUserKey } from '../../shared/openrouter-user-key';

interface OpenRouterKeyGateBannerProps {
  className?: string;
  /** Compact single-line style for chat footer area. */
  compact?: boolean;
}

/**
 * Shown in General / Folders when the user’s OpenRouter API key is missing.
 * Blocks productive use until Settings → General has a key, or they switch workspace.
 */
export function OpenRouterKeyGateBanner({
  className = '',
  compact = false,
}: OpenRouterKeyGateBannerProps) {
  const { t } = useTranslation();
  const activeDivision = useAppStore((s) => s.activeDivision);
  const appConfig = useAppStore((s) => s.appConfig);
  const setShowSettings = useAppStore((s) => s.setShowSettings);
  const setSettingsTab = useAppStore((s) => s.setSettingsTab);

  if (!needsOpenRouterUserKey(activeDivision, appConfig?.openRouterUserApiKey)) {
    return null;
  }

  const openSettings = () => {
    setSettingsTab('general');
    setShowSettings(true);
  };

  const workspaceLabel =
    activeDivision?.kind === 'folder'
      ? t('workspace.openRouter.foldersLabel', 'Folders')
      : t('workspace.openRouter.generalLabel', 'General');

  if (compact) {
    return (
      <div
        className={`flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-500/35 bg-amber-500/10 px-3 py-2 text-xs text-text-secondary ${className}`}
        role="status"
      >
        <span className="min-w-0">
          <span className="font-medium text-text-primary">
            {t('workspace.openRouter.gateTitle', {
              workspace: workspaceLabel,
            })}
          </span>{' '}
          {t('workspace.openRouter.gateShort')}
        </span>
        <button
          type="button"
          onClick={openSettings}
          className="shrink-0 rounded-lg bg-accent px-2.5 py-1 text-[11px] font-medium text-white hover:opacity-90"
        >
          {t('workspace.openRouter.addKeyCta')}
        </button>
      </div>
    );
  }

  return (
    <div
      className={`rounded-2xl border border-amber-500/35 bg-amber-500/10 px-4 py-3.5 text-left ${className}`}
      role="status"
    >
      <div className="flex items-start gap-3">
        <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-amber-700 dark:text-amber-400" />
        <div className="min-w-0 space-y-2">
          <p className="text-sm font-medium text-text-primary">
            {t('workspace.openRouter.gateTitle', { workspace: workspaceLabel })}
          </p>
          <p className="text-xs leading-relaxed text-text-secondary">
            {t('workspace.openRouter.gateBody')}
          </p>
          <p className="text-xs leading-relaxed text-text-muted">
            {t('workspace.openRouter.gateAlt')}
          </p>
          <div className="flex flex-wrap items-center gap-2 pt-0.5">
            <button
              type="button"
              onClick={openSettings}
              className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
            >
              <KeyRound className="h-3.5 w-3.5" />
              {t('workspace.openRouter.addKeyCta')}
            </button>
            <a
              href="https://openrouter.ai/keys"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs text-accent hover:underline"
            >
              <ExternalLink className="h-3 w-3" />
              {t('workspace.openRouter.getKeyLink')}
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
