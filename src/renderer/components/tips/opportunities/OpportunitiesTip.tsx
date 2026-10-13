import { useTranslation } from 'react-i18next';
import { AlertTriangle, Send, TrendingUp, Users } from 'lucide-react';
import { useNavigation } from '../../../hooks/useNavigation';
import { TipModal } from '../TipModal';
import { DemoFrame, MiniList, PopIn } from '../demo';
import type { TipViewProps } from '../types';

export function OpportunitiesTip({ onDismiss }: TipViewProps) {
  const { t } = useTranslation();
  const nav = useNavigation();
  return (
    <TipModal
      title={t('tips.opportunities.title')}
      body={t('tips.opportunities.body')}
      media={
        <DemoFrame windowTitle={t('matter.opportunities.title')}>
          <div className="p-2">
            <MiniList
              rows={[
                {
                  icon: AlertTriangle,
                  label: t('tips.opportunities.demoIssue'),
                  tag: t('matter.opportunities.kind.platform_issue'),
                },
                {
                  icon: Users,
                  label: t('tips.opportunities.demoCrossSell'),
                  tag: t('matter.opportunities.kind.cross_sell'),
                },
                {
                  icon: TrendingUp,
                  label: t('tips.opportunities.demoUpsell'),
                  tag: t('matter.opportunities.kind.upsell'),
                },
              ]}
            />
          </div>
          <PopIn
            delay={0.6}
            className="absolute bottom-2 right-2 flex items-center gap-1 rounded-md border border-border bg-surface px-1.5 py-1 text-[8px] shadow-elevated"
          >
            <span className="text-text-muted">#platform-team</span>
            <span className="inline-flex items-center gap-0.5 rounded bg-accent px-1 py-px font-semibold text-white">
              <Send className="h-2.5 w-2.5" />
              {t('matter.opportunities.report')}
            </span>
          </PopIn>
        </DemoFrame>
      }
      action={{ run: nav.goToday }}
      onDismiss={onDismiss}
    />
  );
}
