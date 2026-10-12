import {
  ChevronLeft,
  ChevronRight,
  Minus,
  Square,
  X,
  Copy,
  Mic,
  Sparkles,
  Search,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../store';
import { ToolsHealthPill } from './health/ToolsHealthPill';
import { MOD, OPEN_PALETTE_EVENT } from './CommandPalette';
import { goBack, goForward, useNavHistory } from '../hooks/useNavigationHistory';

const isMac = typeof window !== 'undefined' && window.electronAPI?.platform === 'darwin';

export function Titlebar() {
  const { t } = useTranslation();
  const [isMaximized, setIsMaximized] = useState(false);
  const [recording, setRecording] = useState(false);
  const [liveAssistEnabled, setLiveAssistEnabled] = useState(false);
  const [liveAssistSessionId, setLiveAssistSessionId] = useState<string | null>(null);
  const setShowSettings = useAppStore((s) => s.setShowSettings);
  const setSettingsTab = useAppStore((s) => s.setSettingsTab);
  const openSessionWithDivision = useAppStore((s) => s.openSessionWithDivision);
  const canGoBack = useNavHistory((h) => h.index > 0);
  const canGoForward = useNavHistory((h) => h.index < h.entries.length - 1);

  const refreshLiveAssist = async () => {
    try {
      const status = await window.electronAPI?.meetings?.getLiveAssist();
      if (status) {
        setLiveAssistEnabled(status.enabled);
        setLiveAssistSessionId(status.sessionId);
      }
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    let cancelled = false;
    void window.electronAPI?.meetings
      ?.getStatus()
      .then((status) => {
        if (!cancelled) setRecording(Boolean(status?.active));
      })
      .catch(() => undefined);
    void refreshLiveAssist();

    const off = window.electronAPI?.meetings?.onStatus((status) => {
      setRecording(Boolean(status.active));
      void refreshLiveAssist();
    });
    return () => {
      cancelled = true;
      off?.();
    };
  }, []);

  const handleMinimize = () => {
    window.electronAPI?.window.minimize();
  };

  const handleMaximize = () => {
    window.electronAPI?.window.maximize();
    setIsMaximized(!isMaximized);
  };

  const handleClose = () => {
    window.electronAPI?.window.close();
  };

  const openMeetingsSettings = () => {
    setSettingsTab('meetings');
    setShowSettings(true);
  };

  const handleToggleLiveAssist = async () => {
    const next = !liveAssistEnabled;
    try {
      const result = await window.electronAPI?.meetings?.setLiveAssist({
        enabled: next,
        focusChat: next,
      });
      if (result) {
        setLiveAssistEnabled(result.enabled);
        setLiveAssistSessionId(result.sessionId);
      }
    } catch (error) {
      console.warn('[Titlebar] Live Assist toggle failed', error);
    }
  };

  const handleOpenLiveAssistChat = () => {
    if (liveAssistSessionId) {
      openSessionWithDivision(liveAssistSessionId);
      setShowSettings(false);
    }
  };

  const recordingControls = recording ? (
    <div className="titlebar-no-drag flex items-center gap-2">
      <button
        type="button"
        onClick={openMeetingsSettings}
        className="inline-flex items-center gap-1.5 rounded-md bg-red-600/15 px-2 py-1 text-[11px] font-medium text-red-600 hover:bg-red-600/25"
        title={t('meetings.openFromIndicator')}
      >
        <Mic className="h-3 w-3 animate-pulse" />
        {t('meetings.recording')}
      </button>
      <button
        type="button"
        onClick={() => void handleToggleLiveAssist()}
        className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
          liveAssistEnabled
            ? 'bg-accent/15 text-accent hover:bg-accent/25'
            : 'bg-surface-hover text-text-secondary hover:bg-surface'
        }`}
        title={t('meetings.liveAssistForMeetingHint')}
      >
        <Sparkles className="h-3 w-3" />
        {t('meetings.liveAssistShort')}
      </button>
      {liveAssistEnabled && liveAssistSessionId ? (
        <button
          type="button"
          onClick={handleOpenLiveAssistChat}
          className="text-[11px] text-accent underline"
        >
          {t('meetings.openLiveAssistChat')}
        </button>
      ) : null}
    </div>
  ) : null;

  const historyControls = (
    <div className="titlebar-no-drag flex shrink-0 items-center">
      <button
        type="button"
        onClick={goBack}
        disabled={!canGoBack}
        className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface-hover hover:text-text-primary disabled:pointer-events-none disabled:opacity-35"
        title={`${t('nav.back')} (${MOD}[)`}
        aria-label={t('nav.back')}
      >
        <ChevronLeft className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={goForward}
        disabled={!canGoForward}
        className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface-hover hover:text-text-primary disabled:pointer-events-none disabled:opacity-35"
        title={`${t('nav.forward')} (${MOD}])`}
        aria-label={t('nav.forward')}
      >
        <ChevronRight className="h-4 w-4" />
      </button>
    </div>
  );

  const searchTrigger = (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new Event(OPEN_PALETTE_EVENT))}
      className="titlebar-no-drag inline-flex h-[26px] w-[min(420px,40vw)] items-center gap-2 rounded-md border border-border-subtle bg-surface/70 px-2.5 text-[12.5px] text-text-muted transition-colors hover:border-border hover:text-text-secondary"
      aria-label={t('palette.title')}
    >
      <Search className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate text-left">{t('palette.trigger')}</span>
      <span className="kbd">{MOD}K</span>
    </button>
  );

  return (
    <div
      className={`relative grid h-10 shrink-0 grid-cols-[1fr_auto_1fr] items-center border-b border-border-subtle bg-background-secondary titlebar-drag ${
        isMac ? 'pl-20 pr-3' : 'pl-3'
      }`}
    >
      <div className="flex min-w-0 items-center gap-2">
        {historyControls}
        {recordingControls}
      </div>
      {searchTrigger}
      <div className="flex h-full min-w-0 items-center justify-end gap-2">
        <ToolsHealthPill />
        {!isMac && (
          <div className="flex items-center titlebar-no-drag h-full">
            <button
              onClick={handleMinimize}
              className="w-12 h-full flex items-center justify-center hover:bg-surface transition-colors"
              title={t('window.minimize')}
            >
              <Minus className="w-4 h-4 text-text-secondary" />
            </button>
            <button
              onClick={handleMaximize}
              className="w-12 h-full flex items-center justify-center hover:bg-surface transition-colors"
              title={isMaximized ? t('window.restore') : t('window.maximize')}
            >
              {isMaximized ? (
                <Copy className="w-3.5 h-3.5 text-text-secondary" />
              ) : (
                <Square className="w-3.5 h-3.5 text-text-secondary" />
              )}
            </button>
            <button
              onClick={handleClose}
              className="w-12 h-full flex items-center justify-center hover:bg-red-500 transition-colors group"
              title={t('window.close')}
            >
              <X className="w-4 h-4 text-text-secondary group-hover:text-white" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
