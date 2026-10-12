/**
 * Automations: multi-step workflows and scheduled tasks in one place.
 */
import { useState } from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../store';
import { WorkflowsWorkspace } from './WorkflowsWorkspace';
import { SettingsSchedule } from '../settings/SettingsSchedule';

interface WorkflowsPageProps {
  onClose: () => void;
}

type AutomationsTab = 'workflows' | 'schedules';

export function WorkflowsPage({ onClose }: WorkflowsPageProps) {
  const { t } = useTranslation();
  const initialTab = useAppStore((s) => s.automationsTab);
  const setAutomationsTab = useAppStore((s) => s.setAutomationsTab);
  const [tab, setTabState] = useState<AutomationsTab>(initialTab);
  const [viewed, setViewed] = useState<Set<AutomationsTab>>(() => new Set([initialTab]));

  const setTab = (next: AutomationsTab) => {
    setTabState(next);
    setAutomationsTab(next);
    setViewed((prev) => (prev.has(next) ? prev : new Set([...prev, next])));
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <header className="shrink-0 px-6 pt-7 md:px-9">
        <div className="mx-auto flex w-full max-w-[1080px] items-start gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="m-0 text-[24px] font-semibold tracking-[-0.02em] text-text-primary">
              {t('automations.title')}
            </h1>
            <p className="mt-1 text-[14px] text-text-secondary">{t('automations.subtitle')}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface-hover hover:text-text-primary"
            title={t('common.close', { defaultValue: 'Close' })}
            aria-label={t('common.close', { defaultValue: 'Close' })}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="mx-auto mt-4 w-full max-w-[1080px]">
          <div className="tab-row" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'workflows'}
              onClick={() => setTab('workflows')}
              className="tab-row-item"
            >
              {t('automations.tabWorkflows')}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'schedules'}
              onClick={() => setTab('schedules')}
              className="tab-row-item"
            >
              {t('automations.tabSchedules')}
            </button>
          </div>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-10 pt-5 md:px-9">
        <div className="mx-auto w-full max-w-[1080px]">
          <div className={tab === 'workflows' ? '' : 'hidden'}>
            {viewed.has('workflows') ? <WorkflowsWorkspace /> : null}
          </div>
          <div className={tab === 'schedules' ? '' : 'hidden'}>
            {viewed.has('schedules') ? <SettingsSchedule isActive={tab === 'schedules'} /> : null}
          </div>
        </div>
      </div>
    </div>
  );
}
