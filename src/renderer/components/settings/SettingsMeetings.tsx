import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Mic, Square, Trash2, RefreshCw, AlertTriangle, CheckCircle2, Shield } from 'lucide-react';
import type {
  MeetingCaptureStatus,
  MeetingListItem,
  MeetingOverview,
  MeetingSession,
  MeetingsRuntimeConfig,
  RealtimeTranscriptionDelay,
} from '../../types';
import { useAppStore } from '../../store';
import {
  isMeetingAudioActive,
  setMeetingAudioLevelListener,
  startMeetingCapture,
  stopMeetingCapture,
} from '../../meetings/meeting-audio-controller';
import { SettingsContentSection } from './shared';

const DEFAULT_RUNTIME: MeetingsRuntimeConfig = {
  realtimeTranscriptionDelay: 'low',
  allowChatReference: true,
  ingestIntoGlobalMemory: true,
  recentMeetingCount: 5,
  processDetectEnabled: true,
  storageRoot: '',
  liveAssistInstructions: '',
  liveAssistIntervalMs: 120_000,
};

function cloneRuntime(runtime?: MeetingsRuntimeConfig): MeetingsRuntimeConfig {
  return {
    ...DEFAULT_RUNTIME,
    ...(runtime || {}),
  };
}

function formatDuration(ms?: number): string {
  if (!ms || ms <= 0) return '—';
  const totalSec = Math.round(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${String(sec).padStart(2, '0')}`;
}

function permissionLabel(status: string): string {
  return status.replace(/-/g, ' ');
}

function ToggleField({
  label,
  hint,
  checked,
  onChange,
  disabled = false,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="flex items-center justify-between gap-3 rounded-lg border border-border-muted bg-background/70 px-3 py-2.5">
      <div className="min-w-0">
        <span className="text-sm text-text-primary">{label}</span>
        {hint ? <p className="mt-1 text-xs text-text-muted">{hint}</p> : null}
      </div>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="h-4 w-4 shrink-0 accent-accent disabled:opacity-50"
      />
    </label>
  );
}

export function SettingsMeetings() {
  const { t } = useTranslation();
  const appConfig = useAppStore((state) => state.appConfig);
  const setSettingsTab = useAppStore((state) => state.setSettingsTab);
  const setShowSettings = useAppStore((state) => state.setShowSettings);

  const [overview, setOverview] = useState<MeetingOverview | null>(null);
  const [runtimeDraft, setRuntimeDraft] = useState<MeetingsRuntimeConfig>(
    cloneRuntime(appConfig?.meetingsRuntime)
  );
  const [history, setHistory] = useState<MeetingListItem[]>([]);
  const [selected, setSelected] = useState<MeetingSession | null>(null);
  const [query, setQuery] = useState('');
  const [liveTranscript, setLiveTranscript] = useState('');
  const [captureStatus, setCaptureStatus] = useState<MeetingCaptureStatus | null>(null);
  const [level, setLevel] = useState(0);
  const [isBusy, setIsBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  const [liveAssistForCapture, setLiveAssistForCapture] = useState(false);
  const [liveAssistActive, setLiveAssistActive] = useState(false);
  const openSessionWithDivision = useAppStore((state) => state.openSessionWithDivision);

  const enabled = overview?.enabled ?? appConfig?.meetingsEnabled ?? true;
  const zoomConnected = overview?.zoomConnected ?? false;
  const micGranted = overview?.permissions.microphone === 'granted';
  const needsPermissions = !micGranted;

  const refreshOverview = async () => {
    const next = await window.electronAPI.meetings.getOverview();
    setOverview(next);
    setCaptureStatus(next.capture);
    setLiveTranscript(next.capture.liveTranscript || '');
  };

  const refreshHistory = async (search = query) => {
    const items = search.trim()
      ? await window.electronAPI.meetings.search(search.trim())
      : await window.electronAPI.meetings.list();
    setHistory(items);
  };

  useEffect(() => {
    setRuntimeDraft(cloneRuntime(appConfig?.meetingsRuntime));
  }, [appConfig?.meetingsRuntime]);

  useEffect(() => {
    const onFocus = () => {
      void refreshOverview();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refresh on focus only
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [nextOverview, items] = await Promise.all([
          window.electronAPI.meetings.getOverview(),
          window.electronAPI.meetings.list(),
        ]);
        if (!cancelled) {
          setOverview(nextOverview);
          setCaptureStatus(nextOverview.capture);
          setLiveTranscript(nextOverview.capture.liveTranscript || '');
          setLiveAssistActive(nextOverview.liveAssistEnabled === true);
          setHistory(items);
        }
      } catch (error) {
        if (!cancelled) {
          setStatus(error instanceof Error ? error.message : String(error));
        }
      }
    };
    void load();

    const offStatus = window.electronAPI.meetings.onStatus((next) => {
      setCaptureStatus(next);
      setLiveTranscript(next.liveTranscript || '');
      void window.electronAPI.meetings.getLiveAssist().then((status) => {
        setLiveAssistActive(status.enabled);
      });
    });
    const offSegment = window.electronAPI.meetings.onSegment((payload) => {
      setLiveTranscript(payload.liveTranscript);
    });
    const offNotes = window.electronAPI.meetings.onNotesReady((meeting) => {
      setSelected(meeting);
      void refreshHistory();
      void refreshOverview();
    });

    setMeetingAudioLevelListener(setLevel);

    const offDetected = window.electronAPI.meetings.onDetected(() => {
      void refreshOverview();
    });

    return () => {
      cancelled = true;
      offStatus();
      offSegment();
      offNotes();
      offDetected();
      setMeetingAudioLevelListener(null);
      // Do not stop capture on unmount — App owns auto Zoom capture.
    };
  }, []);

  const handleToggle = async () => {
    setIsBusy(true);
    setStatus(null);
    try {
      if (enabled && (isMeetingAudioActive() || captureStatus?.active)) {
        await stopMeetingCapture();
      }
      await window.electronAPI.meetings.setEnabled(!enabled);
      await refreshOverview();
      setStatus(!enabled ? t('meetings.enabledStatus') : t('meetings.disabledStatus'));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setIsBusy(false);
    }
  };

  const handleSaveRuntime = async () => {
    setIsBusy(true);
    setStatus(null);
    try {
      await window.electronAPI.config.save({
        meetingsRuntime: runtimeDraft,
      });
      await refreshOverview();
      setStatus(t('meetings.runtimeSaved'));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setIsBusy(false);
    }
  };

  const handleRequestPermissions = async () => {
    setIsBusy(true);
    setStatus(null);
    try {
      const result = await window.electronAPI.meetings.requestCapturePermissions();
      await refreshOverview();
      if (result.requestedMicrophone) {
        setStatus(t('meetings.permissionsMicPrompted'));
      } else {
        setStatus(t('meetings.permissionsUpdated'));
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setIsBusy(false);
    }
  };

  const handleStart = async () => {
    if (isMeetingAudioActive() || captureStatus?.active) {
      return;
    }
    setIsBusy(true);
    setStatus(null);
    try {
      await startMeetingCapture(undefined, {
        liveAssist: liveAssistForCapture,
        liveAssistInstructions: runtimeDraft.liveAssistInstructions,
      });
      setLiveTranscript('');
      setLiveAssistActive(liveAssistForCapture);
      await refreshOverview();
      setStatus(t('meetings.captureStarted'));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setIsBusy(false);
    }
  };

  const handleToggleLiveAssist = async (enabled: boolean) => {
    setIsBusy(true);
    setStatus(null);
    try {
      const result = await window.electronAPI.meetings.setLiveAssist({
        enabled,
        instructions: runtimeDraft.liveAssistInstructions,
        focusChat: enabled,
      });
      setLiveAssistActive(result.enabled);
      await refreshOverview();
      setStatus(enabled ? t('meetings.liveAssistEnabledStatus') : t('meetings.liveAssistDisabledStatus'));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setIsBusy(false);
    }
  };

  const handleOpenLiveAssistChat = () => {
    const sessionId = overview?.liveAssistSessionId;
    if (sessionId) {
      openSessionWithDivision(sessionId);
      setShowSettings(false);
    }
  };

  const handleStop = async () => {
    setIsBusy(true);
    setStatus(null);
    try {
      const meeting = await stopMeetingCapture();
      if (meeting) {
        setSelected(meeting);
      }
      await refreshHistory();
      await refreshOverview();
      setStatus(t('meetings.captureStopped'));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setIsBusy(false);
    }
  };

  const handleSelect = async (id: string) => {
    setIsBusy(true);
    setStatus(null);
    try {
      const detail = await window.electronAPI.meetings.get(id);
      setSelected(detail);
      setShowRaw(false);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setIsBusy(false);
    }
  };

  const handleDelete = async (id: string) => {
    setIsBusy(true);
    setStatus(null);
    try {
      await window.electronAPI.meetings.delete(id);
      if (selected?.id === id) {
        setSelected(null);
      }
      await refreshHistory();
      await refreshOverview();
      setStatus(t('meetings.deleted'));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setIsBusy(false);
    }
  };

  const handleClearAll = async () => {
    if (!window.confirm(t('meetings.clearAllConfirm'))) {
      return;
    }
    setIsBusy(true);
    setStatus(null);
    try {
      await window.electronAPI.meetings.clearAll();
      setSelected(null);
      await refreshHistory();
      await refreshOverview();
      setStatus(t('meetings.cleared'));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setIsBusy(false);
    }
  };

  const recording = Boolean(captureStatus?.active);

  return (
    <div className="space-y-6">
      <SettingsContentSection title={t('meetings.title')} description={t('meetings.description')}>
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border-muted bg-background/70 px-3 py-2.5">
          <div className="min-w-0">
            <p className="text-sm font-medium text-text-primary">
              {zoomConnected ? t('meetings.zoomConnected') : t('meetings.zoomNotConnected')}
            </p>
            <p className="mt-1 text-xs text-text-muted">{t('meetings.zoomGateHint')}</p>
          </div>
          {!zoomConnected ? (
            <button
              type="button"
              onClick={() => {
                setSettingsTab('connectors');
                setShowSettings(true);
              }}
              className="rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-accent/90"
            >
              {t('meetings.openZoomConnector')}
            </button>
          ) : (
            <CheckCircle2 className="h-5 w-5 shrink-0 text-success" />
          )}
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-text-primary">
              {enabled ? t('meetings.enabled') : t('meetings.disabled')}
            </p>
            <p className="mt-1 text-xs text-text-muted">{t('meetings.toggleHint')}</p>
          </div>
          <button
            type="button"
            disabled={isBusy}
            onClick={() => void handleToggle()}
            className={`rounded-lg px-3.5 py-2 text-sm font-medium transition-colors ${
              enabled
                ? 'bg-surface-hover text-text-primary'
                : 'bg-accent text-white hover:bg-accent/90'
            }`}
          >
            {enabled ? t('meetings.disableAction') : t('meetings.enableAction')}
          </button>
        </div>
      </SettingsContentSection>

      {overview?.detectedMeetingApps?.length ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-accent/30 bg-accent/5 px-4 py-3 text-sm text-text-primary">
          <p>{t('meetings.detectedApps', { apps: overview.detectedMeetingApps.join(', ') })}</p>
          {!recording ? (
            <button
              type="button"
              disabled={isBusy || !enabled || !overview?.transcriptionReady}
              onClick={() => void handleStart()}
              className="inline-flex items-center gap-2 rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-50"
            >
              <Mic className="h-4 w-4" />
              {t('meetings.startCapture')}
            </button>
          ) : null}
        </div>
      ) : null}

      <SettingsContentSection
        title={t('meetings.liveAssistDefaults')}
        description={t('meetings.liveAssistDefaultsDesc')}
      >
        <div className="space-y-3">
          <label className="block text-sm text-text-secondary">
            {t('meetings.liveAssistInstructions')}
            <textarea
              value={runtimeDraft.liveAssistInstructions || ''}
              onChange={(event) =>
                setRuntimeDraft((prev) => ({
                  ...prev,
                  liveAssistInstructions: event.target.value,
                }))
              }
              rows={3}
              placeholder={t('meetings.liveAssistInstructionsPlaceholder')}
              className="mt-1 w-full rounded-md border border-border-muted bg-background px-2 py-2 text-sm text-text-primary"
            />
          </label>
          <button
            type="button"
            disabled={isBusy}
            onClick={() => void handleSaveRuntime()}
            className="rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-white hover:bg-accent/90"
          >
            {t('meetings.saveRuntime')}
          </button>
        </div>
      </SettingsContentSection>

      <SettingsContentSection
        title={t('meetings.chatContext')}
        description={t('meetings.chatContextDesc')}
      >
        <div className="space-y-3">
          <ToggleField
            label={t('meetings.allowChatReference')}
            checked={runtimeDraft.allowChatReference}
            onChange={(checked) =>
              setRuntimeDraft((prev) => ({ ...prev, allowChatReference: checked }))
            }
          />
          <ToggleField
            label={t('meetings.ingestIntoGlobalMemory')}
            hint={t('meetings.ingestIntoGlobalMemoryHint')}
            checked={runtimeDraft.ingestIntoGlobalMemory !== false}
            onChange={(checked) =>
              setRuntimeDraft((prev) => ({ ...prev, ingestIntoGlobalMemory: checked }))
            }
          />
        </div>
      </SettingsContentSection>

      <SettingsContentSection
        title={t('meetings.permissions')}
        description={t('meetings.permissionsDesc')}
      >
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="rounded-lg border border-border-muted px-3 py-2 text-sm">
            <p className="text-text-muted">{t('meetings.microphone')}</p>
            <p className="mt-1 font-medium capitalize text-text-primary">
              {permissionLabel(overview?.permissions.microphone || 'unknown')}
            </p>
          </div>
          <div className="rounded-lg border border-border-muted px-3 py-2 text-sm">
            <p className="text-text-muted">{t('meetings.systemAudio')}</p>
            <p className="mt-1 text-sm text-text-secondary">{t('meetings.systemAudioStatus')}</p>
          </div>
        </div>
        {needsPermissions && (
          <button
            type="button"
            disabled={isBusy || !enabled}
            onClick={() => void handleRequestPermissions()}
            className="mt-3 inline-flex items-center gap-2 rounded-lg border border-border-muted px-3 py-2 text-sm text-text-primary hover:bg-surface-hover"
          >
            <Shield className="h-4 w-4" />
            {t('meetings.requestMic')}
          </button>
        )}
        <p className="mt-2 text-xs text-text-muted">{t('meetings.permissionsHint')}</p>
      </SettingsContentSection>

      <SettingsContentSection
        title={t('meetings.transcription')}
        description={t('meetings.transcriptionDesc')}
      >
        {!overview?.transcriptionReady && (
          <div className="mb-3 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-text-primary">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-500" />
            <div>
              <p>{overview?.transcriptionReadyReason || t('meetings.transcriptionNotReady')}</p>
              <button
                type="button"
                className="mt-1 text-accent underline"
                onClick={() => {
                  setSettingsTab('connectors');
                  setShowSettings(true);
                }}
              >
                {t('meetings.openConnectors')}
              </button>
            </div>
          </div>
        )}
        {overview?.transcriptionReady && (
          <div className="mb-3 flex items-center gap-2 text-sm text-text-secondary">
            <CheckCircle2 className="h-4 w-4 text-emerald-500" />
            {t('meetings.transcriptionReady')}
          </div>
        )}
        <label className="block text-sm text-text-secondary">
          {t('meetings.realtimeTranscriptionDelay')}
          <select
            value={runtimeDraft.realtimeTranscriptionDelay}
            onChange={(e) =>
              setRuntimeDraft((prev) => ({
                ...prev,
                realtimeTranscriptionDelay: e.target.value as RealtimeTranscriptionDelay,
              }))
            }
            className="mt-1 w-full rounded-md border border-border-muted bg-background px-2 py-2 text-sm text-text-primary"
          >
            <option value="minimal">minimal</option>
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
            <option value="xhigh">xhigh</option>
          </select>
        </label>
        <button
          type="button"
          disabled={isBusy}
          onClick={() => void handleSaveRuntime()}
          className="mt-3 rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-white hover:bg-accent/90"
        >
          {t('meetings.saveRuntime')}
        </button>
      </SettingsContentSection>

      <SettingsContentSection title={t('meetings.capture')} description={t('meetings.captureDesc')}>
        <p className="mb-3 text-xs text-text-muted">{t('meetings.headphonesTip')}</p>
        <p className="mb-3 text-xs text-text-muted">{t('meetings.captureTranscriptOnlyHint')}</p>
        {!recording ? (
          <ToggleField
            label={t('meetings.liveAssistForMeeting')}
            hint={t('meetings.liveAssistForMeetingHint')}
            checked={liveAssistForCapture}
            disabled={!enabled}
            onChange={setLiveAssistForCapture}
          />
        ) : (
          <div className="mb-3 space-y-2">
            <ToggleField
              label={t('meetings.liveAssistForMeeting')}
              hint={t('meetings.liveAssistForMeetingHint')}
              checked={liveAssistActive}
              disabled={isBusy}
              onChange={(checked) => void handleToggleLiveAssist(checked)}
            />
            {liveAssistActive && overview?.liveAssistSessionId ? (
              <button
                type="button"
                onClick={handleOpenLiveAssistChat}
                className="text-sm text-accent underline"
              >
                {t('meetings.openLiveAssistChat')}
              </button>
            ) : null}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-3">
          {!recording ? (
            <button
              type="button"
              disabled={isBusy || !enabled || !overview?.transcriptionReady}
              onClick={() => void handleStart()}
              className="inline-flex items-center gap-2 rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-50"
            >
              <Mic className="h-4 w-4" />
              {t('meetings.startCapture')}
            </button>
          ) : (
            <button
              type="button"
              disabled={isBusy}
              onClick={() => void handleStop()}
              className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-3.5 py-2 text-sm font-medium text-white hover:bg-red-700"
            >
              <Square className="h-4 w-4" />
              {t('meetings.stopCapture')}
            </button>
          )}
          <div className="min-w-[120px] flex-1">
            <div className="h-2 overflow-hidden rounded-full bg-surface-hover">
              <div
                className="h-full bg-accent transition-all"
                style={{ width: `${Math.min(100, Math.round(level * 400))}%` }}
              />
            </div>
            <p className="mt-1 text-[11px] text-text-muted">
              {recording ? t('meetings.recording') : t('meetings.idle')}
            </p>
          </div>
        </div>
        <div className="mt-3 max-h-40 overflow-y-auto rounded-lg border border-border-muted bg-background-secondary/60 p-3 text-sm whitespace-pre-wrap text-text-secondary">
          {liveTranscript || t('meetings.liveTranscriptEmpty')}
        </div>
      </SettingsContentSection>

      <SettingsContentSection title={t('meetings.history')} description={t('meetings.historyDesc')}>
        <div className="flex gap-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('meetings.searchPlaceholder')}
            className="flex-1 rounded-md border border-border-muted bg-background px-3 py-2 text-sm text-text-primary"
          />
          <button
            type="button"
            disabled={isBusy}
            onClick={() => void refreshHistory()}
            className="inline-flex items-center gap-1 rounded-lg border border-border-muted px-3 py-2 text-sm hover:bg-surface-hover"
          >
            <RefreshCw className="h-4 w-4" />
            {t('meetings.search')}
          </button>
        </div>

        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          <div className="max-h-80 space-y-2 overflow-y-auto">
            {history.length === 0 && (
              <p className="text-sm text-text-muted">{t('meetings.noMeetings')}</p>
            )}
            {history.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => void handleSelect(item.id)}
                className={`w-full rounded-lg border px-3 py-2 text-left transition-colors ${
                  selected?.id === item.id
                    ? 'border-accent bg-accent/10'
                    : 'border-border-muted hover:bg-surface-hover'
                }`}
              >
                <p className="truncate text-sm font-medium text-text-primary">{item.title}</p>
                <p className="mt-1 text-[11px] text-text-muted">
                  {new Date(item.startedAt).toLocaleString()} · {formatDuration(item.durationMs)} ·{' '}
                  {item.status}
                </p>
              </button>
            ))}
          </div>

          <div className="min-h-40 rounded-lg border border-border-muted p-3">
            {!selected ? (
              <p className="text-sm text-text-muted">{t('meetings.selectMeeting')}</p>
            ) : (
              <div className="space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <h4 className="text-sm font-semibold text-text-primary">{selected.title}</h4>
                    <p className="mt-1 text-[11px] text-text-muted">
                      {new Date(selected.startedAt).toLocaleString()} ·{' '}
                      {formatDuration(selected.durationMs)}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleDelete(selected.id)}
                    className="rounded-md p-1.5 text-text-muted hover:bg-surface-hover hover:text-red-500"
                    title={t('meetings.delete')}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
                {selected.notes ? (
                  <>
                    <div>
                      <p className="text-xs font-medium uppercase tracking-wide text-text-muted">
                        {t('meetings.summary')}
                      </p>
                      <p className="mt-1 text-sm text-text-secondary whitespace-pre-wrap">
                        {selected.notes.summary}
                      </p>
                    </div>
                    {selected.notes.keyTopics.length > 0 && (
                      <div>
                        <p className="text-xs font-medium uppercase tracking-wide text-text-muted">
                          {t('meetings.keyTopics')}
                        </p>
                        <ul className="mt-1 list-disc space-y-1 pl-4 text-sm text-text-secondary">
                          {selected.notes.keyTopics.map((topic) => (
                            <li key={topic}>{topic}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {selected.notes.actionItems.length > 0 && (
                      <div>
                        <p className="text-xs font-medium uppercase tracking-wide text-text-muted">
                          {t('meetings.actionItems')}
                        </p>
                        <ul className="mt-1 list-disc space-y-1 pl-4 text-sm text-text-secondary">
                          {selected.notes.actionItems.map((item) => (
                            <li key={item}>{item}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </>
                ) : (
                  <p className="text-sm text-text-muted">{t('meetings.notesPending')}</p>
                )}
                <button
                  type="button"
                  onClick={() => setShowRaw((v) => !v)}
                  className="text-sm text-accent underline"
                >
                  {showRaw ? t('meetings.hideTranscript') : t('meetings.showTranscript')}
                </button>
                {showRaw && (
                  <pre className="max-h-56 overflow-y-auto whitespace-pre-wrap rounded-md bg-background-secondary/70 p-2 text-xs text-text-secondary">
                    {selected.transcriptText || t('meetings.emptyTranscript')}
                  </pre>
                )}
              </div>
            )}
          </div>
        </div>
      </SettingsContentSection>

      <SettingsContentSection title={t('meetings.storage')} description={t('meetings.storageDesc')}>
        <p className="text-xs text-text-muted break-all">{overview?.storageRoot}</p>
        <p className="mt-1 text-sm text-text-secondary">
          {t('meetings.meetingCount', { count: overview?.meetingCount ?? 0 })}
        </p>
        <button
          type="button"
          disabled={isBusy || recording}
          onClick={() => void handleClearAll()}
          className="mt-3 rounded-lg border border-red-500/40 px-3.5 py-2 text-sm text-red-600 hover:bg-red-500/10 disabled:opacity-50"
        >
          {t('meetings.clearAll')}
        </button>
      </SettingsContentSection>

      {status && <p className="text-sm text-text-secondary">{status}</p>}
    </div>
  );
}
