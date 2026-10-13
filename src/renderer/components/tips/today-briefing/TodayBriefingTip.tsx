import { useTranslation } from 'react-i18next';
import { CalendarClock, Mail, MessageSquare } from 'lucide-react';
import { useNavigation } from '../../../hooks/useNavigation';
import { TipModal } from '../TipModal';
import { DemoFrame, MiniList } from '../demo';
import type { TipViewProps } from '../types';

export function TodayBriefingTip({ onDismiss }: TipViewProps) {
  const { t } = useTranslation();
  const nav = useNavigation();
  return (
    <TipModal
      title={t('tips.todayBriefing.title')}
      body={t('tips.todayBriefing.body')}
      media={
        <DemoFrame windowTitle={t('nav.today')}>
          <div className="p-2">
            <div className="text-[11px] font-semibold text-text-primary">
              {t('today.greeting.morningNoName')}
            </div>
            <div className="mb-1.5 text-[9px] text-text-secondary">
              {t('today.brief.needYou', { count: 3 })}
            </div>
            <MiniList
              rows={[
                { icon: MessageSquare, label: t('tips.todayBriefing.demoSlack'), meta: 'Slack' },
                { icon: CalendarClock, label: t('tips.todayBriefing.demoMeeting'), meta: '2:00' },
                { icon: Mail, label: t('tips.todayBriefing.demoEmail'), meta: 'Gmail' },
              ]}
            />
          </div>
        </DemoFrame>
      }
      action={{ run: nav.goToday }}
      onDismiss={onDismiss}
    />
  );
}
