import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw, Target, X } from 'lucide-react';
import type { ChatLoopStatus } from '../types';
import { parseIntervalToken } from '../../shared/loop/parse';

export type ChatLoopPanelMode = 'interval' | 'goal';

const INTERVAL_CHIPS = ['30s', '2m', '5m', '15m', '1h'] as const;

export interface ChatLoopPanelProps {
  open: boolean;
  initialText?: string;
  activeStatus: ChatLoopStatus | null;
  /** Panel anchor alignment relative to the trigger. Default left. */
  align?: 'left' | 'right';
  onClose: () => void;
  onStart: (input: {
    kind: ChatLoopPanelMode;
    prompt: string;
    intervalMs: number;
  }) => void | Promise<void>;
  onStop: () => void | Promise<void>;
}

export function ChatLoopPanel({
  open,
  initialText = '',
  activeStatus,
  align = 'left',
  onClose,
  onStart,
  onStop,
}: ChatLoopPanelProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const [mode, setMode] = useState<ChatLoopPanelMode>('interval');
  const [text, setText] = useState(initialText);
  const [selectedChip, setSelectedChip] = useState<string | null>(null);
  const [customInterval, setCustomInterval] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    const draftEmpty = !text.trim() && !selectedChip && !customInterval.trim();
    if (!draftEmpty) return;
    setText(initialText);
    setSelectedChip(null);
    setCustomInterval('');
    setMode(activeStatus?.kind === 'goal' ? 'goal' : 'interval');
    // Only seed when opening (or seed inputs change) while draft is empty — keep typed draft across dismiss.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally omit draft fields so edits while open do not re-run
  }, [open, initialText, activeStatus?.kind]);

  if (!open) return null;

  const resolveIntervalMs = (): number | null => {
    if (customInterval.trim()) {
      const parsed = parseIntervalToken(customInterval.trim());
      return parsed?.ms ?? null;
    }
    if (selectedChip) {
      const parsed = parseIntervalToken(selectedChip);
      return parsed?.ms ?? null;
    }
    return null;
  };

  const resetDraft = () => {
    setText('');
    setSelectedChip(null);
    setCustomInterval('');
    setMode('interval');
    setError(null);
  };

  const handleStart = async () => {
    const trimmed = text.trim();
    if (!trimmed) {
      setError(t('loop.promptRequired'));
      return;
    }
    const intervalMs = resolveIntervalMs();
    if (intervalMs === null) {
      setError(t('loop.intervalRequired'));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onStart({
        kind: mode,
        prompt: trimmed,
        intervalMs,
      });
      resetDraft();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('loop.startFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  const hasInterval = Boolean(customInterval.trim() || selectedChip);

  return (
    <div
      role="dialog"
      aria-labelledby={titleId}
      className={`absolute bottom-[calc(100%+8px)] z-30 w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded-[1.25rem] border border-border-subtle bg-background shadow-elevated ${
        align === 'right' ? 'right-0' : 'left-0'
      }`}
    >
      <div className="flex items-center justify-between gap-2 border-b border-border-muted px-3 py-2.5">
        <div id={titleId} className="text-[13px] font-medium text-text-primary">
          {t('loop.menuTitle')}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg p-1 text-text-muted hover:bg-surface-hover hover:text-text-primary"
          aria-label={t('common.close')}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="space-y-3 p-3">
        {activeStatus && (
          <button
            type="button"
            onClick={() => void onStop()}
            className="flex w-full items-center justify-center gap-2 rounded-xl border border-error/20 bg-error/10 px-3 py-2 text-[13px] font-medium text-error transition-colors hover:bg-error/15"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            {t('loop.stopActive')}
          </button>
        )}

        <div className="grid grid-cols-2 gap-1 rounded-xl bg-surface p-1">
          <button
            type="button"
            onClick={() => setMode('interval')}
            className={`flex items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-[13px] font-medium transition-colors ${
              mode === 'interval'
                ? 'bg-background text-text-primary shadow-soft'
                : 'text-text-muted hover:text-text-primary'
            }`}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            {t('loop.modeLoop')}
          </button>
          <button
            type="button"
            onClick={() => setMode('goal')}
            className={`flex items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-[13px] font-medium transition-colors ${
              mode === 'goal'
                ? 'bg-background text-text-primary shadow-soft'
                : 'text-text-muted hover:text-text-primary'
            }`}
          >
            <Target className="h-3.5 w-3.5" />
            {t('loop.modeGoal')}
          </button>
        </div>

        <label className="block space-y-1.5">
          <span className="text-[11px] font-medium uppercase tracking-[0.04em] text-text-muted">
            {mode === 'goal' ? t('loop.goalLabel') : t('loop.promptLabel')}
          </span>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={3}
            placeholder={mode === 'goal' ? t('loop.goalPlaceholder') : t('loop.promptPlaceholder')}
            className="w-full resize-none rounded-xl border border-border bg-surface px-3 py-2 text-[13px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
          />
        </label>

        <div className="space-y-1.5">
          <div className="text-[11px] font-medium uppercase tracking-[0.04em] text-text-muted">
            {t('loop.intervalLabel')}
          </div>
          <p className="text-[11px] text-text-muted">{t('loop.intervalHint')}</p>
          <div className="flex flex-wrap gap-1.5">
            {INTERVAL_CHIPS.map((chip) => (
              <button
                key={chip}
                type="button"
                onClick={() => {
                  setSelectedChip(chip);
                  setCustomInterval('');
                }}
                className={`rounded-full px-2.5 py-1 text-[12px] font-medium transition-colors ${
                  selectedChip === chip && !customInterval.trim()
                    ? 'bg-accent/15 text-accent border border-accent/25'
                    : 'bg-surface text-text-secondary border border-border hover:bg-surface-hover'
                }`}
              >
                {chip}
              </button>
            ))}
          </div>
          <input
            value={customInterval}
            onChange={(e) => {
              setCustomInterval(e.target.value);
              if (e.target.value.trim()) setSelectedChip(null);
            }}
            placeholder={t('loop.intervalCustom')}
            className="w-full rounded-xl border border-border bg-surface px-3 py-1.5 text-[13px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
          />
        </div>

        {error && <div className="text-[12px] text-error">{error}</div>}

        <button
          type="button"
          disabled={submitting || !hasInterval || !text.trim()}
          onClick={() => void handleStart()}
          className="flex w-full items-center justify-center rounded-xl bg-accent px-3 py-2 text-[13px] font-medium text-background transition-opacity disabled:opacity-50"
        >
          {mode === 'goal' ? t('loop.startGoal') : t('loop.startLoop')}
        </button>

        <p className="text-[11px] text-text-muted">{t('loop.slashHint')}</p>
      </div>
    </div>
  );
}
