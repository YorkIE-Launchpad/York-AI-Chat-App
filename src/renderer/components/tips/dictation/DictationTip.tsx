import { useTranslation } from 'react-i18next';
import { Mic } from 'lucide-react';
import { TipModal } from '../TipModal';
import { Callout, DemoFrame, MiniComposer, PopIn, Tap, VoiceBars } from '../demo';
import type { TipViewProps } from '../types';

export function DictationTip({ onDismiss }: TipViewProps) {
  const { t } = useTranslation();
  return (
    <TipModal
      title={t('tips.dictation.title')}
      body={t('tips.dictation.body')}
      media={
        <DemoFrame windowTitle="GrowthOS">
          <PopIn
            delay={-0.6}
            className="absolute inset-x-0 top-8 mx-auto flex w-fit items-center gap-1.5"
          >
            <Callout>
              <Mic className="h-2.5 w-2.5" />
              {t('tips.dictation.demoListening')}
            </Callout>
            <VoiceBars count={7} />
          </PopIn>
          <MiniComposer
            className="absolute inset-x-2 bottom-2"
            text={t('tips.dictation.demoText')}
            leading={
              <Tap delay={-1.4}>
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-accent text-white">
                  <Mic className="h-3 w-3" />
                </span>
              </Tap>
            }
          />
        </DemoFrame>
      }
      onDismiss={onDismiss}
    />
  );
}
