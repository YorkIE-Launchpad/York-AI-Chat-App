import { useTranslation } from 'react-i18next';
import { PanelRight } from 'lucide-react';
import { TipModal } from '../TipModal';
import { Callout, DemoFrame, PopIn } from '../demo';
import type { TipViewProps } from '../types';

export function HtmlPreviewTip({ onDismiss }: TipViewProps) {
  const { t } = useTranslation();
  return (
    <TipModal
      title={t('tips.htmlPreview.title')}
      body={t('tips.htmlPreview.body')}
      media={
        <DemoFrame windowTitle="GrowthOS">
          <div className="absolute inset-y-0 left-0 w-[45%] space-y-1.5 p-2">
            <div className="ml-auto h-3 w-16 rounded-md bg-accent/20" />
            <div className="h-1 w-20 rounded bg-text-muted/30" />
            <div className="h-1 w-16 rounded bg-text-muted/25" />
            <div className="inline-flex items-center gap-0.5 rounded border border-border-subtle px-1 py-px text-[8px] text-text-secondary">
              <PanelRight className="h-2.5 w-2.5 text-accent" />
              launch-page.html
            </div>
          </div>
          <PopIn
            delay={-0.4}
            className="absolute inset-y-1.5 right-1.5 w-[52%] overflow-hidden rounded-md border border-border bg-background shadow-elevated"
          >
            <div className="h-3 bg-accent/80" />
            <div className="space-y-1 p-1.5">
              <div className="h-2 w-16 rounded bg-text-primary/50" />
              <div className="h-1 w-20 rounded bg-text-muted/30" />
              <div className="mt-1 flex gap-1">
                <div className="h-6 flex-1 rounded bg-surface-muted" />
                <div className="h-6 flex-1 rounded bg-surface-muted" />
              </div>
            </div>
            <Callout className="absolute bottom-1.5 right-1.5">
              {t('tips.htmlPreview.demoCallout')}
            </Callout>
          </PopIn>
        </DemoFrame>
      }
      onDismiss={onDismiss}
    />
  );
}
