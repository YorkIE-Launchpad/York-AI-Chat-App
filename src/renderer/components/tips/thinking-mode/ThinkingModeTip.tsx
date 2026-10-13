import { useTranslation } from 'react-i18next';
import { Brain } from 'lucide-react';
import { TipModal } from '../TipModal';
import { DemoFrame, MiniComposer, PopIn, Tap } from '../demo';
import type { TipViewProps } from '../types';

export function ThinkingModeTip({ onDismiss }: TipViewProps) {
  const { t } = useTranslation();
  return (
    <TipModal
      title={t('tips.thinkingMode.title')}
      body={t('tips.thinkingMode.body')}
      media={
        <DemoFrame windowTitle="GrowthOS">
          <PopIn
            delay={0.4}
            className="absolute inset-x-2 top-2 rounded-md border border-dashed border-accent/50 bg-accent/5 p-1.5"
          >
            <div className="mb-1 flex items-center gap-1 text-[8px] font-semibold text-accent">
              <Brain className="h-2.5 w-2.5" />
              {t('tips.thinkingMode.demoThinking')}
            </div>
            <div className="space-y-1">
              <div className="h-1 w-40 rounded bg-text-muted/30" />
              <div className="h-1 w-32 rounded bg-text-muted/25" />
              <div className="h-1 w-36 rounded bg-text-muted/25" />
            </div>
          </PopIn>
          <MiniComposer
            className="absolute inset-x-2 bottom-2"
            text={t('tips.thinkingMode.demoText')}
            trailing={
              <Tap delay={-0.4}>
                <span className="inline-flex items-center gap-0.5 rounded-full bg-accent px-1.5 py-px text-[8px] font-semibold text-white">
                  <Brain className="h-2.5 w-2.5" />
                  {t('chat.thinkingMode')}
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
