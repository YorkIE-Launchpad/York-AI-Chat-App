import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  Copy,
  GripHorizontal,
  List,
  Mail,
  MessageSquare,
  Mic,
  PenLine,
  Settings,
  Sparkles,
  Square,
  StickyNote,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { canonicalAccelerator } from '../../shared/screen-snap';
import {
  holdKeyMatches,
  type VoiceButton,
  type VoiceButtonsConfig,
  type VoiceProcessResult,
} from '../../shared/voice-buttons';
import { keyEventToAccelerator } from '../utils/shortcut-accelerator';
import { useAppStore } from '../store';
import { copyVoiceText, insertTextAtCaret, isVoiceInsertTarget } from './insert-text';
import { useVoiceCapture } from './useVoiceCapture';

const ICONS = {
  sparkles: Sparkles,
  mic: Mic,
  mail: Mail,
  note: StickyNote,
  list: List,
  pen: PenLine,
  message: MessageSquare,
} as const;

const POSITION_KEY = 'york-voice-buttons-position';

function loadPosition(): { x: number; y: number } | null {
  try {
    const raw = localStorage.getItem(POSITION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { x?: number; y?: number };
    if (typeof parsed.x !== 'number' || typeof parsed.y !== 'number') return null;
    return { x: parsed.x, y: parsed.y };
  } catch {
    return null;
  }
}

export function VoiceButtonWidget() {
  const { t } = useTranslation();
  const appConfig = useAppStore((state) => state.appConfig);
  const setAppConfig = useAppStore((state) => state.setAppConfig);
  const setShowSettings = useAppStore((state) => state.setShowSettings);
  const setSettingsTab = useAppStore((state) => state.setSettingsTab);
  const config = appConfig?.voiceButtons;
  const [buttons, setButtons] = useState<VoiceButton[]>([]);
  const [collapsed, setCollapsed] = useState(true);
  const [position, setPosition] = useState(loadPosition);
  const [notice, setNotice] = useState<string | null>(null);
  const [result, setResult] = useState<VoiceProcessResult | null>(null);
  const [processing, setProcessing] = useState(false);
  const focusRef = useRef<HTMLElement | null>(null);
  const holdRef = useRef(false);
  const configRef = useRef<VoiceButtonsConfig | undefined>(config);
  configRef.current = config;

  const active =
    buttons.find((button) => button.id === config?.activeButtonId) ?? buttons[0] ?? null;

  const finish = useCallback(
    async (transcript: string, audioMs: number) => {
      const button = active;
      const current = configRef.current;
      if (!button || !current?.enabled) return;
      if (!transcript.trim()) {
        setNotice(t('voiceButtons.empty'));
        setResult(null);
        return;
      }
      setProcessing(true);
      setCollapsed(false);
      try {
        const processed = await window.electronAPI.voiceButtons.process({
          buttonId: button.id,
          rawText: transcript,
          audioMs,
        });
        setResult(processed);
        const text = processed.ok ? processed.output : processed.raw;
        const mode = processed.ok ? processed.insertMode : 'copy';
        if (!text) {
          setNotice(processed.ok ? t('voiceButtons.empty') : processed.message);
          return;
        }
        const target = focusRef.current;
        let inserted = false;
        if (mode !== 'copy' && target && document.contains(target)) {
          inserted = insertTextAtCaret(target, text);
        }
        if (mode === 'copy' || mode === 'insert_and_copy' || !inserted) {
          const copied = await copyVoiceText(text);
          setNotice(
            inserted
              ? t('voiceButtons.insertedAndCopied')
              : copied
                ? processed.ok
                  ? t('voiceButtons.copied')
                  : processed.message
                : t('voiceButtons.copyFailed')
          );
        } else {
          setNotice(processed.ok ? t('voiceButtons.inserted') : processed.message);
        }
      } catch {
        setNotice(t('voiceButtons.failed'));
        setResult({
          ok: false,
          code: 'failed',
          message: t('voiceButtons.failed'),
          raw: transcript,
        });
      } finally {
        setProcessing(false);
      }
    },
    [active, t]
  );

  const capture = useVoiceCapture(finish);
  const captureRef = useRef(capture);
  captureRef.current = capture;

  useEffect(() => {
    const onFocus = (event: FocusEvent) => {
      if (isVoiceInsertTarget(event.target)) focusRef.current = event.target;
    };
    document.addEventListener('focusin', onFocus, true);
    return () => document.removeEventListener('focusin', onFocus, true);
  }, []);

  useEffect(() => {
    if (!config?.enabled) return;
    let cancelled = false;
    void window.electronAPI.voiceButtons
      .list()
      .then((rows) => {
        if (!cancelled) setButtons(rows);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [config?.enabled]);

  useEffect(() => {
    // System-wide mode owns the hotkey in the main process (hold helper / toggle).
    if (!config?.enabled || !config.hotkeyEnabled || !config.hotkey || config.systemWide) return;
    const hotkey = config.hotkey;
    const onDown = (event: KeyboardEvent) => {
      if (event.repeat || holdRef.current) return;
      const pressed = keyEventToAccelerator(event);
      if (!pressed || canonicalAccelerator(pressed) !== canonicalAccelerator(hotkey)) return;
      event.preventDefault();
      holdRef.current = true;
      void captureRef.current.begin({ silenceStop: false });
    };
    const onUp = (event: KeyboardEvent) => {
      if (!holdRef.current) return;
      const modifier = ['Control', 'Shift', 'Alt', 'Meta'].includes(event.key);
      if (!modifier && !holdKeyMatches(hotkey, event.code)) return;
      holdRef.current = false;
      event.preventDefault();
      void captureRef.current.end().then(({ transcript, audioMs }) => finish(transcript, audioMs));
    };
    window.addEventListener('keydown', onDown, true);
    window.addEventListener('keyup', onUp, true);
    return () => {
      window.removeEventListener('keydown', onDown, true);
      window.removeEventListener('keyup', onUp, true);
    };
  }, [config?.enabled, config?.hotkey, config?.hotkeyEnabled, config?.systemWide, finish]);

  if (!config?.enabled || config.hidden) return null;

  const saveConfig = async (partial: Partial<VoiceButtonsConfig>) => {
    const next = await window.electronAPI.voiceButtons.updateConfig(partial);
    const current = useAppStore.getState().appConfig;
    if (current) setAppConfig({ ...current, voiceButtons: next });
  };

  const onGripDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const startX = event.clientX;
    const startY = event.clientY;
    const origin = position ?? {
      x: window.innerWidth - 360,
      y: window.innerHeight - 120,
    };
    const move = (next: PointerEvent) => {
      const x = Math.min(window.innerWidth - 80, Math.max(8, origin.x + next.clientX - startX));
      const y = Math.min(window.innerHeight - 64, Math.max(8, origin.y + next.clientY - startY));
      setPosition({ x, y });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setPosition((current) => {
        if (current) localStorage.setItem(POSITION_KEY, JSON.stringify(current));
        return current;
      });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const ActiveIcon = active ? (ICONS[active.icon] ?? Mic) : Mic;
  const style = position ? { left: position.x, top: position.y } : { right: 24, bottom: 24 };

  return (
    <section
      data-voice-widget
      aria-label={t('voiceButtons.region')}
      className="titlebar-no-drag fixed z-30 w-[320px] rounded-2xl border border-border bg-surface shadow-elevated"
      style={style}
      onMouseDown={(event) => {
        const target = event.target as HTMLElement;
        if (target.closest('input, textarea, select')) return;
        event.preventDefault();
      }}
    >
      <div className="flex items-center gap-1 px-2 py-2">
        <button
          type="button"
          className="rounded-lg p-1 text-text-muted hover:bg-surface-hover"
          aria-label={t('voiceButtons.drag')}
          onPointerDown={onGripDown}
        >
          <GripHorizontal className="h-4 w-4" />
        </button>
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 rounded-xl px-2 py-1 text-left text-sm text-text-primary hover:bg-surface-hover"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((value) => !value)}
        >
          <ActiveIcon className="h-4 w-4 shrink-0" />
          <span className="truncate">{active?.name ?? t('voiceButtons.title')}</span>
        </button>
        <button
          type="button"
          className="rounded-lg p-1 text-text-muted hover:bg-surface-hover"
          aria-label={t('voiceButtons.openSettings')}
          onClick={() => {
            setSettingsTab('general');
            setShowSettings(true);
          }}
        >
          <Settings className="h-4 w-4" />
        </button>
        <button
          type="button"
          className="rounded-lg p-1 text-text-muted hover:bg-surface-hover"
          aria-label={t('voiceButtons.hide')}
          onClick={() => void saveConfig({ hidden: true })}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {capture.status === 'recording' || capture.status === 'connecting' ? (
        <div className="px-3 pb-3" aria-live="polite">
          <div className="mb-2 flex h-8 items-end gap-1" aria-hidden="true">
            {capture.levels.map((level, index) => (
              <span
                key={index}
                className="w-1.5 rounded-full bg-accent motion-reduce:transition-none"
                style={{ height: `${Math.round(level * 32)}px` }}
              />
            ))}
          </div>
          <p className="mb-2 min-h-5 text-xs text-text-secondary">
            {capture.liveText || t('voiceButtons.listening')}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded-lg border border-border px-2 py-1 text-xs"
              onClick={() => capture.discard()}
            >
              {t('voiceButtons.cancel')}
            </button>
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-lg bg-accent px-2 py-1 text-xs text-white"
              onClick={() => {
                void capture.end().then(({ transcript, audioMs }) => finish(transcript, audioMs));
              }}
            >
              <Square className="h-3 w-3" />
              {t('voiceButtons.stop')}
            </button>
          </div>
        </div>
      ) : (
        <div className="px-3 pb-3">
          <button
            type="button"
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-accent/10 py-2 text-sm text-text-primary hover:bg-accent/15"
            aria-label={t('voiceButtons.record')}
            disabled={processing}
            onClick={() => {
              setCollapsed(false);
              void capture.begin({ silenceStop: true });
            }}
          >
            <Mic className="h-4 w-4" />
            {processing ? t('voiceButtons.cleaning') : t('voiceButtons.record')}
          </button>
        </div>
      )}

      {!collapsed && buttons.length > 0 && capture.status === 'idle' && (
        <div
          className="flex flex-wrap gap-1 px-3 pb-3"
          role="listbox"
          aria-label={t('voiceButtons.choose')}
        >
          {buttons.map((button) => {
            const Icon = ICONS[button.icon] ?? Mic;
            const selected = button.id === active?.id;
            return (
              <button
                key={button.id}
                type="button"
                role="option"
                aria-selected={selected}
                className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-xs ${
                  selected ? 'border-accent bg-accent/10' : 'border-border text-text-secondary'
                }`}
                onClick={() => void saveConfig({ activeButtonId: button.id })}
              >
                <Icon className="h-3 w-3" />
                {button.name}
              </button>
            );
          })}
        </div>
      )}

      {(notice || capture.error || (result && !result.ok)) && (
        <p className="px-3 pb-2 text-xs text-text-secondary" role="status">
          {capture.error || notice || (result && !result.ok ? result.message : '')}
        </p>
      )}

      {result && (
        <div className="border-t border-border px-3 py-2">
          <p className="max-h-24 overflow-auto text-xs text-text-primary">
            {result.ok ? result.output : result.raw}
          </p>
          <button
            type="button"
            className="mt-2 inline-flex items-center gap-1 text-xs text-text-secondary hover:text-text-primary"
            onClick={() => {
              const text = result.ok ? result.output : result.raw;
              void copyVoiceText(text).then((ok) =>
                setNotice(ok ? t('voiceButtons.copied') : t('voiceButtons.copyFailed'))
              );
            }}
          >
            <Copy className="h-3 w-3" />
            {t('voiceButtons.copy')}
          </button>
        </div>
      )}
    </section>
  );
}
