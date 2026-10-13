import { useTranslation } from 'react-i18next';
import { EyeOff } from 'lucide-react';
import { useNavigation } from '../../../hooks/useNavigation';
import { TipModal } from '../TipModal';
import { DemoFrame, KeyCombo, MiniComposer, PopIn } from '../demo';
import type { TipViewProps } from '../types';

export function PrivateChatTip({ onDismiss }: TipViewProps) {
  const { t } = useTranslation();
  const nav = useNavigation();
  return (
    <TipModal
      title={t('tips.privateChat.title')}
      body={t('tips.privateChat.body')}
      media={
        <DemoFrame windowTitle="GrowthOS">
          <div className="absolute right-2 top-2">
            <KeyCombo accelerator="CommandOrControl+Shift+N" size="sm" />
          </div>
          <PopIn
            delay={-0.4}
            className="absolute inset-x-2 top-9 flex items-center gap-1.5 rounded-md border border-border-subtle bg-surface-muted px-2 py-1 text-[9px] text-text-secondary"
          >
            <EyeOff className="h-3 w-3 shrink-0 text-accent" />
            <span className="truncate">{t('chat.incognitoBanner')}</span>
          </PopIn>
          <MiniComposer
            className="absolute inset-x-2 bottom-2"
            text={t('tips.privateChat.demoText')}
            leading={<EyeOff className="h-3 w-3 shrink-0 text-text-muted" />}
          />
        </DemoFrame>
      }
      action={{ run: () => nav.newChat({ private: true }) }}
      onDismiss={onDismiss}
    />
  );
}
