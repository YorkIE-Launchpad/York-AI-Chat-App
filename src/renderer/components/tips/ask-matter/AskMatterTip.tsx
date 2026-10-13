import { useTranslation } from 'react-i18next';
import { Radar, Sparkles } from 'lucide-react';
import { useNavigation } from '../../../hooks/useNavigation';
import { TipModal } from '../TipModal';
import { DemoFrame, MiniComposer, PopIn, Tap } from '../demo';
import type { TipViewProps } from '../types';

export function AskMatterTip({ onDismiss }: TipViewProps) {
  const { t } = useTranslation();
  const nav = useNavigation();
  return (
    <TipModal
      title={t('tips.askMatter.title')}
      body={t('tips.askMatter.body')}
      media={
        <DemoFrame windowTitle={t('nav.today')}>
          <div className="flex flex-wrap gap-1 p-2">
            <Tap delay={-1.6}>
              <span className="rounded-full border border-accent bg-accent/10 px-1.5 py-px text-[8px] font-medium text-accent">
                {t('today.suggest.slack')}
              </span>
            </Tap>
            <span className="rounded-full border border-border-subtle px-1.5 py-px text-[8px] text-text-secondary">
              {t('today.suggest.timesheet')}
            </span>
          </div>
          <PopIn
            delay={0.4}
            className="absolute inset-x-2 top-8 rounded-md border border-border bg-surface p-1.5 shadow-soft"
          >
            <div className="mb-1 flex items-center gap-1 text-[8px] font-semibold text-text-primary">
              <Radar className="h-2.5 w-2.5 text-accent" />
              {t('tips.askMatter.demoAnswer')}
            </div>
            <div className="space-y-1">
              <div className="h-1 w-40 rounded bg-text-muted/30" />
              <div className="h-1 w-28 rounded bg-text-muted/25" />
            </div>
          </PopIn>
          <MiniComposer
            className="absolute inset-x-2 bottom-2"
            text={t('tips.askMatter.demoText')}
            leading={<Sparkles className="h-3 w-3 shrink-0 text-accent" />}
          />
        </DemoFrame>
      }
      action={{ run: nav.goToday }}
      onDismiss={onDismiss}
    />
  );
}
