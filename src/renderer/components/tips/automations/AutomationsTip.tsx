import { useTranslation } from 'react-i18next';
import { Clock, FileBarChart, MessageSquare } from 'lucide-react';
import { useNavigation } from '../../../hooks/useNavigation';
import { TipModal } from '../TipModal';
import { DemoFrame, MiniList } from '../demo';
import type { TipViewProps } from '../types';

export function AutomationsTip({ onDismiss }: TipViewProps) {
  const { t } = useTranslation();
  const nav = useNavigation();
  return (
    <TipModal
      title={t('tips.automations.title')}
      body={t('tips.automations.body')}
      media={
        <DemoFrame windowTitle={t('automations.title')}>
          <div className="p-2">
            <MiniList
              rows={[
                {
                  icon: FileBarChart,
                  label: t('tips.automations.demoReport'),
                  meta: t('tips.automations.demoReportWhen'),
                },
                {
                  icon: Clock,
                  label: t('tips.automations.demoTimesheet'),
                  meta: t('tips.automations.demoTimesheetWhen'),
                },
                {
                  icon: MessageSquare,
                  label: t('tips.automations.demoDigest'),
                  meta: t('tips.automations.demoDigestWhen'),
                },
              ]}
            />
          </div>
        </DemoFrame>
      }
      action={{ run: () => nav.openAutomations() }}
      onDismiss={onDismiss}
    />
  );
}
