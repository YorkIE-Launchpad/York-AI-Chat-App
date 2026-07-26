import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { BackendCloudProvider, BackendModelInfo } from '../../../shared/backend-config';
import { AUTO_MODEL_ID, isAutoModelId } from '../../../shared/auto-model';

const isElectron = typeof window !== 'undefined' && window.electronAPI !== undefined;

export const DEFAULT_SCHEDULE_PROVIDER = 'openrouter';
export const DEFAULT_SCHEDULE_MODEL = 'openrouter/free';

const PROVIDER_LABELS: Record<BackendCloudProvider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  gemini: 'Gemini',
  openrouter: 'OpenRouter',
};

const PROVIDER_ORDER: BackendCloudProvider[] = ['anthropic', 'openai', 'gemini', 'openrouter'];

function shortModelName(name: string, id: string): string {
  if (name && name !== id) return name;
  const parts = id.split('/');
  return parts[parts.length - 1] || id;
}

export interface ScheduleModelSelection {
  model: string;
  provider: string;
}

interface ScheduleModelSelectorProps {
  value: ScheduleModelSelection;
  onChange: (next: ScheduleModelSelection) => void;
  disabled?: boolean;
}

export function ScheduleModelSelector({
  value,
  onChange,
  disabled = false,
}: ScheduleModelSelectorProps) {
  const { t } = useTranslation();
  const [models, setModels] = useState<BackendModelInfo[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const isAutoSelected = isAutoModelId(value.model);

  const loadModels = useCallback((opts?: { silent?: boolean }) => {
    if (!isElectron) return;
    if (!opts?.silent) setIsLoading(true);
    void window.electronAPI.config
      .listBackendModels()
      .then((items) => {
        setModels(items);
      })
      .catch(() => {
        setModels([]);
      })
      .finally(() => {
        if (!opts?.silent) setIsLoading(false);
      });
  }, []);

  useEffect(() => {
    loadModels();
  }, [loadModels]);

  useEffect(() => {
    if (!isOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [isOpen]);

  const groupedModels = useMemo(() => {
    const groups: Record<BackendCloudProvider, BackendModelInfo[]> = {
      anthropic: [],
      openai: [],
      gemini: [],
      openrouter: [],
    };
    for (const model of models) {
      if (groups[model.provider]) {
        groups[model.provider].push(model);
      }
    }
    return groups;
  }, [models]);

  const selectedModel = useMemo(
    () =>
      models.find((model) => model.provider === value.provider && model.id === value.model) ?? null,
    [models, value.model, value.provider]
  );

  const displayName = isAutoSelected
    ? 'Auto'
    : selectedModel
      ? shortModelName(selectedModel.name, selectedModel.id)
      : value.model === DEFAULT_SCHEDULE_MODEL
        ? 'OpenRouter Free'
        : shortModelName(value.model, value.model);

  return (
    <div className="space-y-1.5">
      <div className="text-xs text-text-muted">{t('schedule.model')}</div>
      <div ref={rootRef} className="relative">
        <button
          type="button"
          onClick={() => {
            if (!disabled && !isLoading) setIsOpen((open) => !open);
          }}
          disabled={disabled || isLoading}
          aria-haspopup="listbox"
          aria-expanded={isOpen}
          className={`inline-flex w-full items-center justify-between gap-2 rounded-lg border border-border bg-background px-3 py-2 text-left text-sm transition-colors ${
            isOpen
              ? 'border-accent text-text-primary'
              : 'text-text-secondary hover:text-text-primary'
          } disabled:cursor-not-allowed disabled:opacity-50`}
          title={t('schedule.modelHint')}
        >
          <span className="inline-flex min-w-0 items-center gap-1.5">
            {isAutoSelected && <Sparkles className="h-3.5 w-3.5 shrink-0 text-accent" />}
            <span className="truncate font-medium tracking-[-0.01em]">{displayName}</span>
          </span>
          <ChevronDown
            className={`h-3.5 w-3.5 shrink-0 text-text-muted transition-transform ${
              isOpen ? 'rotate-180' : ''
            }`}
          />
        </button>

        {isOpen && (
          <div
            role="listbox"
            className="absolute left-0 right-0 top-[calc(100%+6px)] z-30 max-h-[min(28rem,50vh)] overflow-y-auto rounded-xl border border-border-subtle bg-background py-1.5 shadow-elevated"
          >
            <div className="px-1.5 py-1">
              <div className="px-2.5 pb-1 pt-1.5 text-[11px] font-medium tracking-[0.04em] text-text-muted">
                Smart router
              </div>
              <button
                type="button"
                role="option"
                aria-selected={isAutoSelected}
                onClick={() => {
                  onChange({
                    model: AUTO_MODEL_ID,
                    provider: value.provider || DEFAULT_SCHEDULE_PROVIDER,
                  });
                  setIsOpen(false);
                }}
                className={`flex w-full items-start gap-2 rounded-xl px-2.5 py-2 text-left transition-colors ${
                  isAutoSelected
                    ? 'bg-accent-muted text-accent'
                    : 'text-text-primary hover:bg-surface-hover'
                }`}
              >
                <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="whitespace-nowrap text-[13px] font-medium">Auto</span>
                    {isAutoSelected && <Check className="h-3.5 w-3.5 shrink-0" />}
                  </span>
                  <span className="mt-0.5 block text-[11px] leading-snug text-text-muted">
                    Picks the best model per message
                  </span>
                </span>
              </button>
            </div>

            {PROVIDER_ORDER.map((provider) => {
              const items = groupedModels[provider];
              if (items.length === 0) return null;
              return (
                <div key={provider} className="px-1.5 py-1">
                  <div className="px-2.5 pb-1 pt-1.5 text-[11px] font-medium tracking-[0.04em] text-text-muted">
                    {PROVIDER_LABELS[provider]}
                  </div>
                  <div className="space-y-0.5">
                    {items.map((model) => {
                      const isSelected =
                        !isAutoSelected &&
                        value.provider === model.provider &&
                        value.model === model.id;
                      return (
                        <button
                          key={`${model.provider}::${model.id}`}
                          type="button"
                          role="option"
                          aria-selected={isSelected}
                          onClick={() => {
                            onChange({
                              model: model.id,
                              provider: model.provider,
                            });
                            setIsOpen(false);
                          }}
                          className={`flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left transition-colors ${
                            isSelected
                              ? 'bg-accent-muted text-accent'
                              : 'text-text-primary hover:bg-surface-hover'
                          }`}
                        >
                          <span className="whitespace-nowrap text-[13px] font-medium">
                            {shortModelName(model.name, model.id)}
                          </span>
                          {isSelected && <Check className="h-3.5 w-3.5 shrink-0" />}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}

            {!isLoading && models.length === 0 && (
              <div className="px-4 py-2 text-[11px] leading-snug text-text-muted">
                {t('schedule.modelEmpty')}
              </div>
            )}
          </div>
        )}
      </div>
      <div className="text-xs text-text-muted">{t('schedule.modelHint')}</div>
    </div>
  );
}
