import { useCallback, useState } from 'react';
import { Brain } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../store';

const isElectron = typeof window !== 'undefined' && window.electronAPI !== undefined;

interface ThinkingModeToggleProps {
  className?: string;
}

/**
 * Composer control: toggle extended thinking for complex tasks.
 * Persists to config.enableThinking (used by the agent runner).
 */
export function ThinkingModeToggle({ className = '' }: ThinkingModeToggleProps) {
  const { t } = useTranslation();
  const appConfig = useAppStore((s) => s.appConfig);
  const setAppConfig = useAppStore((s) => s.setAppConfig);
  const [isSaving, setIsSaving] = useState(false);

  const enabled = Boolean(appConfig?.enableThinking);

  const toggle = useCallback(async () => {
    if (!isElectron || isSaving) return;
    setIsSaving(true);
    try {
      const result = await window.electronAPI.config.save({
        enableThinking: !enabled,
      });
      setAppConfig(result.config);
    } catch (error) {
      console.error('[ThinkingModeToggle] Failed to save:', error);
    } finally {
      setIsSaving(false);
    }
  }, [enabled, isSaving, setAppConfig]);

  return (
    <button
      type="button"
      onClick={() => void toggle()}
      disabled={isSaving || !appConfig}
      aria-pressed={enabled}
      aria-label={enabled ? t('chat.thinkingModeOnHint') : t('chat.thinkingModeOffHint')}
      title={enabled ? t('chat.thinkingModeOnHint') : t('chat.thinkingModeOffHint')}
      className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        enabled
          ? 'bg-accent/10 text-accent hover:bg-accent/15'
          : 'text-text-muted hover:bg-surface-hover hover:text-text-primary'
      } ${className}`}
    >
      <Brain className="h-4 w-4" aria-hidden />
    </button>
  );
}
