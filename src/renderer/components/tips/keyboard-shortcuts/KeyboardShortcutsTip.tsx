import { useTranslation } from 'react-i18next';
import { TipModal } from '../TipModal';
import { DemoFrame, KeyCombo } from '../demo';
import type { TipViewProps } from '../types';

const SHORTCUTS = [
  { accelerator: 'CommandOrControl+N', labelKey: 'palette.newChat' },
  { accelerator: 'CommandOrControl+Shift+N', labelKey: 'palette.newPrivateChat' },
  { accelerator: 'CommandOrControl+1', labelKey: 'nav.today' },
  { accelerator: 'CommandOrControl+2', labelKey: 'nav.followUps' },
  { accelerator: 'CommandOrControl+3', labelKey: 'nav.automations' },
];

export function KeyboardShortcutsTip({ onDismiss }: TipViewProps) {
  const { t } = useTranslation();
  return (
    <TipModal
      title={t('tips.keyboardShortcuts.title')}
      body={t('tips.keyboardShortcuts.body')}
      media={
        <DemoFrame>
          <div className="absolute inset-3 flex flex-col justify-between">
            {SHORTCUTS.map(({ accelerator, labelKey }, i) => (
              <div key={accelerator} className="flex items-center justify-between gap-3">
                <span className="text-[10px] font-medium text-text-secondary">{t(labelKey)}</span>
                <KeyCombo accelerator={accelerator} size="sm" delay={i * 0.6} />
              </div>
            ))}
          </div>
        </DemoFrame>
      }
      onDismiss={onDismiss}
    />
  );
}
