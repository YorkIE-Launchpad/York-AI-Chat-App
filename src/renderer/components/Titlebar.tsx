import { Minus, Square, X, Copy, Mic } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../store';

const isMac = typeof window !== 'undefined' && window.electronAPI?.platform === 'darwin';

export function Titlebar() {
  const { t } = useTranslation();
  const [isMaximized, setIsMaximized] = useState(false);
  const [recording, setRecording] = useState(false);
  const setShowSettings = useAppStore((s) => s.setShowSettings);
  const setSettingsTab = useAppStore((s) => s.setSettingsTab);

  useEffect(() => {
    let cancelled = false;
    void window.electronAPI?.meetings
      ?.getStatus()
      .then((status) => {
        if (!cancelled) setRecording(Boolean(status?.active));
      })
      .catch(() => undefined);

    const off = window.electronAPI?.meetings?.onStatus((status) => {
      setRecording(Boolean(status.active));
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

  return (
    <div
      className={`h-10 bg-background-secondary border-b border-border flex items-center titlebar-drag shrink-0 ${
        isMac ? 'justify-between pl-20 pr-3' : 'justify-end'
      }`}
    >
      {recording && (
        <button
          type="button"
          onClick={openMeetingsSettings}
          className="titlebar-no-drag inline-flex items-center gap-1.5 rounded-md bg-red-600/15 px-2 py-1 text-[11px] font-medium text-red-600 hover:bg-red-600/25"
          title={t('meetings.openFromIndicator')}
        >
          <Mic className="h-3 w-3 animate-pulse" />
          {t('meetings.recording')}
        </button>
      )}
      {!recording && isMac && <div />}

      {/* Window Controls (for Windows/Linux - macOS uses native traffic lights) */}
      {!isMac && (
        <div className="flex items-center titlebar-no-drag h-full">
          {recording && (
            <button
              type="button"
              onClick={openMeetingsSettings}
              className="mr-2 inline-flex items-center gap-1.5 rounded-md bg-red-600/15 px-2 py-1 text-[11px] font-medium text-red-600 hover:bg-red-600/25"
              title={t('meetings.openFromIndicator')}
            >
              <Mic className="h-3 w-3 animate-pulse" />
              {t('meetings.recording')}
            </button>
          )}
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
