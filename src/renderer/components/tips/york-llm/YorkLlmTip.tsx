import { useTranslation } from 'react-i18next';
import { ChevronDown, Cpu, Sparkles } from 'lucide-react';
import { TipModal } from '../TipModal';
import { DemoFrame, MiniComposer, MiniList } from '../demo';
import type { TipViewProps } from '../types';

export function YorkLlmTip({ onDismiss }: TipViewProps) {
  const { t } = useTranslation();
  const free = t('tips.yorkLlm.demoFree');
  return (
    <TipModal
      title={t('tips.yorkLlm.title')}
      body={t('tips.yorkLlm.body')}
      media={
        <DemoFrame windowTitle="GrowthOS">
          <MiniComposer
            className="absolute inset-x-2 bottom-2"
            text={t('tips.yorkLlm.demoText')}
            menu={
              <MiniList
                className="ml-auto w-40 shadow-elevated"
                rows={[
                  { icon: Sparkles, label: 'York LLM', tag: free },
                  { icon: Cpu, label: 'Claude' },
                  { icon: Cpu, label: 'GPT' },
                ]}
              />
            }
            trailing={
              <span className="inline-flex shrink-0 items-center gap-0.5 rounded-md border border-border-subtle px-1 py-px text-[8px] text-text-secondary">
                York LLM
                <ChevronDown className="h-2 w-2" />
              </span>
            }
          />
        </DemoFrame>
      }
      onDismiss={onDismiss}
    />
  );
}
