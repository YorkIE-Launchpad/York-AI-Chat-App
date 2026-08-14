import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink, RefreshCw } from 'lucide-react';
import { useAppStore } from '../../store';
import { hasOpenRouterUserApiKey } from '../../../shared/openrouter-user-key';
import { useUpdaterStatus } from '../../hooks/useUpdaterStatus';
import { HubBudgetUsageCard } from './HubBudgetUsageCard';

const isElectron = typeof window !== 'undefined' && window.electronAPI !== undefined;

export function SettingsGeneral() {
  const { t } = useTranslation();
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const appConfig = useAppStore((s) => s.appConfig);
  const setAppConfig = useAppStore((s) => s.setAppConfig);
  const [appVer, setAppVer] = useState('');
  const [openRouterKeyDraft, setOpenRouterKeyDraft] = useState('');
  const [keyDirty, setKeyDirty] = useState(false);
  const [savingKey, setSavingKey] = useState(false);
  const [keySaveMessage, setKeySaveMessage] = useState<string | null>(null);
  const [savingThinking, setSavingThinking] = useState(false);
  const {
    status: updaterStatus,
    checking: updaterChecking,
    installing: updaterInstalling,
    checkForUpdates,
    quitAndInstall,
  } = useUpdaterStatus();

  useEffect(() => {
    try {
      const v = window.electronAPI?.getVersion?.();
      if (v instanceof Promise) v.then(setAppVer);
      else if (v) setAppVer(v);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (!keyDirty) {
      setOpenRouterKeyDraft(appConfig?.openRouterUserApiKey || '');
    }
  }, [appConfig?.openRouterUserApiKey, keyDirty]);

  const themeOptions = [
    { value: 'light' as const, label: t('general.themeLight') },
    { value: 'dark' as const, label: t('general.themeDark') },
    { value: 'system' as const, label: t('general.themeSystem', 'System') },
  ];

  const hasKey = hasOpenRouterUserApiKey(appConfig?.openRouterUserApiKey);
  const thinkingEnabled = Boolean(appConfig?.enableThinking);

  const saveOpenRouterKey = async () => {
    if (!isElectron || savingKey) return;
    setSavingKey(true);
    setKeySaveMessage(null);
    try {
      const result = await window.electronAPI.config.save({
        openRouterUserApiKey: openRouterKeyDraft.trim(),
      });
      setAppConfig(result.config);
      setKeyDirty(false);
      setKeySaveMessage(
        openRouterKeyDraft.trim()
          ? t('general.openRouterKeySaved', 'OpenRouter key saved')
          : t('general.openRouterKeyCleared', 'OpenRouter key cleared')
      );
    } catch {
      setKeySaveMessage(t('general.openRouterKeySaveFailed', 'Failed to save OpenRouter key'));
    } finally {
      setSavingKey(false);
    }
  };

  const toggleThinkingMode = async () => {
    if (!isElectron || savingThinking || !appConfig) return;
    setSavingThinking(true);
    try {
      const result = await window.electronAPI.config.save({
        enableThinking: !thinkingEnabled,
      });
      setAppConfig(result.config);
    } catch {
      /* ignore */
    } finally {
      setSavingThinking(false);
    }
  };

  return (
    <div className="space-y-6">
      <HubBudgetUsageCard />

      {/* Theme */}
      <div className="space-y-3">
        <h4 className="text-sm font-medium text-text-primary">{t('general.appearance')}</h4>
        <div className="flex gap-2">
          {themeOptions.map((opt) => (
            <button
              key={opt.value}
              onClick={() => updateSettings({ theme: opt.value })}
              className={`flex-1 px-4 py-2.5 rounded-lg border-2 text-sm font-medium transition-all ${
                settings.theme === opt.value
                  ? 'border-accent bg-accent/5 text-text-primary'
                  : 'border-border bg-surface hover:border-accent/50 text-text-secondary'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Thinking mode */}
      <div className="space-y-3 pt-2 border-t border-border">
        <h4 className="text-sm font-medium text-text-primary">{t('general.thinkingMode')}</h4>
        <p className="text-sm text-text-secondary">{t('general.thinkingModeHelp')}</p>
        <button
          type="button"
          disabled={savingThinking || !appConfig}
          onClick={() => void toggleThinkingMode()}
          className={`px-4 py-2.5 rounded-lg border-2 text-sm font-medium transition-all disabled:opacity-50 ${
            thinkingEnabled
              ? 'border-accent bg-accent/5 text-text-primary'
              : 'border-border bg-surface hover:border-accent/50 text-text-secondary'
          }`}
        >
          {thinkingEnabled ? t('memory.enabled') : t('memory.disabled')}
        </button>
      </div>

      {/* OpenRouter key for General / Folders (user-owned, not York billing) */}
      <div className="space-y-3 pt-2 border-t border-border">
        <h4 className="text-sm font-medium text-text-primary">
          {t('general.openRouterKey', 'OpenRouter API key')}
        </h4>
        <p className="text-sm text-text-secondary">
          {t(
            'general.openRouterKeyHelp',
            'OpenRouter models use your own key (BYOK), not York billing. Free models (:free / openrouter/free) have no per-token cost — rate limits apply. Paid OpenRouter names bill your OpenRouter credits. York-managed Claude / GPT / Gemini use the York proxy when allowed by Hub.'
          )}
        </p>
        <p className="text-xs text-text-muted">
          {t(
            'general.openRouterLimits',
            'Limits: under $10 credits → 20 requests/min, 50/day. With $10+ credits → 20/min, 1000/day. Hit a limit? Pick a free model, add credits, or switch to Hub / Project for York-managed models.'
          )}
        </p>
        <a
          href="https://openrouter.ai/keys"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 text-xs text-accent hover:underline"
        >
          <ExternalLink className="h-3 w-3" />
          {t('general.openRouterGetKey', 'Get a key at openrouter.ai/keys')}
        </a>
        <div className="space-y-2">
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={openRouterKeyDraft}
            onChange={(e) => {
              setOpenRouterKeyDraft(e.target.value);
              setKeyDirty(true);
              setKeySaveMessage(null);
            }}
            placeholder={
              hasKey && !keyDirty
                ? t('general.openRouterKeyConfigured', 'Key configured — paste to replace')
                : 'sk-or-v1-…'
            }
            className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={savingKey || !keyDirty}
              onClick={() => void saveOpenRouterKey()}
              className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              {savingKey
                ? t('general.saving', 'Saving…')
                : t('general.saveOpenRouterKey', 'Save key')}
            </button>
            {hasKey && (
              <button
                type="button"
                disabled={savingKey}
                onClick={() => {
                  setOpenRouterKeyDraft('');
                  setKeyDirty(true);
                  setKeySaveMessage(null);
                }}
                className="rounded-lg border border-border px-3 py-1.5 text-sm text-text-secondary hover:border-accent/50"
              >
                {t('general.clearOpenRouterKey', 'Clear')}
              </button>
            )}
          </div>
          {keySaveMessage && <p className="text-xs text-text-muted">{keySaveMessage}</p>}
          {!hasKey && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              {t(
                'general.openRouterKeyMissing',
                'OpenRouter models are disabled until you add a key. In Hub or Project, York Anthropic / OpenAI / Gemini models still work without this key.'
              )}
            </p>
          )}
        </div>
      </div>

      {/* About */}
      {appVer && (
        <div className="pt-4 border-t border-border space-y-3">
          <div>
            <p className="text-sm font-medium text-text-primary mb-1">{t('general.about')}</p>
            <p className="text-xs text-text-muted">
              {t('general.versionLabel', { version: appVer })}
            </p>
          </div>

          {updaterStatus.status !== 'unsupported' && (
            <div className="space-y-2">
              {updaterStatus.status === 'idle' && (
                <p className="text-xs text-text-muted">{t('general.updateUpToDate')}</p>
              )}
              {(updaterStatus.status === 'checking' || updaterChecking) && (
                <p className="text-xs text-text-muted">{t('general.updateChecking')}</p>
              )}
              {updaterStatus.status === 'available' && updaterStatus.version && (
                <p className="text-xs text-text-secondary">
                  {t('general.updateAvailable', { version: updaterStatus.version })}
                </p>
              )}
              {updaterStatus.status === 'downloading' && (
                <p className="text-xs text-text-secondary">
                  {t('general.updateDownloading', {
                    percent: updaterStatus.percent ?? 0,
                  })}
                </p>
              )}
              {updaterStatus.status === 'ready' && (
                <div className="space-y-2">
                  {updaterStatus.version && (
                    <p className="text-xs text-text-secondary">
                      {t('general.updateReady', { version: updaterStatus.version })}
                    </p>
                  )}
                  <button
                    type="button"
                    onClick={() => void quitAndInstall()}
                    disabled={updaterInstalling}
                    className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
                  >
                    <RefreshCw className={`h-4 w-4 ${updaterInstalling ? 'animate-spin' : ''}`} />
                    {t('general.restartToUpdate')}
                  </button>
                </div>
              )}
              {updaterStatus.status === 'error' && (
                <p className="text-xs text-red-500">
                  {updaterStatus.message || t('general.updateError')}
                </p>
              )}

              {updaterStatus.status !== 'ready' &&
                updaterStatus.status !== 'downloading' &&
                updaterStatus.status !== 'available' && (
                  <button
                    type="button"
                    onClick={() => void checkForUpdates()}
                    disabled={updaterChecking || updaterStatus.status === 'checking'}
                    className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-xs text-text-secondary hover:border-accent/50 hover:text-text-primary disabled:opacity-50"
                  >
                    <RefreshCw
                      className={`h-3.5 w-3.5 ${updaterChecking || updaterStatus.status === 'checking' ? 'animate-spin' : ''}`}
                    />
                    {t('general.checkForUpdates')}
                  </button>
                )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
