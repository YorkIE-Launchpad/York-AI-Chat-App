import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MessageSquare, PenLine } from 'lucide-react';
import { DEFAULT_SCREEN_SNAP_SHORTCUT } from '../../../../shared/screen-snap';
import { TipModal } from '../TipModal';
import { Callout, DemoFrame, KeyCombo, PopIn, Tap } from '../demo';
import type { TipViewProps } from '../types';

export function SnapShortcutTip({ onDismiss }: TipViewProps) {
  const { t } = useTranslation();
  const [shortcut, setShortcut] = useState(DEFAULT_SCREEN_SNAP_SHORTCUT);

  useEffect(() => {
    let cancelled = false;
    void window.electronAPI?.snap
      ?.getShortcut()
      .then((result) => {
        if (!cancelled && result.shortcut) setShortcut(result.shortcut);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <TipModal
      title={t('tips.snapShortcut.title')}
      body={t('tips.snapShortcut.body')}
      media={
        <DemoFrame windowTitle={t('tips.snapShortcut.demoApp')}>
          <div className="space-y-1.5 p-2.5">
            <div className="h-1 w-32 rounded bg-text-muted/30" />
            <div className="h-1 w-24 rounded bg-text-muted/25" />
            <div className="h-1 w-28 rounded bg-text-muted/25" />
          </div>
          <div className="absolute right-2 top-2">
            <KeyCombo accelerator={shortcut} size="sm" />
          </div>
          <PopIn
            delay={-0.4}
            className="absolute left-2 top-2 h-10 w-36 rounded-sm border-[1.5px] border-dashed border-accent bg-accent/10"
          />
          <PopIn
            delay={0.3}
            className="absolute bottom-2 right-2 w-40 rounded-lg border border-border bg-surface p-1.5 shadow-elevated"
          >
            <div className="flex gap-1 rounded-md bg-surface-muted p-0.5 text-[8px] font-medium">
              <span className="flex flex-1 items-center justify-center gap-0.5 rounded px-1 py-0.5 text-text-muted">
                <MessageSquare className="h-2.5 w-2.5" />
                {t('tips.snapShortcut.demoChat')}
              </span>
              <Tap delay={0.6} className="flex-1">
                <span className="flex w-full items-center justify-center gap-0.5 rounded bg-accent px-1 py-0.5 text-white">
                  <PenLine className="h-2.5 w-2.5" />
                  {t('tips.snapShortcut.demoWrite')}
                </span>
              </Tap>
            </div>
            <div className="mt-1.5 flex justify-end">
              <Callout>{t('tips.snapShortcut.demoCallout')}</Callout>
            </div>
          </PopIn>
        </DemoFrame>
      }
      onDismiss={onDismiss}
    />
  );
}
