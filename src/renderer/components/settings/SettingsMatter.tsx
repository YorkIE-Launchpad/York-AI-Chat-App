import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  DEFAULT_MATTER_RUNTIME,
  MATTER_SOURCE_IDS,
  OPPORTUNITY_TARGETS,
  OPPORTUNITY_TARGET_LABELS,
  type MatterConfigurableSource,
  type MatterOpportunitiesConfig,
  type MatterRuntimeConfig,
  type MatterSensitivity,
  type OpportunityTarget,
} from '../../../shared/matter';
import { useAppStore } from '../../store';
import { SettingsContentSection } from './shared';

function ToggleField({
  label,
  hint,
  checked,
  onChange,
  bare,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  bare?: boolean;
}) {
  return (
    <label
      className={
        bare
          ? 'flex items-center justify-between gap-3'
          : 'flex items-center justify-between gap-3 rounded-lg border border-border-muted bg-background/70 px-3 py-2.5'
      }
    >
      <div className="min-w-0">
        <span className="text-sm text-text-primary">{label}</span>
        {hint ? <p className="mt-1 text-xs text-text-muted">{hint}</p> : null}
      </div>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="h-4 w-4 shrink-0 accent-accent"
      />
    </label>
  );
}

function SourcePromptField({
  source,
  checked,
  prompt,
  disabled,
  onToggle,
  onPromptSave,
}: {
  source: MatterConfigurableSource;
  checked: boolean;
  prompt: string;
  disabled?: boolean;
  onToggle: (checked: boolean) => void;
  onPromptSave: (prompt: string) => void;
}) {
  const { t } = useTranslation();
  const [local, setLocal] = useState(prompt);
  useEffect(() => {
    setLocal(prompt);
  }, [prompt]);

  return (
    <div className="rounded-lg border border-border-muted bg-background/70 px-3 py-2.5 space-y-2">
      <ToggleField
        label={t(`matter.source.${source}`)}
        checked={checked}
        onChange={onToggle}
        bare
      />
      <label className="block">
        <span className="text-xs text-text-muted">{t('matter.sourcePrompt')}</span>
        <textarea
          value={local}
          disabled={disabled}
          rows={2}
          placeholder={t(`matter.sourcePromptPlaceholder.${source}`)}
          onChange={(event) => setLocal(event.target.value)}
          onBlur={() => {
            const next = local.trim();
            if (next !== prompt.trim()) onPromptSave(next);
          }}
          className="mt-1 w-full resize-y rounded-lg border border-border-muted bg-background px-3 py-2 text-sm text-text-primary placeholder:text-text-muted"
        />
      </label>
    </div>
  );
}

function RouteField({
  target,
  value,
  disabled,
  onSave,
}: {
  target: OpportunityTarget;
  value: string;
  disabled?: boolean;
  onSave: (value: string) => void;
}) {
  const { t } = useTranslation();
  const [local, setLocal] = useState(value);
  useEffect(() => {
    setLocal(value);
  }, [value]);

  return (
    <label className="grid grid-cols-[minmax(9rem,40%)_1fr] items-center gap-3">
      <span className="text-sm text-text-primary">{OPPORTUNITY_TARGET_LABELS[target]}</span>
      <input
        value={local}
        disabled={disabled}
        placeholder={t('matter.opportunitiesRoutingPlaceholder')}
        onChange={(event) => setLocal(event.target.value)}
        onBlur={() => {
          const next = local.trim();
          if (next !== value.trim()) onSave(next);
        }}
        className="w-full rounded-lg border border-border-muted bg-background px-3 py-1.5 text-sm text-text-primary placeholder:text-text-muted"
      />
    </label>
  );
}

function cloneOpportunities(config: MatterOpportunitiesConfig): MatterOpportunitiesConfig {
  return { ...config, routing: { ...config.routing } };
}

export function SettingsMatter() {
  const { t } = useTranslation();
  const setAppConfig = useAppStore((s) => s.setAppConfig);
  const setShowMatter = useAppStore((s) => s.setShowMatter);
  const setMatterBadgeCount = useAppStore((s) => s.setMatterBadgeCount);
  const [draft, setDraft] = useState<MatterRuntimeConfig>({
    ...DEFAULT_MATTER_RUNTIME,
    sources: { ...DEFAULT_MATTER_RUNTIME.sources },
    sourcePrompts: { ...DEFAULT_MATTER_RUNTIME.sourcePrompts },
    opportunities: cloneOpportunities(DEFAULT_MATTER_RUNTIME.opportunities),
  });
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!window.electronAPI?.matter) return;
    void window.electronAPI.matter.getSnapshot().then((snap) => {
      setDraft({
        ...snap.settings,
        sources: { ...snap.settings.sources },
        sourcePrompts: { ...DEFAULT_MATTER_RUNTIME.sourcePrompts, ...snap.settings.sourcePrompts },
        opportunities: cloneOpportunities(
          snap.settings.opportunities ?? DEFAULT_MATTER_RUNTIME.opportunities
        ),
      });
    });
  }, []);

  const save = async (next: MatterRuntimeConfig) => {
    if (!window.electronAPI?.matter) return;
    setSaving(true);
    setStatus(null);
    try {
      const saved = await window.electronAPI.matter.updateSettings(next);
      setDraft({
        ...saved,
        sources: { ...saved.sources },
        sourcePrompts: { ...saved.sourcePrompts },
        opportunities: cloneOpportunities(saved.opportunities),
      });
      // Keep renderer config in sync so sidebar / nav react immediately.
      if (window.electronAPI.config?.get) {
        const config = await window.electronAPI.config.get();
        setAppConfig(config);
      } else {
        const prev = useAppStore.getState().appConfig;
        if (prev) {
          setAppConfig({
            ...prev,
            matterEnabled: saved.enabled,
            matterRuntime: saved,
          });
        }
      }
      if (!saved.enabled) {
        setShowMatter(false);
        setMatterBadgeCount(0);
      }
      setStatus(t('matter.settingsSaved'));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t('matter.settingsSaveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const patch = (partial: Partial<MatterRuntimeConfig>) => {
    const next: MatterRuntimeConfig = {
      ...draft,
      ...partial,
      sources: {
        ...draft.sources,
        ...(partial.sources || {}),
      },
      sourcePrompts: {
        ...draft.sourcePrompts,
        ...(partial.sourcePrompts || {}),
      },
      opportunities: partial.opportunities
        ? cloneOpportunities(partial.opportunities)
        : cloneOpportunities(draft.opportunities),
    };
    setDraft(next);
    void save(next);
  };

  const patchOpportunities = (partial: Partial<MatterOpportunitiesConfig>) =>
    patch({ opportunities: { ...draft.opportunities, ...partial } });

  return (
    <div className="space-y-6">
      <SettingsContentSection
        title={t('matter.settingsGeneral')}
        description={t('matter.settingsGeneralDesc')}
      >
        <div className="space-y-2">
          <ToggleField
            label={t('matter.enabled')}
            hint={t('matter.enabledHint')}
            checked={draft.enabled}
            onChange={(enabled) => patch({ enabled })}
          />
          <ToggleField
            label={t('matter.morningBrief')}
            hint={t('matter.morningBriefHint')}
            checked={draft.morningBriefEnabled}
            onChange={(morningBriefEnabled) => patch({ morningBriefEnabled })}
          />
          <ToggleField
            label={t('matter.eodWrap')}
            hint={t('matter.eodWrapHint')}
            checked={draft.endOfDayWrapEnabled}
            onChange={(endOfDayWrapEnabled) => patch({ endOfDayWrapEnabled })}
          />
          <ToggleField
            label={t('matter.autoOpen')}
            hint={t('matter.autoOpenHint')}
            checked={draft.autoOpenOnLaunch}
            onChange={(autoOpenOnLaunch) => patch({ autoOpenOnLaunch })}
          />
        </div>
      </SettingsContentSection>

      <SettingsContentSection
        title={t('matter.settingsCadence')}
        description={t('matter.settingsCadenceDesc')}
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="text-sm text-text-primary">
            {t('matter.windowStart')}
            <input
              type="number"
              min={0}
              max={23}
              value={draft.windowStartHour}
              onChange={(e) => patch({ windowStartHour: Number(e.target.value) })}
              className="mt-1 w-full rounded-lg border border-border-muted bg-background px-3 py-2 text-sm"
            />
          </label>
          <label className="text-sm text-text-primary">
            {t('matter.windowEnd')}
            <input
              type="number"
              min={0}
              max={23}
              value={draft.windowEndHour}
              onChange={(e) => patch({ windowEndHour: Number(e.target.value) })}
              className="mt-1 w-full rounded-lg border border-border-muted bg-background px-3 py-2 text-sm"
            />
          </label>
          <label className="text-sm text-text-primary">
            {t('matter.interval')}
            <input
              type="number"
              min={15}
              max={240}
              step={15}
              value={draft.intervalMinutes}
              onChange={(e) => patch({ intervalMinutes: Number(e.target.value) })}
              className="mt-1 w-full rounded-lg border border-border-muted bg-background px-3 py-2 text-sm"
            />
            <span className="mt-1 block text-xs text-text-muted">{t('matter.intervalHint')}</span>
          </label>
          <label className="text-sm text-text-primary">
            {t('matter.meetingsInterval')}
            <input
              type="number"
              min={5}
              max={240}
              step={5}
              value={draft.meetingsIntervalMinutes}
              onChange={(e) => patch({ meetingsIntervalMinutes: Number(e.target.value) })}
              className="mt-1 w-full rounded-lg border border-border-muted bg-background px-3 py-2 text-sm"
            />
            <span className="mt-1 block text-xs text-text-muted">
              {t('matter.meetingsIntervalHint')}
            </span>
          </label>
          <label className="text-sm text-text-primary">
            {t('matter.maxItems')}
            <input
              type="number"
              min={5}
              max={80}
              value={draft.maxActiveItems}
              onChange={(e) => patch({ maxActiveItems: Number(e.target.value) })}
              className="mt-1 w-full rounded-lg border border-border-muted bg-background px-3 py-2 text-sm"
            />
          </label>
          <label className="text-sm text-text-primary sm:col-span-2">
            {t('matter.sensitivity')}
            <select
              value={draft.sensitivity}
              onChange={(e) => patch({ sensitivity: e.target.value as MatterSensitivity })}
              className="mt-1 w-full rounded-lg border border-border-muted bg-background px-3 py-2 text-sm"
            >
              <option value="calm">{t('matter.sensitivityCalm')}</option>
              <option value="balanced">{t('matter.sensitivityBalanced')}</option>
              <option value="hyper">{t('matter.sensitivityHyper')}</option>
            </select>
          </label>
          <label className="text-sm text-text-primary sm:col-span-2">
            <span className="flex items-center justify-between gap-3">
              <span>{t('matter.minConfidence')}</span>
              <span className="text-xs font-medium tabular-nums text-text-secondary">
                {draft.minConfidence > 0
                  ? `≥ ${Math.round(draft.minConfidence * 100)}%`
                  : t('matter.minConfidenceOff')}
              </span>
            </span>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={Math.round(draft.minConfidence * 100)}
              onChange={(e) =>
                setDraft((prev) => ({ ...prev, minConfidence: Number(e.target.value) / 100 }))
              }
              onPointerUp={(e) => patch({ minConfidence: Number(e.currentTarget.value) / 100 })}
              onKeyUp={(e) => patch({ minConfidence: Number(e.currentTarget.value) / 100 })}
              className="mt-2 w-full accent-accent"
            />
            <span className="mt-1 block text-xs text-text-muted">
              {t('matter.minConfidenceHint')}
            </span>
          </label>
        </div>
      </SettingsContentSection>

      <SettingsContentSection
        title={t('matter.settingsSources')}
        description={t('matter.settingsSourcesDesc')}
      >
        <div className="space-y-3">
          {MATTER_SOURCE_IDS.map((source) => (
            <SourcePromptField
              key={source}
              source={source}
              checked={draft.sources[source]}
              prompt={draft.sourcePrompts[source] || ''}
              disabled={saving}
              onToggle={(checked) => patch({ sources: { ...draft.sources, [source]: checked } })}
              onPromptSave={(prompt) =>
                patch({ sourcePrompts: { ...draft.sourcePrompts, [source]: prompt } })
              }
            />
          ))}
        </div>
      </SettingsContentSection>

      <SettingsContentSection
        title={t('matter.settingsOpportunities')}
        description={t('matter.settingsOpportunitiesDesc')}
      >
        <div className="space-y-3">
          <ToggleField
            label={t('matter.opportunitiesEnabled')}
            hint={t('matter.opportunitiesEnabledHint')}
            checked={draft.opportunities.enabled}
            onChange={(enabled) => patchOpportunities({ enabled })}
          />
          <ToggleField
            label={t('matter.opportunitiesNotify')}
            hint={t('matter.opportunitiesNotifyHint')}
            checked={draft.opportunities.notify}
            onChange={(notify) => patchOpportunities({ notify })}
          />
          <label className="block text-sm text-text-primary">
            <span className="flex items-center justify-between gap-3">
              <span>{t('matter.opportunitiesMinConfidence')}</span>
              <span className="text-xs font-medium tabular-nums text-text-secondary">
                {draft.opportunities.minConfidence > 0
                  ? `≥ ${Math.round(draft.opportunities.minConfidence * 100)}%`
                  : t('matter.minConfidenceOff')}
              </span>
            </span>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={Math.round(draft.opportunities.minConfidence * 100)}
              onChange={(e) =>
                setDraft((prev) => ({
                  ...prev,
                  opportunities: {
                    ...prev.opportunities,
                    minConfidence: Number(e.target.value) / 100,
                  },
                }))
              }
              onPointerUp={(e) =>
                patchOpportunities({ minConfidence: Number(e.currentTarget.value) / 100 })
              }
              onKeyUp={(e) =>
                patchOpportunities({ minConfidence: Number(e.currentTarget.value) / 100 })
              }
              className="mt-2 w-full accent-accent"
            />
            <span className="mt-1 block text-xs text-text-muted">
              {t('matter.opportunitiesMinConfidenceHint')}
            </span>
          </label>
          <div className="rounded-lg border border-border-muted bg-background/70 px-3 py-2.5 space-y-2">
            <p className="text-sm text-text-primary">{t('matter.opportunitiesRouting')}</p>
            <p className="text-xs text-text-muted">{t('matter.opportunitiesRoutingDesc')}</p>
            <div className="space-y-2 pt-1">
              {OPPORTUNITY_TARGETS.map((target) => {
                const route = draft.opportunities.routing[target] || {};
                return (
                  <RouteField
                    key={target}
                    target={target}
                    value={route.slackChannel || route.slackUserId || ''}
                    disabled={saving}
                    onSave={(value) =>
                      patchOpportunities({
                        routing: {
                          ...draft.opportunities.routing,
                          [target]: value ? { slackChannel: value } : {},
                        },
                      })
                    }
                  />
                );
              })}
            </div>
          </div>
        </div>
      </SettingsContentSection>

      {status ? (
        <p className="text-xs text-text-muted">{saving ? t('matter.saving') : status}</p>
      ) : null}
    </div>
  );
}
