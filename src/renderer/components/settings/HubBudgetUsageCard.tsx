import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw } from 'lucide-react';
import {
  budgetMeterTone,
  formatCompactTokens,
  type BudgetMeterTone,
} from '../../../shared/fe-budget-gate';
import { hasOpenRouterUserApiKey } from '../../../shared/openrouter-user-key';
import { useAppStore } from '../../store';
import { refreshWorkspaceBudgets } from '../../hooks/useWorkspaceBudgetCheck';
import { BudgetUsageTrack, formatNextMonthRenewal, toneStatusKey } from '../HubBudgetMeter';

function toneTextClass(tone: BudgetMeterTone): string {
  if (tone === 'over') return 'text-error';
  if (tone === 'warning') return 'text-warning';
  return 'text-text-secondary';
}

function CompactRow({ label, percent }: { label: string; percent: number }) {
  const { t } = useTranslation();
  const tone = budgetMeterTone(percent) ?? 'ok';
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-3">
        <p className="min-w-0 text-sm text-text-primary">{label}</p>
        <span className={`shrink-0 text-xs font-medium ${toneTextClass(tone)}`}>
          {t(toneStatusKey(tone))}
        </span>
      </div>
      <BudgetUsageTrack percent={percent} className="w-full" barClassName="h-2" />
    </div>
  );
}

function UsageHeader({
  refreshing,
  onRefresh,
}: {
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center justify-between gap-2">
      <h4 className="text-sm font-medium text-text-primary">{t('workspace.budget.title')}</h4>
      <button
        type="button"
        onClick={onRefresh}
        disabled={refreshing}
        title={t('workspace.budget.refresh')}
        aria-label={t('workspace.budget.refresh')}
        className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-border text-text-secondary hover:border-accent/50 hover:text-text-primary disabled:opacity-50"
      >
        <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
      </button>
    </div>
  );
}

/** Settings → General: personal bar always when present; project bar in a project workspace. */
export function HubBudgetUsageCard() {
  const { t } = useTranslation();
  const hubUsage = useAppStore((s) => s.hubUsage);
  const activeDivision = useAppStore((s) => s.activeDivision);
  const appConfig = useAppStore((s) => s.appConfig);

  const userPercent = hubUsage?.userBudgetPercent ?? null;
  const projectPercent =
    activeDivision?.kind === 'project' ? (hubUsage?.projectBudgetPercent ?? null) : null;
  const activeSource = hubUsage?.activeSource ?? 'none';
  const lastTokens = hubUsage?.lastTurnTokens;
  const hasKey = hasOpenRouterUserApiKey(appConfig?.openRouterUserApiKey);
  const renewsOn = formatNextMonthRenewal();
  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await refreshWorkspaceBudgets({ forceRefresh: true });
    } finally {
      setRefreshing(false);
    }
  };

  if (userPercent == null && projectPercent == null) {
    if (activeSource !== 'none') return null;
    return (
      <div className="space-y-2 rounded-lg border border-border bg-surface p-4">
        <UsageHeader refreshing={refreshing} onRefresh={() => void onRefresh()} />
        <p className="text-sm text-text-secondary">{t('workspace.budget.noYorkAllowance')}</p>
        <p className="text-xs text-text-secondary">{t('workspace.budget.askManager')}</p>
        {!hasKey && (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            {t('workspace.budget.byokCue')}
          </p>
        )}
      </div>
    );
  }

  const projectLabel =
    activeDivision?.kind === 'project' && activeDivision.name
      ? t('workspace.budget.projectNamed', { name: activeDivision.name })
      : t('workspace.budget.project');

  return (
    <div className="space-y-3 rounded-lg border border-border bg-surface p-4">
      <UsageHeader refreshing={refreshing} onRefresh={() => void onRefresh()} />
      {userPercent != null && (
        <CompactRow label={t('workspace.budget.you')} percent={userPercent} />
      )}
      {projectPercent != null && <CompactRow label={projectLabel} percent={projectPercent} />}
      <p className="text-xs text-text-muted">
        {t('workspace.budget.renewsOn', { renewsOn })}
        {lastTokens != null && lastTokens > 0
          ? ` · ${t('workspace.budget.lastReply', { tokens: formatCompactTokens(lastTokens) })}`
          : ''}
      </p>
      <p className="text-xs text-text-secondary">{t('workspace.budget.askManager')}</p>
      {activeSource === 'none' && !hasKey && (
        <p className="text-xs text-amber-600 dark:text-amber-400">{t('workspace.budget.byokCue')}</p>
      )}
    </div>
  );
}
