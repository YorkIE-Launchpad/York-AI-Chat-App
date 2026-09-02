import { useTranslation } from 'react-i18next';
import {
  budgetMeterFillPercent,
  budgetMeterTone,
  formatCompactTokens,
  type BudgetMeterTone,
} from '../../shared/fe-budget-gate';
import { useAppStore } from '../store';

function toneFillClass(tone: BudgetMeterTone): string {
  if (tone === 'over') return 'bg-error';
  if (tone === 'warning') return 'bg-warning';
  return 'bg-accent';
}

function toneBorderClass(tone: BudgetMeterTone): string {
  if (tone === 'over') return 'border-error/40';
  if (tone === 'warning') return 'border-warning/40';
  return 'border-border';
}

export function toneStatusKey(tone: BudgetMeterTone): string {
  if (tone === 'over') return 'workspace.budget.over';
  if (tone === 'warning') return 'workspace.budget.high';
  return 'workspace.budget.onTrack';
}

export function toneDetailKey(tone: BudgetMeterTone): string {
  if (tone === 'over') return 'workspace.budget.overDetail';
  if (tone === 'warning') return 'workspace.budget.highDetail';
  return 'workspace.budget.onTrackDetail';
}

export function BudgetUsageTrack({
  percent,
  className = 'w-12',
  barClassName = 'h-1.5',
}: {
  percent: number;
  className?: string;
  barClassName?: string;
}) {
  const tone = budgetMeterTone(percent) ?? 'ok';
  const fill = budgetMeterFillPercent(percent);
  return (
    <div className={`relative ${className}`}>
      <div
        className={`w-full overflow-hidden rounded-full border bg-surface-muted ${toneBorderClass(tone)} ${barClassName}`}
      >
        <div
          className={`h-full rounded-full transition-all duration-500 ease-out ${toneFillClass(tone)}`}
          style={{ width: `${fill}%` }}
        />
      </div>
      {tone === 'over' && (
        <span
          className="absolute -right-px top-1/2 h-2.5 w-0.5 -translate-y-1/2 rounded-full bg-error"
          aria-hidden
        />
      )}
    </div>
  );
}

export function formatNextMonthRenewal(now = new Date()): string {
  return new Date(now.getFullYear(), now.getMonth() + 1, 1).toLocaleDateString(undefined, {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

/** Compact Hub AI budget chip next to the model picker. Click opens Settings. */
export function HubBudgetMeter() {
  const { t } = useTranslation();
  const hubUsage = useAppStore((s) => s.hubUsage);
  const activeDivision = useAppStore((s) => s.activeDivision);
  const setShowSettings = useAppStore((s) => s.setShowSettings);
  const setSettingsTab = useAppStore((s) => s.setSettingsTab);

  const userPercent = hubUsage?.userBudgetPercent ?? null;
  const projectPercent =
    activeDivision?.kind === 'project' || activeDivision?.kind === 'client'
      ? (hubUsage?.projectBudgetPercent ?? null)
      : null;
  const activeSource = hubUsage?.activeSource ?? 'none';
  const meterPercent =
    activeSource === 'project' && projectPercent != null ? projectPercent : userPercent;
  const userTone = budgetMeterTone(meterPercent);
  if (userTone == null || meterPercent == null) return null;

  const showProjectTrack =
    (activeDivision?.kind === 'project' || activeDivision?.kind === 'client') &&
    projectPercent != null &&
    userPercent != null &&
    activeSource === 'project';

  const renewsOn = formatNextMonthRenewal();
  const status = t(toneStatusKey(userTone));
  const tokens = hubUsage?.lastTurnTokens;
  const sourceLabel =
    activeSource === 'project'
      ? activeDivision?.kind === 'project' && activeDivision.name
        ? t('workspace.budget.projectNamed', { name: activeDivision.name })
        : activeDivision?.kind === 'client' && activeDivision.clientName
          ? t('workspace.budget.projectNamed', { name: activeDivision.clientName })
          : t('workspace.budget.project')
      : t('workspace.budget.you');
  const parts = [sourceLabel, status, t('workspace.budget.renewsOn', { renewsOn })];
  if (tokens != null && tokens > 0) {
    parts.push(t('workspace.budget.lastReply', { tokens: formatCompactTokens(tokens) }));
  }
  parts.push(t('workspace.budget.askManager'));
  parts.push(t('workspace.budget.openSettings'));
  const tooltip = parts.join(' · ');

  const openSettings = () => {
    setSettingsTab('general');
    setShowSettings(true);
  };

  return (
    <button
      type="button"
      onClick={openSettings}
      className={`flex h-8 w-[3.25rem] shrink-0 cursor-pointer flex-col justify-center gap-0.5 rounded-xl border px-1.5 transition-colors hover:bg-surface-hover ${toneBorderClass(userTone)}`}
      title={tooltip}
      aria-label={tooltip}
    >
      <span className="sr-only">{t('workspace.budget.openSettings')}</span>
      <BudgetUsageTrack percent={meterPercent} className="w-full" barClassName="h-1.5" />
      {showProjectTrack && projectPercent != null && (
        <BudgetUsageTrack percent={userPercent!} className="w-full" barClassName="h-1" />
      )}
    </button>
  );
}
