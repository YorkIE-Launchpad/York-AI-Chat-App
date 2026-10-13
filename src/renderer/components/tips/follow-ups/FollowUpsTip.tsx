import { useTranslation } from 'react-i18next';
import { CalendarClock, CircleDot, Hourglass } from 'lucide-react';
import { useNavigation } from '../../../hooks/useNavigation';
import { TipModal } from '../TipModal';
import { DemoFrame, MiniComposer, PopIn } from '../demo';
import type { TipViewProps } from '../types';

export function FollowUpsTip({ onDismiss }: TipViewProps) {
  const { t } = useTranslation();
  const nav = useNavigation();
  return (
    <TipModal
      title={t('tips.followUps.title')}
      body={t('tips.followUps.body')}
      media={
        <DemoFrame windowTitle={t('followUps.title')}>
          <MiniComposer className="mx-2 mt-2" text={t('tips.followUps.demoText')} />
          <PopIn
            delay={0.4}
            className="mx-2 mt-1.5 flex items-center gap-1 rounded-md bg-accent/10 px-1.5 py-1 text-[8px] text-text-secondary"
          >
            <span className="font-semibold text-accent">{t('followUps.willAdd')}</span>
            <CircleDot className="h-2.5 w-2.5 text-accent" />
            {t('followUps.iOwe')}
            <CalendarClock className="ml-1 h-2.5 w-2.5 text-accent" />
            {t('tips.followUps.demoDue')}
          </PopIn>
          <div className="mx-2 mt-1.5 flex items-center gap-1 text-[8px] text-text-muted">
            <Hourglass className="h-2.5 w-2.5" />
            {t('tips.followUps.demoWaiting')}
          </div>
        </DemoFrame>
      }
      action={{ run: () => nav.openFollowUps() }}
      onDismiss={onDismiss}
    />
  );
}
