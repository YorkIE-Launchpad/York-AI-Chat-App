import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatAccelerator } from '../../../utils/shortcut-accelerator';
import { TipModal } from '../TipModal';
import type { TipViewProps } from '../types';
import { SnapWiggleDemo } from './SnapWiggleDemo';

/** "Shake the pointer to snap, chat, and insert from anywhere" tip. */
export function SnapWiggleTip({ onDismiss }: TipViewProps) {
  const { t } = useTranslation();
  const [shortcut, setShortcut] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.electronAPI?.snap
      ?.getShortcut()
      .then((result) => {
        if (!cancelled) setShortcut(result.shortcut);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <TipModal
      title={t('tips.snapWiggle.title')}
      body={t('tips.snapWiggle.body')}
      media={<SnapWiggleDemo />}
      footerHint={
        shortcut ? t('tips.snapWiggle.shortcut', { shortcut: formatAccelerator(shortcut) }) : null
      }
      onDismiss={onDismiss}
    />
  );
}
