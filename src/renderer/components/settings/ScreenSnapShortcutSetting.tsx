import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Keyboard, MousePointer2 } from 'lucide-react';
import { useAppStore } from '../../store';
import { formatAccelerator, keyEventToAccelerator } from '../../utils/shortcut-accelerator';
import {
  DEFAULT_SCREEN_SNAP_SHORTCUT,
  DEFAULT_SCREEN_SNAP_WIGGLE,
  type ScreenSnapShortcutResult,
} from '../../../shared/screen-snap';

type ErrorReason = Extract<ScreenSnapShortcutResult, { success: false }>['reason'];

/** Settings row to record, reset, or disable the global Screen Snap shortcut (macOS). */
export function ScreenSnapShortcutSetting() {
  const { t } = useTranslation();
  const appConfig = useAppStore((s) => s.appConfig);
  const setAppConfig = useAppStore((s) => s.setAppConfig);
  const snapApi = typeof window !== 'undefined' ? window.electronAPI?.snap : undefined;

  const [supported, setSupported] = useState(false);
  const [activeShortcut, setActiveShortcut] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ErrorReason | null>(null);
  const [wiggle, setWiggle] = useState(DEFAULT_SCREEN_SNAP_WIGGLE);

  const savedShortcut =
    appConfig?.screenSnapShortcut === undefined
      ? DEFAULT_SCREEN_SNAP_SHORTCUT
      : appConfig.screenSnapShortcut;

  useEffect(() => {
    if (!snapApi) return;
    void snapApi.getShortcut().then((result) => {
      setSupported(result.supported);
      setActiveShortcut(result.shortcut);
    });
    void snapApi.getWiggle().then((result) => setWiggle(result.enabled));
  }, [snapApi]);

  const toggleWiggle = async () => {
    if (!snapApi) return;
    const result = await snapApi.setWiggle(!wiggle);
    setWiggle(result.enabled);
    const current = useAppStore.getState().appConfig;
    if (current) setAppConfig({ ...current, screenSnapWiggle: result.enabled });
  };

  const applyShortcut = useCallback(
    async (shortcut: string | null) => {
      if (!snapApi) return;
      setSaving(true);
      setError(null);
      try {
        const result = await snapApi.setShortcut(shortcut);
        setActiveShortcut(result.shortcut);
        if (result.success) {
          const current = useAppStore.getState().appConfig;
          if (current) setAppConfig({ ...current, screenSnapShortcut: result.shortcut });
        } else {
          setError(result.reason);
        }
      } catch {
        setError('conflict');
      } finally {
        setSaving(false);
        setRecording(false);
      }
    },
    [setAppConfig, snapApi]
  );

  useEffect(() => {
    if (!recording) return;
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      const noModifiers = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
      if (event.key === 'Escape' && noModifiers) {
        setRecording(false);
        return;
      }
      const accelerator = keyEventToAccelerator(event);
      if (!accelerator) return;
      void applyShortcut(accelerator);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [recording, applyShortcut]);

  if (!snapApi || !supported) return null;

  const notRegistered = savedShortcut !== null && activeShortcut === null && !error;
  const errorMessage =
    error === 'conflict'
      ? t('general.snapShortcutConflict')
      : error === 'reserved'
        ? t('general.snapShortcutReserved')
        : error === 'invalid'
          ? t('general.snapShortcutInvalid')
          : null;

  return (
    <div className="space-y-3 pt-2 border-t border-border">
      <h4 className="text-sm font-medium text-text-primary">{t('general.snapShortcut')}</h4>
      <p className="text-sm text-text-secondary">{t('general.snapShortcutHelp')}</p>
      <div className="flex flex-wrap items-center gap-2">
        <div
          className={`inline-flex min-w-[7rem] items-center justify-center gap-2 rounded-lg border-2 px-3 py-1.5 font-mono text-sm ${
            recording
              ? 'border-accent bg-accent/5 text-accent animate-pulse'
              : 'border-border bg-surface text-text-primary'
          }`}
          aria-live="polite"
        >
          <Keyboard className="h-3.5 w-3.5" />
          {recording
            ? t('general.snapShortcutRecording')
            : savedShortcut
              ? formatAccelerator(savedShortcut)
              : t('general.snapShortcutDisabled')}
        </div>
        {recording ? (
          <button
            type="button"
            onClick={() => setRecording(false)}
            className="rounded-lg border border-border px-3 py-1.5 text-sm text-text-secondary hover:border-accent/50"
          >
            {t('common.cancel', 'Cancel')}
          </button>
        ) : (
          <button
            type="button"
            disabled={saving}
            onClick={() => {
              setError(null);
              setRecording(true);
            }}
            className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            {t('general.snapShortcutChange')}
          </button>
        )}
        {!recording && savedShortcut !== DEFAULT_SCREEN_SNAP_SHORTCUT && (
          <button
            type="button"
            disabled={saving}
            onClick={() => void applyShortcut(DEFAULT_SCREEN_SNAP_SHORTCUT)}
            className="rounded-lg border border-border px-3 py-1.5 text-sm text-text-secondary hover:border-accent/50 disabled:opacity-50"
          >
            {t('general.snapShortcutReset')}
          </button>
        )}
        {!recording && savedShortcut !== null && (
          <button
            type="button"
            disabled={saving}
            onClick={() => void applyShortcut(null)}
            className="rounded-lg border border-border px-3 py-1.5 text-sm text-text-secondary hover:border-accent/50 disabled:opacity-50"
          >
            {t('general.snapShortcutDisable')}
          </button>
        )}
      </div>
      {recording && (
        <p className="text-xs text-text-muted">{t('general.snapShortcutRecordingHint')}</p>
      )}
      {errorMessage && <p className="text-xs text-error">{errorMessage}</p>}
      {notRegistered && (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          {t('general.snapShortcutNotRegistered')}
        </p>
      )}
      <label className="flex cursor-pointer items-start justify-between gap-4 pt-1">
        <span className="flex items-start gap-2">
          <MousePointer2 className="mt-0.5 h-4 w-4 text-text-secondary" />
          <span>
            <span className="block text-sm text-text-primary">{t('general.snapWiggle')}</span>
            <span className="block text-xs text-text-muted">{t('general.snapWiggleHelp')}</span>
          </span>
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={wiggle}
          aria-label={t('general.snapWiggle')}
          onClick={() => void toggleWiggle()}
          className={`relative h-5 w-9 flex-shrink-0 rounded-full transition-colors ${
            wiggle ? 'bg-accent' : 'bg-border'
          }`}
        >
          <span
            className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${
              wiggle ? 'translate-x-[18px]' : 'translate-x-0.5'
            }`}
          />
        </button>
      </label>
    </div>
  );
}
