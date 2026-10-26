import { useState, useEffect } from 'react';
import {
  X,
  Plug,
  Package,
  SlidersHorizontal,
  AlertCircle,
  BrainCircuit,
  AudioLines,
  RefreshCw,
  Radar,
  User,
  Lightbulb,
  UsersRound,
  Smartphone,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useWindowSize } from '../hooks/useWindowSize';
import { useAppStore } from '../store';
import { SettingsConnectors } from './settings/SettingsConnectors';
import { SettingsSkills } from './settings/SettingsSkills';
import { SettingsGeneral } from './settings/SettingsGeneral';
import { SettingsProfile } from './settings/SettingsProfile';
import { SettingsLogs } from './settings/SettingsLogs';
import { SettingsMemory } from './settings/SettingsMemory';
import { SettingsMeetings } from './settings/SettingsMeetings';
import { SettingsMatter } from './settings/SettingsMatter';
import { SettingsTips } from './settings/SettingsTips';
import { SettingsRemoteControl } from './settings/SettingsRemoteControl';
import { useUpdaterStatus } from '../hooks/useUpdaterStatus';
import { ManualInstallerDownload } from './ManualInstallerDownload';
import {
  shouldShowRestartToUpdate,
  shouldShowUpdateReadyMessage,
  isUpdateStagingForInstall,
} from '../../shared/updater-types';
import { PanelErrorBoundary } from './PanelErrorBoundary';
import { SettingsSubagents } from './settings/SettingsSubagents';

interface SettingsPanelProps {
  onClose: () => void;
  initialTab?:
    | 'connectors'
    | 'remote'
    | 'skills'
    | 'memory'
    | 'meetings'
    | 'matter'
    | 'subagents'
    | 'schedule'
    | 'logs'
    | 'profile'
    | 'general'
    | 'tips';
}

type TabId =
  | 'connectors'
  | 'remote'
  | 'skills'
  | 'memory'
  | 'meetings'
  | 'matter'
  | 'subagents'
  | 'schedule'
  | 'logs'
  | 'profile'
  | 'general'
  | 'tips';

const VALID_TABS = new Set<TabId>([
  'connectors',
  'remote',
  'skills',
  'memory',
  'meetings',
  'matter',
  'subagents',
  'schedule',
  'logs',
  'profile',
  'general',
  'tips',
]);

function SettingsConnectorsFallback({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="rounded-lg border border-error/20 bg-error/5 p-6 space-y-3 text-center">
      <AlertCircle className="w-8 h-8 mx-auto text-error" />
      <h3 className="text-sm font-medium text-text-primary">{t('mcp.pageErrorTitle')}</h3>
      <p className="text-sm text-text-muted">{t('mcp.pageErrorDescription')}</p>
      <button
        type="button"
        onClick={onRetry}
        className="px-4 py-2 rounded-lg bg-accent text-white text-sm font-medium hover:bg-accent/90"
      >
        {t('mcp.pageErrorRetry')}
      </button>
    </div>
  );
}

export function SettingsPanel({ onClose, initialTab = 'connectors' }: SettingsPanelProps) {
  const { t } = useTranslation();
  const { width } = useWindowSize();
  const compactSidebar = width < 900;
  // Read settingsTab from store at mount time so external navigation (nav-server)
  // takes effect even before this component mounts.
  const storeTab = useAppStore((s) => s.settingsTab);
  const setSettingsTab = useAppStore((s) => s.setSettingsTab);
  const setShowWorkflows = useAppStore((s) => s.setShowWorkflows);
  const setAutomationsTab = useAppStore((s) => s.setAutomationsTab);
  const resolvedInitial =
    storeTab && VALID_TABS.has(storeTab as TabId) ? (storeTab as TabId) : initialTab;

  const [activeTab, setActiveTab] = useState<TabId>(resolvedInitial);
  // Track which tabs have been viewed at least once (for lazy loading)
  const [viewedTabs, setViewedTabs] = useState<Set<TabId>>(new Set([resolvedInitial]));
  const [connectorsResetKey, setConnectorsResetKey] = useState(0);
  const [appVersion, setAppVersion] = useState('');
  const {
    status: updaterStatus,
    checking: updaterChecking,
    installing: updaterInstalling,
    installError: updaterInstallError,
    checkForUpdates,
    quitAndInstall,
    downloadingInstaller,
    installerDownload,
    downloadInstaller,
  } = useUpdaterStatus();
  const showRestartButton = shouldShowRestartToUpdate(updaterStatus.status, {
    isViteDev: import.meta.env.DEV,
    installPrepared: updaterStatus.installPrepared,
  });
  useEffect(() => {
    try {
      const v = window.electronAPI?.getVersion?.();
      if (v instanceof Promise) v.then(setAppVersion);
      else if (v) setAppVersion(v);
    } catch {
      /* ignore */
    }
  }, []);

  // Consume the store signal and apply tab in one effect
  useEffect(() => {
    if (!storeTab) return;
    // Legacy deep-link: Settings → Workflows → open first-class panel
    if (storeTab === 'workflows' || storeTab === 'schedule') {
      setSettingsTab(null);
      setAutomationsTab(storeTab === 'schedule' ? 'schedules' : 'workflows');
      setShowWorkflows(true);
      onClose();
      return;
    }
    if (VALID_TABS.has(storeTab as TabId)) {
      setActiveTab(storeTab as TabId);
      setSettingsTab(null);
    }
  }, [storeTab, setSettingsTab, setShowWorkflows, setAutomationsTab, onClose]);

  // Mark tab as viewed when it becomes active
  useEffect(() => {
    if (!viewedTabs.has(activeTab)) {
      setViewedTabs((prev) => new Set([...prev, activeTab]));
    }
  }, [activeTab]);

  const groups: Array<{
    id: string;
    label: string;
    tabs: Array<{ id: TabId; label: string; icon: typeof Plug; description: string }>;
  }> = [
    {
      id: 'you',
      label: t('settingsNav.groupYou'),
      tabs: [
        {
          id: 'profile',
          label: t('settings.profile'),
          icon: User,
          description: t('settings.profileDesc'),
        },
        {
          id: 'general',
          label: t('settingsNav.preferences'),
          icon: SlidersHorizontal,
          description: t('settings.generalDesc'),
        },
        {
          id: 'tips',
          label: t('settings.tips'),
          icon: Lightbulb,
          description: t('settings.tipsDesc'),
        },
      ],
    },
    {
      id: 'connections',
      label: t('settingsNav.groupConnections'),
      tabs: [
        {
          id: 'connectors',
          label: t('settingsNav.appsAndData'),
          icon: Plug,
          description: t('settings.connectorsDesc'),
        },
        {
          id: 'remote',
          label: t('settingsNav.remoteControl'),
          icon: Smartphone,
          description: t('settings.remoteDesc'),
        },
        {
          id: 'meetings',
          label: t('settings.meetings'),
          icon: AudioLines,
          description: t('settings.meetingsDesc'),
        },
      ],
    },
    {
      id: 'assistant',
      label: t('settingsNav.groupAssistant'),
      tabs: [
        {
          id: 'matter',
          label: t('settingsNav.briefing'),
          icon: Radar,
          description: t('settings.matterDesc'),
        },
        {
          id: 'skills',
          label: t('settings.skills'),
          icon: Package,
          description: t('settings.skillsDesc'),
        },
        {
          id: 'memory',
          label: t('settings.memory'),
          icon: BrainCircuit,
          description: t('settings.memoryDesc'),
        },
        {
          id: 'subagents',
          label: t('settings.subagents'),
          icon: UsersRound,
          description: t('settings.subagentsDesc'),
        },
      ],
    },
    {
      id: 'advanced',
      label: t('settingsNav.groupAdvanced'),
      tabs: [
        {
          id: 'logs',
          label: t('settingsNav.logs'),
          icon: AlertCircle,
          description: t('settings.logsDesc'),
        },
      ],
    },
  ];
  const tabs = groups.flatMap((g) => g.tabs);
  const activeTabMeta = tabs.find((tab) => tab.id === activeTab);

  return (
    <div className="flex h-full w-full overflow-hidden bg-background">
      {/* Sidebar */}
      <div
        className={`${compactSidebar ? 'w-14' : 'w-56'} flex flex-shrink-0 flex-col border-r border-border-subtle bg-background-secondary`}
      >
        {!compactSidebar && (
          <div className="flex-shrink-0 px-4 pb-2 pt-5">
            <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-text-primary">
              {t('settings.title')}
            </h2>
          </div>
        )}
        <nav
          className={`flex-1 min-h-0 overflow-y-auto ${compactSidebar ? 'p-1.5 space-y-1' : 'px-2.5 pb-3'}`}
          aria-label={t('settings.title')}
        >
          {groups.map((group) => (
            <div key={group.id} className={compactSidebar ? 'space-y-1' : 'mt-3 first:mt-1'}>
              {!compactSidebar && (
                <p className="px-2.5 pb-1 text-[11px] font-bold uppercase tracking-[0.05em] text-text-muted">
                  {group.label}
                </p>
              )}
              {group.tabs.map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  title={compactSidebar ? tab.label : undefined}
                  aria-current={activeTab === tab.id ? 'page' : undefined}
                  className={`flex w-full items-center rounded-md text-left transition-colors ${
                    compactSidebar ? 'justify-center p-2.5' : 'h-8 gap-2.5 px-2.5'
                  } ${
                    activeTab === tab.id
                      ? 'bg-accent-muted text-text-primary'
                      : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary'
                  }`}
                >
                  <tab.icon
                    className={`h-4 w-4 flex-shrink-0 ${
                      activeTab === tab.id ? 'text-accent-text' : 'text-text-muted'
                    }`}
                  />
                  {!compactSidebar && (
                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                      {tab.label}
                    </span>
                  )}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div
          className={`${compactSidebar ? 'p-1.5' : 'p-3'} flex-shrink-0 space-y-2 border-t border-border-subtle`}
        >
          <button
            onClick={onClose}
            className={`w-full py-2 ${compactSidebar ? 'px-2' : 'px-4'} rounded-lg bg-background hover:bg-background transition-colors text-text-secondary text-sm`}
            title={compactSidebar ? t('common.close') : undefined}
          >
            {compactSidebar ? <X className="w-4 h-4 mx-auto" /> : t('common.close')}
          </button>

          {!compactSidebar && appVersion && (
            <p className="text-[10px] text-text-muted text-center select-text">
              {t('general.versionLabel', { version: appVersion })}
            </p>
          )}

          {updaterStatus.status !== 'unsupported' && (
            <div className={`${compactSidebar ? 'space-y-1' : 'space-y-1.5'}`}>
              {!compactSidebar && (
                <>
                  {updaterStatus.status === 'idle' && (
                    <p className="text-[10px] text-text-muted text-center">
                      {t('general.updateUpToDate')}
                    </p>
                  )}
                  {(updaterStatus.status === 'checking' || updaterChecking) && (
                    <p className="text-[10px] text-text-muted text-center">
                      {t('general.updateChecking')}
                    </p>
                  )}
                  {updaterStatus.status === 'available' && updaterStatus.version && (
                    <p className="text-[10px] text-text-secondary text-center">
                      {t('general.updateAvailable', { version: updaterStatus.version })}
                    </p>
                  )}
                  {updaterStatus.status === 'downloading' && (
                    <p className="text-[10px] text-text-secondary text-center">
                      {t('general.updateDownloading', {
                        percent: updaterStatus.percent ?? 0,
                      })}
                    </p>
                  )}
                  {shouldShowUpdateReadyMessage(updaterStatus) && updaterStatus.version && (
                    <p className="text-[10px] text-text-secondary text-center">
                      {t('general.updateReady', { version: updaterStatus.version })}
                    </p>
                  )}
                  {isUpdateStagingForInstall(updaterStatus) && updaterStatus.version && (
                    <p className="text-[10px] text-text-muted text-center">
                      {t('general.updatePreparing', { version: updaterStatus.version })}
                    </p>
                  )}
                  {updaterInstallError ? (
                    <p className="text-[10px] text-red-500 text-center" role="alert">
                      {updaterInstallError}
                    </p>
                  ) : null}
                  {updaterInstalling && updaterStatus.message ? (
                    <p className="text-[10px] text-text-muted text-center">
                      {updaterStatus.message}
                    </p>
                  ) : null}
                  {updaterStatus.status === 'error' && (
                    <p className="text-[10px] text-red-500 text-center">
                      {updaterStatus.message || t('general.updateError')}
                    </p>
                  )}
                </>
              )}

              {showRestartButton ? (
                <button
                  type="button"
                  onClick={() => void quitAndInstall()}
                  disabled={updaterInstalling}
                  title={t('general.restartToUpdate')}
                  className={`w-full inline-flex items-center justify-center gap-1.5 rounded-lg bg-accent ${
                    compactSidebar ? 'p-2' : 'px-3 py-2'
                  } text-xs font-medium text-white hover:opacity-90 disabled:opacity-50`}
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${updaterInstalling ? 'animate-spin' : ''}`} />
                  {!compactSidebar && t('general.restartToUpdate')}
                </button>
              ) : (
                updaterStatus.status !== 'ready' &&
                updaterStatus.status !== 'downloading' &&
                updaterStatus.status !== 'available' && (
                  <button
                    type="button"
                    onClick={() => void checkForUpdates()}
                    disabled={updaterChecking || updaterStatus.status === 'checking'}
                    title={t('general.checkForUpdates')}
                    className={`w-full inline-flex items-center justify-center gap-1.5 rounded-lg border border-border ${
                      compactSidebar ? 'p-2' : 'px-3 py-1.5'
                    } text-[11px] text-text-secondary hover:border-accent/50 hover:text-text-primary disabled:opacity-50`}
                  >
                    <RefreshCw
                      className={`w-3.5 h-3.5 ${
                        updaterChecking || updaterStatus.status === 'checking' ? 'animate-spin' : ''
                      }`}
                    />
                    {!compactSidebar && t('general.checkForUpdates')}
                  </button>
                )
              )}

              {!compactSidebar &&
              (updaterStatus.status === 'error' || Boolean(updaterInstallError)) ? (
                <ManualInstallerDownload
                  compact
                  downloading={downloadingInstaller}
                  result={installerDownload}
                  onDownload={() => void downloadInstaller()}
                />
              ) : null}
            </div>
          )}

          {compactSidebar && appVersion && !showRestartButton && (
            <p className="text-[9px] text-text-muted text-center select-text">v{appVersion}</p>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        <div className="flex flex-shrink-0 items-start justify-between px-4 pb-4 pt-7 lg:px-9">
          <div>
            <h3 className="text-[22px] font-semibold tracking-[-0.02em] text-text-primary">
              {activeTabMeta?.label}
            </h3>
            {activeTabMeta?.description && (
              <p className="mt-1 text-sm text-text-muted max-w-[36rem]">
                {activeTabMeta.description}
              </p>
            )}
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg hover:bg-surface-hover transition-colors"
            title={t('common.close')}
            aria-label={t('common.close')}
          >
            <X className="w-5 h-5 text-text-secondary" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto overflow-x-hidden px-4 pb-10 pt-2 lg:px-9">
          <div className="max-w-[860px] w-full min-w-0 mx-auto">
            <div className="">
              <div className={activeTab === 'connectors' ? '' : 'hidden'}>
                {viewedTabs.has('connectors') && (
                  <PanelErrorBoundary
                    name="SettingsConnectors"
                    resetKey={`connectors:${connectorsResetKey}`}
                    fallback={
                      <SettingsConnectorsFallback
                        onRetry={() => setConnectorsResetKey((key) => key + 1)}
                      />
                    }
                  >
                    <SettingsConnectors isActive={activeTab === 'connectors'} />
                  </PanelErrorBoundary>
                )}
              </div>
              <div className={activeTab === 'remote' ? '' : 'hidden'}>
                {viewedTabs.has('remote') && (
                  <SettingsRemoteControl isActive={activeTab === 'remote'} />
                )}
              </div>
              <div className={activeTab === 'skills' ? '' : 'hidden'}>
                {viewedTabs.has('skills') && <SettingsSkills isActive={activeTab === 'skills'} />}
              </div>
              <div className={activeTab === 'memory' ? '' : 'hidden'}>
                {viewedTabs.has('memory') && <SettingsMemory />}
              </div>
              <div className={activeTab === 'subagents' ? '' : 'hidden'}>
                {viewedTabs.has('subagents') && <SettingsSubagents />}
              </div>
              <div className={activeTab === 'meetings' ? '' : 'hidden'}>
                {viewedTabs.has('meetings') && <SettingsMeetings />}
              </div>
              <div className={activeTab === 'matter' ? '' : 'hidden'}>
                {viewedTabs.has('matter') && <SettingsMatter />}
              </div>
              <div className={activeTab === 'logs' ? '' : 'hidden'}>
                {viewedTabs.has('logs') && <SettingsLogs isActive={activeTab === 'logs'} />}
              </div>
              <div className={activeTab === 'profile' ? '' : 'hidden'}>
                {viewedTabs.has('profile') && <SettingsProfile />}
              </div>
              <div className={activeTab === 'general' ? '' : 'hidden'}>
                {viewedTabs.has('general') && <SettingsGeneral />}
              </div>
              <div className={activeTab === 'tips' ? '' : 'hidden'}>
                {viewedTabs.has('tips') && <SettingsTips />}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
