import { useTranslation } from 'react-i18next';
import { BrainCircuit, Check } from 'lucide-react';
import { useNavigation } from '../../../hooks/useNavigation';
import { TipModal } from '../TipModal';
import { Callout, DemoFrame, MiniComposer, PopIn } from '../demo';
import type { TipViewProps } from '../types';

export function MemoryTip({ onDismiss }: TipViewProps) {
  const { t } = useTranslation();
  const nav = useNavigation();
  return (
    <TipModal
      title={t('tips.memory.title')}
      body={t('tips.memory.body')}
      media={
        <DemoFrame windowTitle="GrowthOS">
          <PopIn delay={0.4} className="absolute inset-x-0 top-4 mx-auto w-fit">
            <Callout>
              <BrainCircuit className="h-2.5 w-2.5" />
              {t('tips.memory.demoSaved')}
              <Check className="h-2.5 w-2.5" />
            </Callout>
          </PopIn>
          <PopIn
            delay={0.9}
            className="absolute inset-x-2 top-11 rounded-md border border-border-subtle bg-surface-muted p-1.5 text-[8px] text-text-secondary"
          >
            {t('tips.memory.demoLater')}
          </PopIn>
          <MiniComposer className="absolute inset-x-2 bottom-2" text={t('tips.memory.demoText')} />
        </DemoFrame>
      }
      action={{ run: () => nav.openSettings('memory') }}
      onDismiss={onDismiss}
    />
  );
}
