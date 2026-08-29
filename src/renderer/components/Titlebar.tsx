import { Minus, Square, X, Copy, Mic, Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../store';

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

  return (
    <div
      className={`h-10 bg-background-secondary border-b border-border flex items-center titlebar-drag shrink-0 ${
        isMac ? 'justify-between pl-20 pr-3' : 'justify-end'
      }`}
    >
      {isMac ? recordingControls : null}
      {!recording && isMac && <div />}

      {!isMac && (
        <div className="flex items-center titlebar-no-drag h-full">
          {recordingControls}
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
  );
}
