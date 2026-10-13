import { useTranslation } from 'react-i18next';
import { AudioLines, ListChecks, User } from 'lucide-react';
import { useNavigation } from '../../../hooks/useNavigation';
import { TipModal } from '../TipModal';
import { Callout, DemoFrame, PopIn, VoiceBars } from '../demo';
import type { TipViewProps } from '../types';

export function MeetingsTip({ onDismiss }: TipViewProps) {
  const { t } = useTranslation();
  const nav = useNavigation();
  return (
    <TipModal
      title={t('tips.meetings.title')}
      body={t('tips.meetings.body')}
      media={
        <DemoFrame windowTitle="Zoom">
          <div className="flex gap-1.5 p-2">
            {['Dana', 'Raj'].map((name) => (
              <div
                key={name}
                className="flex h-14 flex-1 flex-col items-center justify-center gap-1 rounded-md bg-surface-muted"
              >
                <User className="h-4 w-4 text-text-muted" />
                <span className="text-[8px] text-text-secondary">{name}</span>
              </div>
            ))}
          </div>
          <div className="absolute left-2 top-2 flex items-center gap-1">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-error" />
            <VoiceBars count={4} />
          </div>
          <PopIn
            delay={0.3}
            className="absolute inset-x-2 bottom-2 rounded-md border border-border bg-surface p-1.5 shadow-elevated"
          >
            <div className="mb-1 flex items-center justify-between">
              <span className="flex items-center gap-1 text-[8px] font-semibold text-text-primary">
                <AudioLines className="h-2.5 w-2.5 text-accent" />
                {t('tips.meetings.demoNotes')}
              </span>
              <Callout>{t('tips.meetings.demoLiveAssist')}</Callout>
            </div>
            <div className="flex items-center gap-1 text-[8px] text-text-secondary">
              <ListChecks className="h-2.5 w-2.5 text-accent" />
              {t('tips.meetings.demoActionItems')}
            </div>
          </PopIn>
        </DemoFrame>
      }
      action={{ run: () => nav.openSettings('meetings') }}
      onDismiss={onDismiss}
    />
  );
}
