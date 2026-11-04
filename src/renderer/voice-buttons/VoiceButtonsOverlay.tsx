/**
 * System-wide overlay: capture without taking focus, then paste into the
 * frontmost app. Loaded at #voice-buttons.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Mic, Square, X } from 'lucide-react';
import type { VoiceButton, VoiceButtonsConfig } from '../../shared/voice-buttons';
import { useVoiceCapture } from './useVoiceCapture';

export function VoiceButtonsOverlay() {
  const { t } = useTranslation();
  const [config, setConfig] = useState<VoiceButtonsConfig | null>(null);
  const [active, setActive] = useState<VoiceButton | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const activeRef = useRef<VoiceButton | null>(null);
  activeRef.current = active;

  const finish = useCallback(
    async (transcript: string, audioMs: number) => {
      const button = activeRef.current;
      if (!button) {
        await window.electronAPI.voiceButtons.systemSessionEnded();
        return;
      }
      if (!transcript.trim()) {
        setNotice(t('voiceButtons.empty'));
        window.setTimeout(() => {
          void window.electronAPI.voiceButtons.systemSessionEnded();
        }, 900);
        return;
      }
      setBusy(true);
      try {
        const processed = await window.electronAPI.voiceButtons.process({
          buttonId: button.id,
          rawText: transcript,
          audioMs,
        });
        const text = processed.ok ? processed.output : processed.raw;
        if (!text) {
          setNotice(processed.ok ? t('voiceButtons.empty') : processed.message);
        } else {
          const insertMode = processed.ok ? processed.insertMode : 'copy';
          if (insertMode === 'copy') {
            await navigator.clipboard.writeText(text).catch(() => undefined);
            setNotice(t('voiceButtons.copied'));
          } else {
            const paste = await window.electronAPI.voiceButtons.systemPaste(text);
            if (paste.success) {
              setNotice(t('voiceButtons.systemPasted'));
            } else if (paste.reason === 'accessibility') {
              setNotice(t('voiceButtons.systemAccessibility'));
            } else {
              setNotice(t('voiceButtons.systemCopied'));
            }
          }
        }
      } catch {
        setNotice(t('voiceButtons.failed'));
      } finally {
        setBusy(false);
        window.setTimeout(() => {
          void window.electronAPI.voiceButtons.systemSessionEnded();
        }, 1000);
      }
    },
    [t]
  );

  const capture = useVoiceCapture(finish);
  const captureRef = useRef(capture);
  captureRef.current = capture;
  const finishRef = useRef(finish);
  finishRef.current = finish;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const nextConfig = await window.electronAPI.voiceButtons.getConfig();
      const buttons = await window.electronAPI.voiceButtons.list();
      if (cancelled) return;
      setConfig(nextConfig);
      const selected =
        buttons.find((button) => button.id === nextConfig.activeButtonId) ?? buttons[0] ?? null;
      setActive(selected);
    })().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const offStart = window.electronAPI.voiceButtons.onSystemStart(({ mode }) => {
      setNotice(null);
      void captureRef.current.begin({ silenceStop: mode === 'toggle' });
    });
    const offStop = window.electronAPI.voiceButtons.onSystemStop(() => {
      void captureRef.current
        .end()
        .then(({ transcript, audioMs }) => finishRef.current(transcript, audioMs));
    });
    return () => {
      offStart();
      offStop();
    };
  }, []);

  return (
    <div
      data-voice-widget
      className="h-screen w-screen overflow-hidden bg-transparent p-2 text-text-primary"
    >
      <section
        aria-label={t('voiceButtons.region')}
        className="mx-auto flex h-full max-w-[320px] flex-col rounded-2xl border border-border bg-surface/95 px-3 py-2 shadow-elevated backdrop-blur"
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2 text-sm">
            <Mic className="h-4 w-4 shrink-0 text-accent" />
            <span className="truncate">{active?.name ?? t('voiceButtons.title')}</span>
          </div>
          <button
            type="button"
            className="rounded-lg p-1 text-text-muted hover:bg-surface-hover"
            aria-label={t('voiceButtons.cancel')}
            onClick={() => {
              capture.discard();
              void window.electronAPI.voiceButtons.systemSessionEnded();
            }}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {(capture.status === 'recording' || capture.status === 'connecting') && (
          <div className="mt-2" aria-live="polite">
            <div className="mb-1 flex h-6 items-end gap-1" aria-hidden="true">
              {capture.levels.map((level, index) => (
                <span
                  key={index}
                  className="w-1.5 rounded-full bg-accent"
                  style={{ height: `${Math.round(level * 24)}px` }}
                />
              ))}
            </div>
            <p className="truncate text-xs text-text-secondary">
              {capture.liveText || t('voiceButtons.listening')}
            </p>
            {config?.systemWide && (
              <button
                type="button"
                className="mt-2 inline-flex items-center gap-1 rounded-lg bg-accent px-2 py-1 text-xs text-white"
                onClick={() => {
                  void capture.end().then(({ transcript, audioMs }) => finish(transcript, audioMs));
                }}
              >
                <Square className="h-3 w-3" />
                {t('voiceButtons.stop')}
              </button>
            )}
          </div>
        )}

        {(notice || capture.error || busy) && (
          <p className="mt-2 text-xs text-text-secondary" role="status">
            {busy ? t('voiceButtons.cleaning') : capture.error || notice}
          </p>
        )}
      </section>
    </div>
  );
}
