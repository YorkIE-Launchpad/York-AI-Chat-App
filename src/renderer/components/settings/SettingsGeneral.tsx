import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw } from 'lucide-react';
import { useAppStore } from '../../store';
import { HubBudgetUsageCard } from './HubBudgetUsageCard';
import { ScreenSnapShortcutSetting } from './ScreenSnapShortcutSetting';
import { VoiceControlSetting } from './VoiceControlSetting';
import {
  notifyBackendModelsCatalogRefreshed,
  refreshBackendModelsCatalog,
} from '../../utils/backend-models-catalog';

const isElectron = typeof window !== 'undefined' && window.electronAPI !== undefined;

export function SettingsGeneral() {
  const { t } = useTranslation();
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const appConfig = useAppStore((s) => s.appConfig);
  const setAppConfig = useAppStore((s) => s.setAppConfig);
  const [savingThinking, setSavingThinking] = useState(false);
  const [refreshingModels, setRefreshingModels] = useState(false);
  const [modelsRefreshMessage, setModelsRefreshMessage] = useState<string | null>(null);

  const themeOptions = [
    { value: 'light' as const, label: t('general.themeLight') },
    { value: 'dark' as const, label: t('general.themeDark') },
    { value: 'system' as const, label: t('general.themeSystem', 'System') },
  ];

  const thinkingEnabled = Boolean(appConfig?.enableThinking);

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

  const refreshModelsCatalog = async () => {
    if (!isElectron || refreshingModels) return;
    setRefreshingModels(true);
    setModelsRefreshMessage(null);
    try {
      const items = await refreshBackendModelsCatalog({ usable: true, forceRefresh: true });
      setModelsRefreshMessage(t('general.refreshModelsSuccess', { count: items.length }));
      notifyBackendModelsCatalogRefreshed();
    } catch {
      setModelsRefreshMessage(t('general.refreshModelsFailed'));
    } finally {
      setRefreshingModels(false);
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

      <ScreenSnapShortcutSetting />

      <VoiceControlSetting />

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

      {/* Model catalog */}
      <div className="space-y-3 pt-2 border-t border-border">
        <h4 className="text-sm font-medium text-text-primary">{t('general.modelsCatalog')}</h4>
        <p className="text-sm text-text-secondary">{t('general.modelsCatalogHelp')}</p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={refreshingModels}
            onClick={() => void refreshModelsCatalog()}
            className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-sm text-text-secondary hover:border-accent/50 hover:text-text-primary disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${refreshingModels ? 'animate-spin' : ''}`} />
            {refreshingModels ? t('general.refreshingModels') : t('general.refreshModels')}
          </button>
        </div>
        {modelsRefreshMessage && <p className="text-xs text-text-muted">{modelsRefreshMessage}</p>}
      </div>
    </div>
  );
}
