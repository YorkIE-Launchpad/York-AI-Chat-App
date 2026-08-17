import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Sparkles } from 'lucide-react';
import { useAppStore } from '../store';
import type { AppConfig, ProviderProfileKey } from '../types';
import type { BackendCloudProvider, BackendModelInfo } from '../../shared/backend-config';
import {
  applyBackendManagedCredentials,
  BACKEND_PROXY_PLACEHOLDER_KEY,
  isBackendManagedProvider,
} from '../../shared/backend-config';
import {
  AUTO_MODEL_ID,
  AUTO_PREFERENCE_LABELS,
  AUTO_PREFERENCE_SHORT_LABELS,
  isAutoModelId,
  normalizeAutoModelPreference,
  type AutoModelPreference,
} from '../../shared/auto-model';
import {
  hasOpenRouterUserApiKey,
  isOpenRouterFreeTierModel,
} from '../../shared/openrouter-user-key';
import {
  filterModelsForDivision,
  sessionFieldsFromActiveDivision,
} from '../../shared/workspace-division';
import { applyActiveProjectBudgetToModels } from '../../shared/fe-budget-gate';
import { filterModelsForOpenRouterKey } from '../../shared/openrouter-fallback';
import { useTranslation } from 'react-i18next';

const isElectron = typeof window !== 'undefined' && window.electronAPI !== undefined;

const PROVIDER_LABELS: Record<BackendCloudProvider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  gemini: 'Gemini',
  openrouter: 'OpenRouter',
};

const PROVIDER_ORDER: BackendCloudProvider[] = ['anthropic', 'openai', 'gemini', 'openrouter'];

const AUTO_PREFERENCE_OPTIONS: AutoModelPreference[] = ['eco', 'balanced', 'max'];

function profileKeyForProvider(provider: BackendCloudProvider): ProviderProfileKey {
  return provider;
}

function shortModelName(name: string, id: string): string {
  // Prefer curated display names; fall back to last segment of id
  if (name && name !== id) return name;
  const parts = id.split('/');
  return parts[parts.length - 1] || id;
}

function pickFallbackModel(
  models: BackendModelInfo[],
  preferredProvider?: string
): BackendModelInfo | null {
  if (models.length === 0) return null;
  if (preferredProvider) {
    const sameProvider = models.find((model) => model.provider === preferredProvider);
    if (sameProvider) return sameProvider;
  }
  for (const provider of PROVIDER_ORDER) {
    const match = models.find((model) => model.provider === provider);
    if (match) return match;
  }
  return models[0] ?? null;
}

interface ModelSelectorProps {
  className?: string;
}

export function ModelSelector({ className = '' }: ModelSelectorProps) {
  const { t } = useTranslation();
  const appConfig = useAppStore((state) => state.appConfig);
  const activeDivision = useAppStore((state) => state.activeDivision);
  const setAppConfig = useAppStore((state) => state.setAppConfig);
  const setIsConfigured = useAppStore((state) => state.setIsConfigured);
  const setShowSettings = useAppStore((state) => state.setShowSettings);
  const setSettingsTab = useAppStore((state) => state.setSettingsTab);
  // Org-configured models from Hub AI Governance (via listBackendModels).
  const [models, setModels] = useState<BackendModelInfo[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const reconcileKeyRef = useRef<string | null>(null);

  const hasOpenRouterKey = hasOpenRouterUserApiKey(appConfig?.openRouterUserApiKey);
  const hubUsage = useAppStore((state) => state.hubUsage);
  const activeBudgetSource = hubUsage?.activeSource ?? null;
  const projectBudgetPercent = hubUsage?.projectBudgetPercent ?? null;
  const divisionSession = useMemo(
    () => sessionFieldsFromActiveDivision(activeDivision),
    [activeDivision]
  );
  const usableModels = useMemo(
    () =>
      filterModelsForOpenRouterKey(
        filterModelsForDivision(models, divisionSession),
        appConfig?.openRouterUserApiKey
      ),
    [appConfig?.openRouterUserApiKey, divisionSession, models]
  );

  const isAutoSelected = isAutoModelId(appConfig?.model);
  const autoPreference = normalizeAutoModelPreference(appConfig?.autoModelPreference);

  const loadModels = useCallback(
    (opts?: { silent?: boolean }) => {
      if (!isElectron) return;
      if (!opts?.silent) setIsLoading(true);
      void (async () => {
        try {
          const usable = activeBudgetSource !== 'project';
          let items = await window.electronAPI.config.listBackendModels({ usable });
          if (activeBudgetSource === 'project') {
            items = applyActiveProjectBudgetToModels(items, projectBudgetPercent);
          }
          setModels(items);
        } catch {
          setModels([]);
        } finally {
          if (!opts?.silent) setIsLoading(false);
        }
      })();
    },
    [activeBudgetSource, projectBudgetPercent]
  );

  useEffect(() => {
    loadModels();
  }, [loadModels]);

  useEffect(() => {
    const handleCatalogRefresh = () => loadModels({ silent: true });
    window.addEventListener('york:models-catalog-refreshed', handleCatalogRefresh);
    return () => window.removeEventListener('york:models-catalog-refreshed', handleCatalogRefresh);
  }, [loadModels]);

  useEffect(() => {
    if (!isOpen) return;
    // Refresh catalog when opening in case backend keys changed.
    loadModels({ silent: true });

    const handlePointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, loadModels]);

  const groupedModels = useMemo(() => {
    return models.reduce<Record<BackendCloudProvider, BackendModelInfo[]>>(
      (acc, model) => {
        (acc[model.provider] ||= []).push(model);
        return acc;
      },
      {
        anthropic: [],
        openai: [],
        gemini: [],
        openrouter: [],
      }
    );
  }, [models]);

  const selectedModel = useMemo(() => {
    if (!appConfig?.model || isAutoModelId(appConfig.model)) return null;
    if (isBackendManagedProvider(appConfig.provider)) {
      return (
        usableModels.find(
          (model) => model.provider === appConfig.provider && model.id === appConfig.model
        ) || null
      );
    }
    return null;
  }, [appConfig?.model, appConfig?.provider, usableModels]);

  const saveConfig = useCallback(
    async (payload: Partial<AppConfig>) => {
      if (!isElectron || isSaving) return;
      setIsSaving(true);
      try {
        const result = await window.electronAPI.config.save(payload);
        setAppConfig(result.config);
        setIsConfigured(true);
      } finally {
        setIsSaving(false);
      }
    },
    [isSaving, setAppConfig, setIsConfigured]
  );

  const handleSelectAuto = useCallback(async () => {
    let payload: Partial<AppConfig> = {
      model: AUTO_MODEL_ID,
      autoModelPreference: autoPreference,
      apiKey: BACKEND_PROXY_PLACEHOLDER_KEY,
    };
    const currentProvider = appConfig?.provider;
    const canKeepProvider =
      isBackendManagedProvider(currentProvider) &&
      !(currentProvider === 'openrouter' && !hasOpenRouterKey);
    if (canKeepProvider) {
      payload.provider = currentProvider!;
      payload.activeProfileKey = profileKeyForProvider(currentProvider as BackendCloudProvider);
      payload.customProtocol =
        currentProvider === 'gemini'
          ? 'gemini'
          : currentProvider === 'openai' || currentProvider === 'openrouter'
            ? 'openai'
            : 'anthropic';
    } else {
      const resolvedPreferred: BackendCloudProvider =
        pickFallbackModel(usableModels)?.provider ||
        (PROVIDER_ORDER.find((p) => usableModels.some((m) => m.provider === p)) ?? 'anthropic');
      payload.provider = resolvedPreferred;
      payload.activeProfileKey = profileKeyForProvider(resolvedPreferred);
      payload.customProtocol =
        resolvedPreferred === 'gemini'
          ? 'gemini'
          : resolvedPreferred === 'openai' || resolvedPreferred === 'openrouter'
            ? 'openai'
            : 'anthropic';
    }
    payload = applyBackendManagedCredentials(payload);
    await saveConfig(payload);
    setIsOpen(false);
  }, [appConfig, autoPreference, hasOpenRouterKey, usableModels, saveConfig]);

  const handleSelectPreference = useCallback(
    async (preference: AutoModelPreference) => {
      let payload: Partial<AppConfig> = {
        model: AUTO_MODEL_ID,
        autoModelPreference: preference,
        apiKey: BACKEND_PROXY_PLACEHOLDER_KEY,
      };
      if (isBackendManagedProvider(appConfig?.provider)) {
        payload.provider = appConfig!.provider;
        payload = applyBackendManagedCredentials(payload);
      }
      await saveConfig(payload);
    },
    [appConfig, saveConfig]
  );

  const handleSelect = useCallback(
    async (model: BackendModelInfo) => {
      if (model.provider === 'openrouter' && !hasOpenRouterKey) {
        setShowSettings(true);
        setSettingsTab('general');
        setIsOpen(false);
        return;
      }
      // Over-budget paid models require OpenRouter BYOK (or Project LaunchPad fallback elsewhere).
      if (model.hasBudget === false && !hasOpenRouterKey) {
        setShowSettings(true);
        setSettingsTab('general');
        setIsOpen(false);
        return;
      }
      let payload: Partial<AppConfig> = {
        provider: model.provider,
        activeProfileKey: profileKeyForProvider(model.provider),
        customProtocol:
          model.provider === 'gemini'
            ? 'gemini'
            : model.provider === 'openai' || model.provider === 'openrouter'
              ? 'openai'
              : 'anthropic',
        model: model.id,
        apiKey: BACKEND_PROXY_PLACEHOLDER_KEY,
      };
      payload = applyBackendManagedCredentials(payload);
      await saveConfig(payload);
      setIsOpen(false);
    },
    [hasOpenRouterKey, saveConfig, setSettingsTab, setShowSettings]
  );

  // When the configured cloud model isn't usable (missing from catalog or
  // OpenRouter without BYOK), fall back to the first available concrete model.
  // Never overwrite a selection with Auto — Auto is opt-in only.
  useEffect(() => {
    if (!isElectron || isLoading || isSaving || !appConfig) return;

    if (isAutoModelId(appConfig.model)) {
      reconcileKeyRef.current = null;
      return;
    }
    if (usableModels.length === 0) return;
    if (!isBackendManagedProvider(appConfig.provider)) return;

    const currentAvailable = usableModels.some(
      (model) => model.provider === appConfig.provider && model.id === appConfig.model
    );
    if (currentAvailable) {
      reconcileKeyRef.current = null;
      return;
    }

    const fallback = pickFallbackModel(usableModels, appConfig.provider);
    if (!fallback) return;

    const reconcileKey = `${fallback.provider}::${fallback.id}`;
    if (reconcileKeyRef.current === reconcileKey) return;
    reconcileKeyRef.current = reconcileKey;
    void handleSelect(fallback);
  }, [appConfig, handleSelect, isLoading, isSaving, usableModels]);

  const pendingFallback =
    !isAutoSelected && !selectedModel && isBackendManagedProvider(appConfig?.provider)
      ? pickFallbackModel(usableModels, appConfig?.provider)
      : null;

  const displayName = isAutoSelected
    ? `Auto · ${AUTO_PREFERENCE_SHORT_LABELS[autoPreference]}`
    : selectedModel
      ? shortModelName(selectedModel.name, selectedModel.id)
      : pendingFallback
        ? shortModelName(pendingFallback.name, pendingFallback.id)
        : isLoading
          ? 'Loading…'
          : appConfig?.model && !isBackendManagedProvider(appConfig.provider)
            ? shortModelName(appConfig.model, appConfig.model)
            : 'Select model';

  const showViaOpenRouter = appConfig?.provider === 'openrouter';
  const triggerTitle = showViaOpenRouter
    ? isAutoSelected
      ? `${displayName} · via Openrouter`
      : `${displayName} via Openrouter`
    : isAutoSelected
      ? 'Auto picks the best model per message'
      : displayName;

  // Auto is always selectable; concrete catalog needed only for non-Auto picks.
  const isDisabled = isLoading || isSaving;

  return (
    <div ref={rootRef} className={`relative hidden sm:block ${className}`}>
      <button
        type="button"
        onClick={() => {
          if (!isDisabled) setIsOpen((open) => !open);
        }}
        disabled={isDisabled}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        className={`inline-flex h-8 max-w-[11rem] items-center gap-1 rounded-xl px-2 py-0 text-left transition-colors ${
          isOpen
            ? 'bg-surface-hover text-text-primary'
            : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary'
        } disabled:cursor-not-allowed`}
        title={triggerTitle}
      >
        {isAutoSelected && <Sparkles className="h-3.5 w-3.5 shrink-0 text-accent" />}
        <span className="inline-flex min-w-0 items-baseline gap-1 text-[12px] font-medium tracking-[-0.01em]">
          <span className="truncate">{displayName}</span>
          {showViaOpenRouter && (
            <span className="hidden lg:inline shrink-0 font-normal text-text-muted">
              {t('workspace.models.viaOpenRouter', 'via Openrouter')}
            </span>
          )}
        </span>
        <ChevronDown
          className={`h-3 w-3 shrink-0 text-text-muted transition-transform ${
            isOpen ? 'rotate-180' : ''
          }`}
        />
      </button>

      {isOpen && (
        <div
          role="listbox"
          className="absolute bottom-[calc(100%+8px)] right-0 z-30 w-max min-w-[14rem] max-w-[min(24rem,calc(100vw-2rem))] overflow-hidden rounded-[1.25rem] border border-border-subtle bg-background shadow-elevated"
        >
          <div className="max-h-[min(28rem,70vh)] overflow-y-auto py-1.5">
            {/* Auto (pinned) */}
            <div className="px-1.5 py-1">
              <div className="px-2.5 pb-1 pt-1.5 text-[11px] font-medium tracking-[0.04em] text-text-muted">
                Smart router
              </div>
              <button
                type="button"
                role="option"
                aria-selected={isAutoSelected}
                onClick={() => {
                  void handleSelectAuto();
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

              {isAutoSelected && (
                <div className="mt-1 space-y-0.5 border-t border-border-subtle px-1 pt-1.5">
                  {AUTO_PREFERENCE_OPTIONS.map((preference) => {
                    const isSelected = autoPreference === preference;
                    return (
                      <button
                        key={preference}
                        type="button"
                        role="option"
                        aria-selected={isSelected}
                        onClick={() => {
                          void handleSelectPreference(preference);
                        }}
                        className={`flex w-full items-center gap-2 rounded-xl px-2.5 py-1.5 text-left transition-colors ${
                          isSelected
                            ? 'bg-accent-muted text-accent'
                            : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary'
                        }`}
                      >
                        <span className="whitespace-nowrap text-[12px] font-medium">
                          {AUTO_PREFERENCE_LABELS[preference]}
                        </span>
                        {isSelected && <Check className="h-3 w-3 shrink-0" />}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {PROVIDER_ORDER.map((provider) => {
              const items = groupedModels[provider];
              if (items.length === 0) return null;
              const openRouterDisabled = provider === 'openrouter' && !hasOpenRouterKey;

              const renderModelButton = (model: BackendModelInfo, showOpenRouterCue: boolean) => {
                const isSelected =
                  selectedModel?.provider === model.provider && selectedModel?.id === model.id;
                const budgetRequiresByok = model.hasBudget === false && !hasOpenRouterKey;
                const rowDisabled = openRouterDisabled || budgetRequiresByok;
                return (
                  <button
                    key={`${model.provider}::${model.id}`}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    aria-disabled={rowDisabled}
                    disabled={rowDisabled}
                    onClick={() => {
                      void handleSelect(model);
                    }}
                    className={`flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left transition-colors ${
                      rowDisabled
                        ? 'cursor-not-allowed text-text-muted opacity-50'
                        : isSelected
                          ? 'bg-accent-muted text-accent'
                          : 'text-text-primary hover:bg-surface-hover'
                    }`}
                  >
                    <span className="min-w-0 flex-1 truncate whitespace-nowrap text-[13px] font-medium">
                      {shortModelName(model.name, model.id)}
                    </span>
                    {budgetRequiresByok && (
                      <span className="shrink-0 text-[10px] font-medium tracking-[0.02em] text-text-muted">
                        {t('workspace.models.byokRequired', 'key required')}
                      </span>
                    )}
                    {showOpenRouterCue && !rowDisabled && (
                      <span className="shrink-0 text-[10px] font-medium tracking-[0.02em] text-text-muted">
                        {t('workspace.models.openRouterCue', 'OpenRouter')}
                      </span>
                    )}
                    {isSelected && !rowDisabled && (
                      <Check className="h-3.5 w-3.5 shrink-0" />
                    )}
                  </button>
                );
              };

              if (provider === 'openrouter') {
                const freeItems = items.filter((m) => isOpenRouterFreeTierModel(m.id));
                const paidItems = items.filter((m) => !isOpenRouterFreeTierModel(m.id));
                return (
                  <div key={provider} className="px-1.5 py-1">
                    <div className="px-2.5 pb-1.5 pt-1.5">
                      <div className="text-[11px] font-medium tracking-[0.04em] text-text-muted">
                        {t(
                          'workspace.models.openRouterTitle',
                          'OpenRouter · your key (not York billing)'
                        )}
                        {openRouterDisabled
                          ? ` · ${t('workspace.models.keyRequired', 'key required')}`
                          : ''}
                      </div>
                    </div>
                    {openRouterDisabled && (
                      <button
                        type="button"
                        onClick={() => {
                          setShowSettings(true);
                          setSettingsTab('general');
                          setIsOpen(false);
                        }}
                        className="mb-1 w-full rounded-xl px-2.5 py-2 text-left text-[12px] text-accent hover:bg-surface-hover"
                      >
                        {t(
                          'workspace.models.addOpenRouterKey',
                          'Add your OpenRouter API key (Settings → General)'
                        )}
                      </button>
                    )}
                    {freeItems.length > 0 && (
                      <div className="mb-1">
                        <div className="px-2.5 pb-1 pt-1 text-[11px] font-medium tracking-[0.04em] text-text-muted">
                          {t('workspace.models.freeGroup', 'Free')}
                        </div>
                        <div className="space-y-0.5">
                          {freeItems.map((model) => renderModelButton(model, false))}
                        </div>
                      </div>
                    )}
                    {paidItems.length > 0 && (
                      <div>
                        <div className="px-2.5 pb-1 pt-1 text-[11px] font-medium tracking-[0.04em] text-text-muted">
                          {t('workspace.models.viaYourKeyGroup', 'Via your key')}
                        </div>
                        <div className="space-y-0.5">
                          {paidItems.map((model) => renderModelButton(model, true))}
                        </div>
                      </div>
                    )}
                  </div>
                );
              }

              return (
                <div key={provider} className="px-1.5 py-1">
                  <div className="px-2.5 pb-1 pt-1.5 text-[11px] font-medium tracking-[0.04em] text-text-muted">
                    {PROVIDER_LABELS[provider]}
                  </div>
                  <div className="space-y-0.5">
                    {items.map((model) => renderModelButton(model, false))}
                  </div>
                </div>
              );
            })}

            {!isLoading && models.length === 0 && (
              <div className="px-4 py-2 text-[11px] leading-snug text-text-muted">
                {t('workspace.models.noProviderKeys', 'No provider keys configured')}
              </div>
            )}
            {!isLoading && models.some((m) => m.provider === 'openrouter') && (
              <div className="border-t border-border-subtle px-4 py-2 text-[11px] leading-snug text-text-muted">
                {hasOpenRouterKey
                  ? t(
                      'workspace.models.openRouterLimitsFooter',
                      'OpenRouter limits: under $10 credits → 50/day; $10+ → 1000/day. Paid models use your credits.'
                    )
                  : t(
                      'workspace.models.openRouterKeyFooter',
                      'Free OpenRouter models need your key. Limits: <$10 → 50/day; $10+ → 1000/day.'
                    )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
