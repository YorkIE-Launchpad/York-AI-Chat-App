import { useTranslation } from 'react-i18next';
import { CalendarCheck, MessageSquare, Search, Sparkles, Workflow } from 'lucide-react';
import { OPEN_PALETTE_EVENT } from '../../CommandPalette';
import { TipModal } from '../TipModal';
import { DemoFrame, KeyCombo, MiniList, PopIn, TypeText } from '../demo';
import type { TipViewProps } from '../types';

export function CommandPaletteTip({ onDismiss }: TipViewProps) {
  const { t } = useTranslation();
  return (
    <TipModal
      title={t('tips.commandPalette.title')}
      body={t('tips.commandPalette.body')}
      media={
        <DemoFrame>
          <div className="absolute left-3 top-3">
            <KeyCombo accelerator="CommandOrControl+K" size="sm" />
          </div>
          <PopIn
            delay={-0.6}
            className="absolute inset-x-0 top-9 mx-auto w-64 rounded-xl border border-border bg-surface p-1.5 shadow-elevated"
          >
            <div className="mb-1 flex items-center gap-1.5 rounded-md bg-surface-muted px-2 py-1 text-[9px] text-text-primary">
              <Search className="h-3 w-3 text-text-muted" />
              <TypeText text={t('tips.commandPalette.demoQuery')} />
            </div>
            <MiniList
              rows={[
                { icon: Sparkles, label: t('tips.commandPalette.demoAsk') },
                { icon: CalendarCheck, label: t('nav.today'), meta: '⌘1' },
                { icon: Workflow, label: t('nav.automations'), meta: '⌘3' },
                { icon: MessageSquare, label: t('tips.commandPalette.demoRecent') },
              ]}
            />
          </PopIn>
        </DemoFrame>
      }
      action={{ run: () => window.dispatchEvent(new Event(OPEN_PALETTE_EVENT)) }}
      onDismiss={onDismiss}
    />
  );
}
