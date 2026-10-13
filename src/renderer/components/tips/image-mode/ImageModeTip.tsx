import { useTranslation } from 'react-i18next';
import { ChevronDown, ImageIcon } from 'lucide-react';
import { TipModal } from '../TipModal';
import { DemoFrame, MiniComposer, PopIn, Tap } from '../demo';
import type { TipViewProps } from '../types';

export function ImageModeTip({ onDismiss }: TipViewProps) {
  const { t } = useTranslation();
  return (
    <TipModal
      title={t('tips.imageMode.title')}
      body={t('tips.imageMode.body')}
      media={
        <DemoFrame windowTitle="GrowthOS">
          <PopIn
            delay={0.5}
            className="absolute inset-x-0 top-2 mx-auto flex h-14 w-24 items-center justify-center rounded-md bg-gradient-to-br from-accent/40 via-accent/15 to-surface-muted shadow-soft"
          >
            <ImageIcon className="h-5 w-5 text-accent" />
          </PopIn>
          <MiniComposer
            className="absolute inset-x-2 bottom-2"
            text={t('tips.imageMode.demoText')}
            leading={
              <Tap delay={-1.4}>
                <span className="inline-flex items-center gap-0.5 rounded-md border border-accent bg-accent/10 px-1 py-px text-[8px] font-semibold text-accent">
                  <ImageIcon className="h-2.5 w-2.5" />
                  {t('composer.modeImage')}
                  <ChevronDown className="h-2 w-2" />
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
