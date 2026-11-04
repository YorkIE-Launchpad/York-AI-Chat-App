import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../store';
import { SettingsSwitch } from './shared';
import { formatAccelerator, keyEventToAccelerator } from '../../utils/shortcut-accelerator';
import {
  DEFAULT_VOICE_BUTTONS_CONFIG,
  VOICE_BUTTON_ICONS,
  validateVoiceHotkey,
  type VoiceButton,
  type VoiceButtonDraft,
  type VoiceButtonIcon,
  type VoiceButtonMode,
  type VoiceButtonsConfig,
  type VoiceDictionaryEntry,
  type VoiceHistoryEntry,
  type VoiceInsertMode,
  type VoiceRewritePreset,
  type VoiceSnippet,
} from '../../../shared/voice-buttons';

const MODES: VoiceButtonMode[] = ['raw', 'clean', 'rewrite'];
const PRESETS: VoiceRewritePreset[] = ['email', 'linkedin', 'crm', 'task', 'summary', 'custom'];
const INSERTS: VoiceInsertMode[] = ['insert', 'copy', 'insert_and_copy'];

export function VoiceButtonsSetting() {
  const { t } = useTranslation();
  const appConfig = useAppStore((state) => state.appConfig);
  const setAppConfig = useAppStore((state) => state.setAppConfig);
  const config = appConfig?.voiceButtons ?? DEFAULT_VOICE_BUTTONS_CONFIG;
  const [buttons, setButtons] = useState<VoiceButton[]>([]);
  const [dictionary, setDictionary] = useState<VoiceDictionaryEntry[]>([]);
  const [snippets, setSnippets] = useState<VoiceSnippet[]>([]);
  const [history, setHistory] = useState<VoiceHistoryEntry[]>([]);
  const [draft, setDraft] = useState<VoiceButtonDraft | null>(null);
  const [recording, setRecording] = useState(false);
  const [hotkeyError, setHotkeyError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const api = window.electronAPI?.voiceButtons;
    if (!api) return;
    const [nextButtons, nextDictionary, nextSnippets, nextHistory] = await Promise.all([
      api.list(),
      api.listDictionary(),
      api.listSnippets(),
      api.listHistory(),
    ]);
    setButtons(nextButtons);
    setDictionary(nextDictionary);
    setSnippets(nextSnippets);
    setHistory(nextHistory);
  }, []);

  useEffect(() => {
    void reload().catch(() => undefined);
  }, [reload]);

  const saveConfig = useCallback(
    async (partial: Partial<VoiceButtonsConfig>) => {
      const next = await window.electronAPI.voiceButtons.updateConfig(partial);
      const current = useAppStore.getState().appConfig;
      if (current) setAppConfig({ ...current, voiceButtons: next });
    },
    [setAppConfig]
  );

  useEffect(() => {
    if (!recording) return;
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') {
        setRecording(false);
        return;
      }
      const accelerator = keyEventToAccelerator(event);
      if (!accelerator) return;
      const validated = validateVoiceHotkey(accelerator);
      if (!validated.ok) {
        setHotkeyError(
          validated.reason === 'reserved'
            ? t('voiceButtons.hotkeyReserved')
            : t('voiceButtons.hotkeyInvalid')
        );
        setRecording(false);
        return;
      }
      setHotkeyError(null);
      setRecording(false);
      void saveConfig({ hotkey: validated.hotkey, hotkeyEnabled: true });
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [recording, saveConfig, t]);

  const saveDraft = async () => {
    if (!draft) return;
    await window.electronAPI.voiceButtons.save(draft);
    setDraft(null);
    await reload();
  };

  return (
    <div className="space-y-4 border-t border-border pt-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h4 className="text-sm font-medium text-text-primary">{t('voiceButtons.title')}</h4>
          <p className="mt-1 text-sm text-text-secondary">{t('voiceButtons.help')}</p>
        </div>
        <SettingsSwitch
          checked={config.enabled}
          aria-label={t('voiceButtons.enable')}
          onChange={() => void saveConfig({ enabled: !config.enabled })}
        />
      </div>

      <div className="flex items-center justify-between gap-3">
        <span className="text-sm text-text-secondary">{t('voiceButtons.historyToggle')}</span>
        <SettingsSwitch
          checked={config.historyEnabled}
          aria-label={t('voiceButtons.historyToggle')}
          onChange={() => void saveConfig({ historyEnabled: !config.historyEnabled })}
        />
      </div>

      <div className="flex items-center justify-between gap-3">
        <span className="text-sm text-text-secondary">{t('voiceButtons.showWidget')}</span>
        <SettingsSwitch
          checked={!config.hidden}
          aria-label={t('voiceButtons.showWidget')}
          onChange={() => void saveConfig({ hidden: !config.hidden })}
        />
      </div>

      <div className="flex items-center justify-between gap-3">
        <div>
          <span className="text-sm text-text-secondary">{t('voiceButtons.systemWide')}</span>
          <p className="mt-1 text-xs text-text-muted">{t('voiceButtons.systemWideHelp')}</p>
        </div>
        <SettingsSwitch
          checked={config.systemWide}
          aria-label={t('voiceButtons.systemWide')}
          onChange={() => void saveConfig({ systemWide: !config.systemWide })}
        />
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-text-secondary">{t('voiceButtons.hotkey')}</span>
          <SettingsSwitch
            checked={config.hotkeyEnabled}
            aria-label={t('voiceButtons.hotkey')}
            onChange={() => void saveConfig({ hotkeyEnabled: !config.hotkeyEnabled })}
          />
        </div>
        <p className="text-xs text-text-muted">
          {config.systemWide ? t('voiceButtons.hotkeyHelpSystem') : t('voiceButtons.hotkeyHelp')}
        </p>
        <div className="flex items-center gap-2">
          <span className="rounded-lg border border-border px-2 py-1 text-sm">
            {config.hotkeyEnabled ? formatAccelerator(config.hotkey) : t('voiceButtons.hotkeyOff')}
          </span>
          <button
            type="button"
            className="rounded-lg border border-border px-2 py-1 text-xs text-text-secondary"
            onClick={() => {
              setHotkeyError(null);
              setRecording(true);
            }}
          >
            {recording ? t('voiceButtons.hotkeyRecording') : t('voiceButtons.hotkeyChange')}
          </button>
        </div>
        {hotkeyError && <p className="text-xs text-error">{hotkeyError}</p>}
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h5 className="text-sm font-medium text-text-primary">{t('voiceButtons.buttons')}</h5>
          <button
            type="button"
            className="text-xs text-text-secondary hover:text-text-primary"
            onClick={() =>
              setDraft({
                name: '',
                icon: 'mic',
                mode: 'clean',
                insertMode: 'insert_and_copy',
                language: 'en',
                tone: 'neutral',
                instruction: '',
              })
            }
          >
            {t('voiceButtons.add')}
          </button>
        </div>
        <ul className="space-y-1">
          {buttons.map((button, index) => (
            <li key={button.id} className="flex items-center gap-2 text-sm">
              <span className="min-w-0 flex-1 truncate text-text-primary">{button.name}</span>
              <button
                type="button"
                className="text-xs text-text-muted"
                aria-label={t('voiceButtons.moveUp')}
                disabled={index === 0}
                onClick={() => {
                  const ids = buttons.map((item) => item.id);
                  const swap = ids[index - 1];
                  ids[index - 1] = ids[index];
                  ids[index] = swap;
                  void window.electronAPI.voiceButtons.reorder(ids).then(setButtons);
                }}
              >
                {t('voiceButtons.up')}
              </button>
              <button
                type="button"
                className="text-xs text-text-muted"
                onClick={() => setDraft(button)}
              >
                {t('voiceButtons.edit')}
              </button>
              <button
                type="button"
                className="text-xs text-text-muted"
                onClick={() =>
                  void window.electronAPI.voiceButtons.duplicate(button.id).then(() => reload())
                }
              >
                {t('voiceButtons.duplicate')}
              </button>
              <button
                type="button"
                className="text-xs text-text-muted"
                onClick={() =>
                  void window.electronAPI.voiceButtons.delete(button.id).then(() => reload())
                }
              >
                {t('voiceButtons.delete')}
              </button>
            </li>
          ))}
        </ul>
        {draft && (
          <div className="space-y-2 rounded-xl border border-border p-3">
            <input
              className="w-full rounded-lg border border-border bg-background px-2 py-1 text-sm"
              aria-label={t('voiceButtons.name')}
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
            <div className="grid grid-cols-2 gap-2">
              <select
                className="rounded-lg border border-border bg-background px-2 py-1 text-sm"
                aria-label={t('voiceButtons.icon')}
                value={draft.icon}
                onChange={(event) =>
                  setDraft({ ...draft, icon: event.target.value as VoiceButtonIcon })
                }
              >
                {VOICE_BUTTON_ICONS.map((icon) => (
                  <option key={icon} value={icon}>
                    {icon}
                  </option>
                ))}
              </select>
              <select
                className="rounded-lg border border-border bg-background px-2 py-1 text-sm"
                aria-label={t('voiceButtons.mode')}
                value={draft.mode}
                onChange={(event) =>
                  setDraft({ ...draft, mode: event.target.value as VoiceButtonMode })
                }
              >
                {MODES.map((mode) => (
                  <option key={mode} value={mode}>
                    {t(`voiceButtons.mode_${mode}`)}
                  </option>
                ))}
              </select>
            </div>
            {draft.mode === 'rewrite' && (
              <select
                className="w-full rounded-lg border border-border bg-background px-2 py-1 text-sm"
                aria-label={t('voiceButtons.preset')}
                value={draft.rewritePreset ?? 'custom'}
                onChange={(event) =>
                  setDraft({ ...draft, rewritePreset: event.target.value as VoiceRewritePreset })
                }
              >
                {PRESETS.map((preset) => (
                  <option key={preset} value={preset}>
                    {preset}
                  </option>
                ))}
              </select>
            )}
            <textarea
              className="min-h-16 w-full rounded-lg border border-border bg-background px-2 py-1 text-sm"
              aria-label={t('voiceButtons.instruction')}
              value={draft.instruction ?? ''}
              onChange={(event) => setDraft({ ...draft, instruction: event.target.value })}
            />
            <div className="grid grid-cols-3 gap-2">
              <input
                className="rounded-lg border border-border bg-background px-2 py-1 text-sm"
                aria-label={t('voiceButtons.language')}
                value={draft.language ?? 'en'}
                onChange={(event) => setDraft({ ...draft, language: event.target.value })}
              />
              <input
                className="rounded-lg border border-border bg-background px-2 py-1 text-sm"
                aria-label={t('voiceButtons.tone')}
                value={draft.tone ?? 'neutral'}
                onChange={(event) => setDraft({ ...draft, tone: event.target.value })}
              />
              <select
                className="rounded-lg border border-border bg-background px-2 py-1 text-sm"
                aria-label={t('voiceButtons.insert')}
                value={draft.insertMode}
                onChange={(event) =>
                  setDraft({ ...draft, insertMode: event.target.value as VoiceInsertMode })
                }
              >
                {INSERTS.map((mode) => (
                  <option key={mode} value={mode}>
                    {t(`voiceButtons.insert_${mode}`)}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                className="rounded-lg bg-accent px-3 py-1 text-xs text-white"
                onClick={() => void saveDraft()}
              >
                {t('voiceButtons.save')}
              </button>
              <button
                type="button"
                className="rounded-lg border border-border px-3 py-1 text-xs"
                onClick={() => setDraft(null)}
              >
                {t('voiceButtons.cancel')}
              </button>
            </div>
          </div>
        )}
      </div>

      <PairList
        key={dictionary.map((entry) => `${entry.term}:${entry.replacement}`).join('|')}
        title={t('voiceButtons.dictionary')}
        help={t('voiceButtons.dictionaryHelp')}
        leftLabel={t('voiceButtons.term')}
        rightLabel={t('voiceButtons.replacement')}
        rows={dictionary.map((entry) => ({ left: entry.term, right: entry.replacement }))}
        onSave={(rows) =>
          void window.electronAPI.voiceButtons
            .replaceDictionary(rows.map((row) => ({ term: row.left, replacement: row.right })))
            .then(setDictionary)
        }
      />
      <PairList
        key={snippets.map((entry) => `${entry.trigger}:${entry.expansion}`).join('|')}
        title={t('voiceButtons.snippets')}
        help={t('voiceButtons.snippetsHelp')}
        leftLabel={t('voiceButtons.trigger')}
        rightLabel={t('voiceButtons.expansion')}
        rows={snippets.map((entry) => ({ left: entry.trigger, right: entry.expansion }))}
        onSave={(rows) =>
          void window.electronAPI.voiceButtons
            .replaceSnippets(rows.map((row) => ({ trigger: row.left, expansion: row.right })))
            .then(setSnippets)
        }
      />

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h5 className="text-sm font-medium text-text-primary">{t('voiceButtons.history')}</h5>
          <button
            type="button"
            className="text-xs text-text-muted"
            onClick={() =>
              void window.electronAPI.voiceButtons.clearHistory().then(() => setHistory([]))
            }
          >
            {t('voiceButtons.clearHistory')}
          </button>
        </div>
        {history.length === 0 ? (
          <p className="text-xs text-text-muted">{t('voiceButtons.historyEmpty')}</p>
        ) : (
          <ul className="max-h-40 space-y-2 overflow-auto">
            {history.map((entry) => (
              <li key={entry.id} className="text-xs text-text-secondary">
                <span className="text-text-muted">{entry.buttonName}: </span>
                {entry.outputText}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function PairList({
  title,
  help,
  leftLabel,
  rightLabel,
  rows,
  onSave,
}: {
  title: string;
  help: string;
  leftLabel: string;
  rightLabel: string;
  rows: Array<{ left: string; right: string }>;
  onSave: (rows: Array<{ left: string; right: string }>) => void;
}) {
  const { t } = useTranslation();
  const [local, setLocal] = useState(rows);
  return (
    <div className="space-y-2">
      <h5 className="text-sm font-medium text-text-primary">{title}</h5>
      <p className="text-xs text-text-muted">{help}</p>
      {local.map((row, index) => (
        <div key={index} className="grid grid-cols-2 gap-2">
          <input
            className="rounded-lg border border-border bg-background px-2 py-1 text-sm"
            aria-label={leftLabel}
            value={row.left}
            onChange={(event) => {
              const next = local.slice();
              next[index] = { ...row, left: event.target.value };
              setLocal(next);
            }}
          />
          <input
            className="rounded-lg border border-border bg-background px-2 py-1 text-sm"
            aria-label={rightLabel}
            value={row.right}
            onChange={(event) => {
              const next = local.slice();
              next[index] = { ...row, right: event.target.value };
              setLocal(next);
            }}
          />
        </div>
      ))}
      <div className="flex gap-2">
        <button
          type="button"
          className="text-xs text-text-secondary"
          onClick={() => setLocal([...local, { left: '', right: '' }])}
        >
          {t('voiceButtons.add')}
        </button>
        <button type="button" className="text-xs text-text-secondary" onClick={() => onSave(local)}>
          {t('voiceButtons.save')}
        </button>
      </div>
    </div>
  );
}
