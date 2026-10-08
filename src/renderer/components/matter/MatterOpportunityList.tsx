import { Bug, TrendingUp, Repeat } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  OPPORTUNITY_TARGET_LABELS,
  type MatterOpportunity,
  type OpportunityKind,
} from '../../../shared/matter';

interface MatterOpportunityListProps {
  opportunities: MatterOpportunity[];
  enabled: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
}

const GROUPS: Array<{ kind: OpportunityKind; labelKey: string }> = [
  { kind: 'platform_issue', labelKey: 'matter.opportunities.groupPlatform' },
  { kind: 'cross_sell', labelKey: 'matter.opportunities.groupCrossSell' },
  { kind: 'upsell', labelKey: 'matter.opportunities.groupUpsell' },
];

export const OPPORTUNITY_KIND_CLASS: Record<OpportunityKind, string> = {
  platform_issue: 'text-amber-400 border-amber-400/30 bg-amber-400/10',
  cross_sell: 'text-emerald-400 border-emerald-400/30 bg-emerald-400/10',
  upsell: 'text-accent border-accent/30 bg-accent/10',
};

export function OpportunityKindIcon({
  kind,
  className,
}: {
  kind: OpportunityKind;
  className?: string;
}) {
  if (kind === 'platform_issue') return <Bug className={className} />;
  if (kind === 'cross_sell') return <Repeat className={className} />;
  return <TrendingUp className={className} />;
}

export function MatterOpportunityList({
  opportunities,
  enabled,
  selectedId,
  onSelect,
}: MatterOpportunityListProps) {
  const { t } = useTranslation();

  if (!enabled) {
    return (
      <p className="text-[12px] text-text-muted px-1 py-4">{t('matter.opportunities.disabled')}</p>
    );
  }
  if (opportunities.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border-muted px-3 py-6 text-center">
        <p className="text-[12px] text-text-muted">{t('matter.opportunities.empty')}</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {GROUPS.map((group) => {
        const items = opportunities.filter((o) => o.kind === group.kind);
        if (!items.length) return null;
        return (
          <div key={group.kind}>
            <p className="px-1 mb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-text-muted">
              {t(group.labelKey)} <span className="opacity-70">{items.length}</span>
            </p>
            <div className="space-y-2">
              {items.map((opp) => (
                <button
                  key={opp.id}
                  type="button"
                  onClick={() => onSelect(opp.id)}
                  className={`w-full text-left rounded-xl border px-3 py-2.5 transition-colors ${
                    selectedId === opp.id
                      ? 'border-accent/50 bg-accent/10'
                      : 'border-border-subtle bg-surface/60 hover:bg-surface-hover'
                  }`}
                >
                  <div className="flex items-start gap-2">
                    <OpportunityKindIcon
                      kind={opp.kind}
                      className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${OPPORTUNITY_KIND_CLASS[opp.kind].split(' ')[0]}`}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-[13px] font-semibold text-text-primary leading-snug line-clamp-2">
                        {opp.title}
                      </p>
                      {opp.summary ? (
                        <p className="mt-0.5 text-[11px] text-text-secondary line-clamp-2">
                          {opp.summary}
                        </p>
                      ) : null}
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        <span className="rounded-md border border-border-subtle px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-text-secondary">
                          {OPPORTUNITY_TARGET_LABELS[opp.target]}
                        </span>
                        {opp.clientName ? (
                          <span className="rounded-md border border-border-subtle px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-text-muted">
                            {opp.clientName}
                          </span>
                        ) : null}
                        <span className="rounded-md border border-border-subtle px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-text-muted">
                          {opp.source} · {Math.round(opp.confidence * 100)}%
                        </span>
                      </div>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
