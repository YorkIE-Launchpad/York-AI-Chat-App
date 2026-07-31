import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink, LogOut } from 'lucide-react';
import { useAppStore } from '../../store';
import { useAuth } from '../../auth/AuthContext';
import { hasOpenRouterUserApiKey } from '../../../shared/openrouter-user-key';

const isElectron = typeof window !== 'undefined' && window.electronAPI !== undefined;

export function SettingsGeneral() {
  const { t } = useTranslation();
  const { logout, user } = useAuth();
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const appConfig = useAppStore((s) => s.appConfig);
  const setAppConfig = useAppStore((s) => s.setAppConfig);
  const [appVer, setAppVer] = useState('');
  const [openRouterKeyDraft, setOpenRouterKeyDraft] = useState('');
  const [keyDirty, setKeyDirty] = useState(false);
  const [savingKey, setSavingKey] = useState(false);
  const [keySaveMessage, setKeySaveMessage] = useState<string | null>(null);

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

  return (
    <div className="space-y-6">
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

      {/* OpenRouter BYOK */}
      <div className="space-y-3 pt-2 border-t border-border">
        <h4 className="text-sm font-medium text-text-primary">
          {t('general.openRouterKey', 'OpenRouter API key')}
        </h4>
        <p className="text-sm text-text-secondary">
          {t(
            'general.openRouterKeyHelp',
            'OpenRouter models need your own key. Free models (:free / openrouter/free) have no per-token cost — rate limits apply.'
          )}
        </p>
        <p className="text-xs text-text-muted">
          {t(
            'general.openRouterLimits',
            'Limits: under $10 credits → 20 requests/min, 50/day. With $10+ credits → 20/min, 1000/day.'
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
                'OpenRouter models are disabled until you add a key. York Anthropic / OpenAI / Gemini models still work.'
              )}
            </p>
          )}
        </div>
      </div>

      {user ? (
        <div className="space-y-3 pt-2 border-t border-border">
          <h4 className="text-sm font-medium text-text-primary">Account</h4>
          <p className="text-sm text-text-secondary">{user.name}</p>
          <p className="text-xs text-text-muted">{user.email}</p>
          <button
            type="button"
            onClick={() => void logout()}
            className="inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm text-text-secondary hover:border-accent/50 hover:text-text-primary"
          >
            <LogOut className="h-4 w-4" />
            {t('sidebar.signOut')}
          </button>
        </div>
      ) : null}

      {/* About */}
      {appVer && (
        <div className="pt-4 border-t border-border">
          <p className="text-xs text-text-muted">York WorkOS v{appVer}</p>
        </div>
      )}
    </div>
  );
}
