import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Keyboard, Mic } from 'lucide-react';
import { SettingsSwitch } from './shared';
import { formatAccelerator, keyEventToAccelerator } from '../../utils/shortcut-accelerator';
import type { ScreenSnapShortcutResult } from '../../../shared/screen-snap';
import {
  DEFAULT_VOICE_CONTROL,
  DEFAULT_VOICE_HOTKEY,
  type VoiceControlConfig,
} from '../../../shared/voice-control';

type HotkeyError = Extract<ScreenSnapShortcutResult, { success: false }>['reason'];

const FOLLOW_UP_OPTIONS = [10, 20, 30, 60];

/** Settings section for hands-free voice control (macOS). */
export function VoiceControlSetting() {
  const { t } = useTranslation();
  const voiceApi = typeof window !== 'undefined' ? window.electronAPI?.voice : undefined;

  const [supported, setSupported] = useState(false);
  const [config, setConfig] = useState<VoiceControlConfig>(DEFAULT_VOICE_CONTROL);
  const [activeHotkey, setActiveHotkey] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [hotkeyError, setHotkeyError] = useState<HotkeyError | null>(null);
  const [siriMessage, setSiriMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!voiceApi) return;
    void voiceApi.getHotkey().then((result) => {
      setSupported(result.supported);
      setActiveHotkey(result.hotkey);
    });
    void voiceApi.getConfig().then(setConfig);
  }, [voiceApi]);

  const update = useCallback(
    async (partial: Partial<VoiceControlConfig>) => {
      if (!voiceApi) return;
      setConfig(await voiceApi.updateConfig(partial));
    },
    [voiceApi]
  );

  const applyHotkey = useCallback(
    async (hotkey: string | null) => {
      if (!voiceApi) return;
      setHotkeyError(null);
      try {
        const result = await voiceApi.setHotkey(hotkey);
        setActiveHotkey(result.shortcut);
        if (result.success) setConfig((current) => ({ ...current, hotkey: result.shortcut }));
        else setHotkeyError(result.reason);
      } finally {
        setRecording(false);
      }
    },
    [voiceApi]
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
      if (accelerator) void applyHotkey(accelerator);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [recording, applyHotkey]);

  if (!voiceApi || !supported) return null;

  const addToSiri = async () => {
    setSiriMessage(null);
    const result = await voiceApi.addSiriShortcut();
    setSiriMessage(
      result.success
        ? t(
            'voice.siriAdded',
            'Shortcuts opened. Click "Add Shortcut", then say "Hey Siri, York" to start voice control.'
          )
        : (result.error ?? t('voice.siriFailed', 'Could not open the Siri shortcut.'))
    );
  };

  const hotkeyErrorText =
    hotkeyError === 'conflict'
      ? t('voice.hotkeyConflict', 'Another app already uses this shortcut. Pick a different one.')
      : hotkeyError === 'reserved'
        ? t('voice.hotkeyReserved', 'That shortcut is reserved. Pick a different one.')
        : hotkeyError === 'invalid'
          ? t('voice.hotkeyInvalid', 'Use at least one of Command, Control, or Option.')
          : null;
  const hotkeyNotRegistered = config.hotkey !== null && activeHotkey === null && !hotkeyError;

  return (
    <div className="space-y-3 pt-2 border-t border-border">
      <div className="flex items-center gap-3">
        <SettingsSwitch
          checked={config.enabled}
          onChange={() => void update({ enabled: !config.enabled })}
          aria-label={t('voice.title', 'Voice control')}
        />
        <div>
          <h4 className="flex items-center gap-1.5 text-sm font-medium text-text-primary">
            <Mic className="h-3.5 w-3.5 text-text-secondary" />
            {t('voice.title', 'Voice control')}
          </h4>
          <p className="text-sm text-text-secondary">
            {t(
              'voice.help',
              'Control your Mac by speaking: "scroll down", "next tab", "open Slack". The mic only opens when you trigger it.'
            )}
          </p>
        </div>
      </div>

      {config.enabled && (
        <div className="space-y-4 pl-1">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void voiceApi.trigger()}
              className="inline-flex h-8 items-center rounded-lg bg-accent px-3 text-sm font-medium text-white"
            >
              {t('voice.tryIt', 'Try it now')}
            </button>
            <button
              type="button"
              onClick={() => void addToSiri()}
              className="inline-flex h-8 items-center rounded-lg border border-border px-3 text-sm text-text-secondary hover:border-accent/50"
            >
              {t('voice.addToSiri', 'Add "Hey Siri, York"')}
            </button>
            <button
              type="button"
              onClick={() => void voiceApi.openMicrophoneSettings()}
              className="inline-flex h-8 items-center rounded-lg border border-border px-3 text-sm text-text-secondary hover:border-accent/50"
            >
              {t('voice.micSettings', 'Microphone permission')}
            </button>
          </div>
          {siriMessage && <p className="text-xs text-text-muted">{siriMessage}</p>}

          <div className="space-y-2">
            <span className="text-xs font-medium text-text-secondary">
              {t('voice.hotkey', 'Keyboard shortcut (press again or Esc to stop)')}
            </span>
            <div className="flex flex-wrap items-center gap-2">
              <div
                className={`inline-flex h-8 min-w-[7rem] items-center justify-center gap-2 rounded-lg border px-3 font-mono text-sm ${
                  recording
                    ? 'border-accent bg-accent/5 text-accent animate-pulse'
                    : 'border-border bg-surface text-text-primary'
                }`}
              >
                <Keyboard className="h-3.5 w-3.5" />
                {recording
                  ? t('voice.recording', 'Press keys…')
                  : config.hotkey
                    ? formatAccelerator(config.hotkey)
                    : t('voice.hotkeyOff', 'Off')}
              </div>
              <button
                type="button"
                onClick={() => {
                  setHotkeyError(null);
                  setRecording(!recording);
                }}
                className="inline-flex h-8 items-center rounded-lg border border-border px-3 text-sm text-text-secondary hover:border-accent/50"
              >
                {recording ? t('common.cancel', 'Cancel') : t('voice.change', 'Change')}
              </button>
              {!recording && config.hotkey !== DEFAULT_VOICE_HOTKEY && (
                <button
                  type="button"
                  onClick={() => void applyHotkey(DEFAULT_VOICE_HOTKEY)}
                  className="inline-flex h-8 items-center rounded-lg border border-border px-3 text-sm text-text-secondary hover:border-accent/50"
                >
                  {t('voice.reset', 'Reset')}
                </button>
              )}
              {!recording && config.hotkey !== null && (
                <button
                  type="button"
                  onClick={() => void applyHotkey(null)}
                  className="inline-flex h-8 items-center rounded-lg border border-border px-3 text-sm text-text-secondary hover:border-accent/50"
                >
                  {t('voice.disable', 'Disable')}
                </button>
              )}
            </div>
            {hotkeyErrorText && <p className="text-xs text-error">{hotkeyErrorText}</p>}
            {hotkeyNotRegistered && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                {t(
                  'voice.hotkeyNotRegistered',
                  'This shortcut is taken by another app (ChatGPT uses Option+Space). Choose another one.'
                )}
              </p>
            )}
          </div>

          <label className="flex items-center gap-2 text-sm text-text-primary">
            {t('voice.followUp', 'Keep listening for follow-ups for')}
            <select
              value={config.followUpSeconds}
              onChange={(event) => void update({ followUpSeconds: Number(event.target.value) })}
              className="rounded-lg border border-border bg-surface px-2 py-1 text-sm"
            >
              {FOLLOW_UP_OPTIONS.map((seconds) => (
                <option key={seconds} value={seconds}>
                  {t('voice.seconds', '{{count}} seconds', { count: seconds })}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
    </div>
  );
}
