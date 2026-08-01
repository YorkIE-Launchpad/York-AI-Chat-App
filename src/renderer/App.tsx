import { Suspense, lazy, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw } from 'lucide-react';
import { useAppStore } from './store';
import {
  useActiveSessionId,
  useSettings,
  useSystemDarkMode,
  useSettingsState,
  useLayoutState,
  useGlobalNotice,
  useSandboxSetupState,
  useSandboxSyncStatus,
  usePendingDialogs,
} from './store/selectors';
import { useIPC } from './hooks/useIPC';
import { useWindowSize } from './hooks/useWindowSize';
import { useToolsReady } from './hooks/useToolsReady';
import { Sidebar } from './components/Sidebar';
import { WelcomeView } from './components/WelcomeView';
import { PermissionDialog } from './components/PermissionDialog';
import { SudoPasswordDialog } from './components/SudoPasswordDialog';
import { Titlebar } from './components/Titlebar';
import { SandboxSetupDialog } from './components/SandboxSetupDialog';
import { SandboxSyncToast } from './components/SandboxSyncToast';
import { GlobalNoticeToast } from './components/GlobalNoticeToast';
import {
  isMeetingAudioActive,
  startMeetingCapture,
  stopMeetingCapture,
} from './meetings/meeting-audio-controller';
import { PanelErrorBoundary } from './components/PanelErrorBoundary';
import { useAuth } from './auth/AuthContext';
import { LoginPage } from './components/LoginPage';

const ChatView = lazy(() =>
  import('./components/ChatView').then((module) => ({ default: module.ChatView }))
);
const ContextPanel = lazy(() =>
  import('./components/ContextPanel').then((module) => ({ default: module.ContextPanel }))
);
const SettingsPanel = lazy(() =>
  import('./components/SettingsPanel').then((module) => ({ default: module.SettingsPanel }))
);

function MainPanelFallback() {
  return (
    <div className="flex-1 min-h-0 bg-background px-6 py-6">
      <div className="h-full rounded-[1.75rem] border border-border-subtle bg-background/70" />
    </div>
  );
}

function ContextPanelFallback() {
  return (
    <div
      className="hidden xl:block w-[340px] shrink-0 border-l border-border-subtle bg-background/60"
      aria-hidden="true"
    />
  );
}

function App() {
  const { user, loading: authLoading } = useAuth();

  if (authLoading) {
    return (
      <div className="h-full w-full flex items-center justify-center bg-background">
        <div className="h-8 w-8 rounded-full border-2 border-border-subtle border-t-text-primary animate-spin" />
      </div>
    );
  }

  if (!user) {
    return <LoginPage />;
  }

  return <AuthenticatedApp />;
}

function AuthenticatedApp() {
  const { t } = useTranslation();
  // --- Store state via selectors (each subscription is minimally scoped) ---
  const activeSessionId = useActiveSessionId();
  const settings = useSettings();
  const systemDarkMode = useSystemDarkMode();
  const { showSettings } = useSettingsState();
  const { sidebarCollapsed } = useLayoutState();
  const globalNotice = useGlobalNotice();
  const { progress: sandboxSetupProgress, isComplete: isSandboxSetupComplete } =
    useSandboxSetupState();
  const sandboxSyncStatus = useSandboxSyncStatus();
  const { pendingPermission, pendingSudoPassword } = usePendingDialogs();

  // Actions are still pulled directly from the store
  const clearGlobalNotice = useAppStore((s) => s.clearGlobalNotice);
  const setGlobalNotice = useAppStore((s) => s.setGlobalNotice);
  const setSandboxSetupComplete = useAppStore((s) => s.setSandboxSetupComplete);
  const setShowSettings = useAppStore((s) => s.setShowSettings);
  const setSettingsTab = useAppStore((s) => s.setSettingsTab);
  const setSidebarCollapsed = useAppStore((s) => s.setSidebarCollapsed);
  const setContextPanelCollapsed = useAppStore((s) => s.setContextPanelCollapsed);

  const { listSessions, isElectron } = useIPC();
  const { ready: toolsReady } = useToolsReady(isElectron);
  const { width } = useWindowSize();
  const initialized = useRef(false);
  const sidebarBeforeSettings = useRef(false);

  useEffect(() => {
    // Only run once on mount
    if (initialized.current) return;
    initialized.current = true;

    if (isElectron) {
      listSessions();
    }
  }, []); // Empty deps - run once

  useEffect(() => {
    if (!isElectron || !window.electronAPI?.meetings) {
      return;
    }
    const openMeetingsSettings = () => {
      setSettingsTab('meetings');
      setShowSettings(true);
    };

    const offAutoStart = window.electronAPI.meetings.onRequestAutoStart(() => {
      void (async () => {
        const reportResult = window.electronAPI.meetings.reportAutoStartResult;
        if (isMeetingAudioActive()) {
          await reportResult?.({ ok: true });
          return;
        }
        try {
          console.log('[Meetings] Auto-start requested');
          await startMeetingCapture();
          await reportResult?.({ ok: true });
          setGlobalNotice({
            id: `meeting-auto-start-${Date.now()}`,
            type: 'info',
            message: '',
            messageKey: 'meetings.autoRecordingNotification',
            messageValues: { apps: 'Zoom' },
            actionLabelKey: 'meetings.stopCaptureAction',
            action: 'stop-meeting-capture',
            durationMs: 5_000,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.warn('[Meetings] Auto-start failed', error);
          await reportResult?.({ ok: false, error: message });
          setGlobalNotice({
            id: `meeting-auto-start-error-${Date.now()}`,
            type: 'error',
            message,
            durationMs: 6_000,
          });
        }
      })();
    });

    const offAutoStop = window.electronAPI.meetings.onRequestAutoStop(() => {
      void (async () => {
        try {
          console.log('[Meetings] Auto-stop requested');
          const meeting = await stopMeetingCapture();
          setGlobalNotice({
            id: `meeting-auto-stop-${Date.now()}`,
            type: 'success',
            message: '',
            messageKey: 'meetings.autoRecordingStoppedNotification',
            actionLabelKey: 'meetings.openMeetingsAction',
            action: 'open-meetings',
            durationMs: 5_000,
          });
          if (meeting) {
            console.log('[Meetings] Auto-stopped meeting', meeting.id);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.warn('[Meetings] Auto-stop failed', error);
          setGlobalNotice({
            id: `meeting-auto-stop-error-${Date.now()}`,
            type: 'error',
            message,
            durationMs: 6_000,
          });
        }
      })();
    });

    const offOpenSettings = window.electronAPI.meetings.onOpenSettings(() => {
      openMeetingsSettings();
    });
    return () => {
      offAutoStart();
      offAutoStop();
      offOpenSettings();
    };
  }, [isElectron, setGlobalNotice, setSettingsTab, setShowSettings]);

  // Apply theme to document root (class + color-scheme for native form controls)
  useEffect(() => {
    const effectiveTheme =
      settings.theme === 'system' ? (systemDarkMode ? 'dark' : 'light') : settings.theme;

    if (effectiveTheme === 'light') {
      document.documentElement.classList.add('light');
    } else {
      document.documentElement.classList.remove('light');
    }
    document.documentElement.style.colorScheme = effectiveTheme;
  }, [settings.theme, systemDarkMode]);

  // Auto-collapse panels based on window width
  useEffect(() => {
    setContextPanelCollapsed(width < 1100);
    setSidebarCollapsed(width < 800);
  }, [width, setContextPanelCollapsed, setSidebarCollapsed]);

  // Auto-collapse sidebar when Settings is open, restore on close
  useEffect(() => {
    if (showSettings) {
      sidebarBeforeSettings.current = !sidebarCollapsed;
      setSidebarCollapsed(true);
    } else if (sidebarBeforeSettings.current) {
      setSidebarCollapsed(false);
      sidebarBeforeSettings.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showSettings]);

  // Handle sandbox setup complete
  const handleSandboxSetupComplete = useCallback(() => {
    setSandboxSetupComplete(true);
  }, [setSandboxSetupComplete]);

  const handleGlobalNoticeAction = useCallback(
    (action: string) => {
      if (action === 'open-meetings') {
        setSettingsTab('meetings');
        setShowSettings(true);
      }
      if (action === 'stop-meeting-capture') {
        void stopMeetingCapture().catch((error) => {
          console.warn('[Meetings] Manual stop from toast failed', error);
        });
      }
      clearGlobalNotice();
    },
    [clearGlobalNotice, setSettingsTab, setShowSettings]
  );

  // Determine if we should show the sandbox setup dialog
  // Show if there's progress and setup is not complete
  const showSandboxSetup = sandboxSetupProgress && !isSandboxSetupComplete;

  return (
    <div className="h-full w-full min-h-0 flex flex-col overflow-hidden bg-background">
      {/* Titlebar - draggable region */}
      <Titlebar />

      {/* Main Content */}
      <div className="flex-1 min-h-0 flex overflow-hidden">
        {/* Sidebar */}
        <PanelErrorBoundary name="Sidebar" fallback={<div className="w-0" />}>
          <Sidebar />
        </PanelErrorBoundary>

        {/* Main Content Area */}
        <main className="flex-1 min-h-0 min-w-0 flex flex-col overflow-hidden bg-background">
          {!showSettings && !toolsReady && (
            <div
              className="px-4 py-2 text-xs text-text-secondary border-b border-border-muted bg-surface/60 flex items-center gap-2 shrink-0"
              role="status"
              aria-live="polite"
            >
              <RefreshCw
                className="w-3.5 h-3.5 animate-spin shrink-0 text-text-muted"
                style={{ animationDuration: '3s' }}
                aria-hidden="true"
              />
              <span>{t('chat.toolsNotReady')}</span>
            </div>
          )}
          {showSettings ? (
            <PanelErrorBoundary
              name="SettingsPanel"
              resetKey="settings"
              fallback={<MainPanelFallback />}
            >
              <Suspense fallback={<MainPanelFallback />}>
                <SettingsPanel onClose={() => setShowSettings(false)} />
              </Suspense>
            </PanelErrorBoundary>
          ) : activeSessionId ? (
            <PanelErrorBoundary
              name="ChatView"
              resetKey={activeSessionId}
              fallback={<MainPanelFallback />}
            >
              <Suspense fallback={<MainPanelFallback />}>
                <ChatView />
              </Suspense>
            </PanelErrorBoundary>
          ) : (
            <WelcomeView />
          )}
        </main>

        {/* Context Panel - only show when in session and not in settings */}
        {activeSessionId && !showSettings && (
          <PanelErrorBoundary
            name="ContextPanel"
            resetKey={activeSessionId}
            fallback={<ContextPanelFallback />}
          >
            <Suspense fallback={<ContextPanelFallback />}>
              <ContextPanel />
            </Suspense>
          </PanelErrorBoundary>
        )}
      </div>

      {/* Permission Dialog */}
      {pendingPermission && <PermissionDialog permission={pendingPermission} />}

      {/* Sudo Password Dialog */}
      {pendingSudoPassword && <SudoPasswordDialog request={pendingSudoPassword} />}

      {/* Sandbox Setup Dialog */}
      {showSandboxSetup && (
        <SandboxSetupDialog
          progress={sandboxSetupProgress}
          onComplete={handleSandboxSetupComplete}
        />
      )}

      {/* Sandbox Sync Toast */}
      <SandboxSyncToast status={sandboxSyncStatus} />

      <GlobalNoticeToast
        notice={globalNotice}
        onDismiss={clearGlobalNotice}
        onAction={handleGlobalNoticeAction}
      />
    </div>
  );
}

export default App;
