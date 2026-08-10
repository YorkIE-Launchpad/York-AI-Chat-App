/**
 * First-class Workflows main panel (sidebar navigation, sibling to Matter).
 */
import { Workflow, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { WorkflowsWorkspace } from './WorkflowsWorkspace';

interface WorkflowsPageProps {
  onClose: () => void;
}

export function WorkflowsPage({ onClose }: WorkflowsPageProps) {
  const { t } = useTranslation();

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <header className="flex shrink-0 items-center gap-3 border-b border-border-muted px-4 py-3">
        <span className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-accent/12 text-accent">
          <Workflow className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="text-base font-semibold tracking-tight text-text-primary">
            {t('sidebar.workflows')}
          </h1>
          <p className="truncate text-[12px] text-text-muted">{t('sidebar.workflowsHint')}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg p-2 text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
          title={t('common.close', { defaultValue: 'Close' })}
          aria-label={t('common.close', { defaultValue: 'Close' })}
        >
          <X className="h-5 w-5" />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6 lg:px-8">
        <div className="mx-auto w-full max-w-[1080px]">
          <WorkflowsWorkspace />
        </div>
      </div>
    </div>
  );
}
