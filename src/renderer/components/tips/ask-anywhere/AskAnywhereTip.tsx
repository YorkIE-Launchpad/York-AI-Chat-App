import { useTranslation } from 'react-i18next';
import { Mic, Sparkles } from 'lucide-react';
import { ASK_GROWTHOS_SHORTCUT } from '../../../../shared/screen-snap';
import { useAppStore } from '../../../store';
import { TipModal } from '../TipModal';
import { DemoFrame, KeyCombo, MiniComposer, PopIn, VoiceBars } from '../demo';
import type { TipViewProps } from '../types';

export function AskAnywhereTip({ onDismiss }: TipViewProps) {
  const { t } = useTranslation();
  return (
    <TipModal
      title={t('tips.askAnywhere.title')}
      body={t('tips.askAnywhere.body')}
      media={
        <DemoFrame>
          <div className="absolute inset-x-6 top-3 bottom-3 rounded-md border border-border-subtle bg-surface/60" />
          <div className="absolute inset-x-0 top-5 flex justify-center">
            <KeyCombo accelerator={ASK_GROWTHOS_SHORTCUT} />
          </div>
          <PopIn
            delay={0.2}
            className="absolute inset-x-0 top-14 mx-auto w-60 rounded-xl border border-border bg-surface p-2 shadow-elevated"
          >
            <div className="mb-1.5 flex items-center gap-1 text-[9px] font-semibold text-text-primary">
              <Sparkles className="h-3 w-3 text-accent" />
              {t('askGrowthOS.title')}
            </div>
            <MiniComposer
              text={t('tips.askAnywhere.demoPrompt')}
              leading={<Mic className="h-3 w-3 shrink-0 text-accent" />}
              trailing={<VoiceBars />}
            />
          </PopIn>
        </DemoFrame>
      }
      action={{ run: () => useAppStore.getState().toggleAskGrowthOS() }}
      onDismiss={onDismiss}
    />
  );
}
