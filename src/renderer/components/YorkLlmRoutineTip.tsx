import { useCallback, useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { shouldNudgeYorkLlmForRoutinePrompt } from '../../shared/auto-model';
import { yorkLlmSelectionPayload } from '../../shared/york-llm-config';
import { useAppStore } from '../store';
import { useYorkLlmModels } from '../hooks/useYorkLlmModels';

const isElectron = typeof window !== 'undefined' && window.electronAPI !== undefined;
const DISMISS_STORAGE_KEY = 'york-llm-routine-nudge-dismissed';

interface YorkLlmRoutineTipProps {
  prompt: string;
}

export function YorkLlmRoutineTip({ prompt }: YorkLlmRoutineTipProps) {
  const { t } = useTranslation();
  const appConfig = useAppStore((state) => state.appConfig);
  const setAppConfig = useAppStore((state) => state.setAppConfig);
  const setIsConfigured = useAppStore((state) => state.setIsConfigured);
  const { models: yorkLlmModels, loadModels } = useYorkLlmModels();
  const [dismissed, setDismissed] = useState(() => {
    try {
      return sessionStorage.getItem(DISMISS_STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (!dismissed) {
      loadModels(false);
    }
  }, [dismissed, loadModels]);

  const shouldShow = useMemo(() => {
    if (dismissed || !appConfig) return false;
    return shouldNudgeYorkLlmForRoutinePrompt({
      provider: appConfig.provider,
      model: appConfig.model,
      baseUrl: appConfig.baseUrl,
      prompt,
    });
  }, [appConfig, dismissed, prompt]);

  const dismiss = useCallback(() => {
    setDismissed(true);
    try {
      sessionStorage.setItem(DISMISS_STORAGE_KEY, '1');
    } catch {
      // ignore quota / private mode
    }
  }, []);

  const switchToYork = useCallback(async () => {
    if (!isElectron || isSaving) return;
    const modelId = yorkLlmModels[0]?.id;
    if (!modelId) {
      loadModels(true);
      return;
    }
    setIsSaving(true);
    try {
      const result = await window.electronAPI.config.save(yorkLlmSelectionPayload(modelId));
      setAppConfig(result.config);
      setIsConfigured(true);
      dismiss();
    } finally {
      setIsSaving(false);
    }
  }, [dismiss, isSaving, loadModels, setAppConfig, setIsConfigured, yorkLlmModels]);

  if (!shouldShow) return null;

  return (
    <div
      className="mt-2 flex items-start gap-2 rounded-xl border border-border-subtle bg-surface-hover/60 px-3 py-2 text-[11px] leading-snug text-text-secondary"
      role="status"
    >
      <p className="min-w-0 flex-1">
        {t(
          'workspace.models.routineNudgeText',
          'This looks routine — York LLM is free and usually enough.'
        )}{' '}
        <button
          type="button"
          onClick={() => {
            void switchToYork();
          }}
          disabled={isSaving || yorkLlmModels.length === 0}
          className="font-medium text-accent hover:underline disabled:cursor-not-allowed disabled:opacity-50 disabled:no-underline"
        >
          {t('workspace.models.routineNudgeCta', 'Use York LLM')}
        </button>
      </p>
      <button
        type="button"
        onClick={dismiss}
        className="shrink-0 rounded-md p-0.5 text-text-muted hover:bg-surface-hover hover:text-text-primary"
        title={t('workspace.models.routineNudgeDismiss', 'Dismiss')}
        aria-label={t('workspace.models.routineNudgeDismiss', 'Dismiss')}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
