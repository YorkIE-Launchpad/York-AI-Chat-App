import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore, type InspectorTab } from '../../store';

interface InspectorTabsProps {
  /** Rendered before the tabs (e.g. the collapse button). */
  leading?: ReactNode;
  sourceCount?: number;
  fileCount?: number;
}

/** Tab strip shared by the right panel: Preview (while open) · Context · Sources · Files. */
export function InspectorTabs({ leading, sourceCount, fileCount }: InspectorTabsProps) {
  const { t } = useTranslation();
  const hasPreview = useAppStore((s) => Boolean(s.activeHtmlPreview));
  const storeTab = useAppStore((s) => s.inspectorTab);
  const setInspectorTab = useAppStore((s) => s.setInspectorTab);
  const active = resolveInspectorTab(storeTab, hasPreview);

  const tabs: Array<{ id: InspectorTab; label: string; count?: number }> = [
    ...(hasPreview ? [{ id: 'preview' as const, label: t('inspector.preview') }] : []),
    { id: 'context', label: t('inspector.context') },
    { id: 'sources', label: t('inspector.sources'), count: sourceCount },
    { id: 'files', label: t('inspector.files'), count: fileCount },
  ];

  return (
    <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border-muted px-2">
      {leading}
      <div
        className="tab-row h-full flex-1 items-stretch gap-4 border-b-0"
        role="tablist"
        aria-label={t('inspector.label')}
      >
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active === tab.id}
            onClick={() => setInspectorTab(tab.id)}
            className="tab-row-item"
          >
            {tab.label}
            {tab.count ? <span className="tab-row-count">{tab.count}</span> : null}
          </button>
        ))}
      </div>
    </div>
  );
}

export function resolveInspectorTab(tab: InspectorTab, hasPreview: boolean): InspectorTab {
  return tab === 'preview' && !hasPreview ? 'context' : tab;
}
