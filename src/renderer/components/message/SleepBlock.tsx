// Sleep tool block — countdown with Skip (acts as sleep completed)
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, Clock, SkipForward } from 'lucide-react';
import type { ToolUseContent, Message } from '../../types';
import { useAppStore } from '../../store';
import { useIPC } from '../../hooks/useIPC';

interface SleepBlockProps {
  block: ToolUseContent;
  message?: Message;
}

function parseSecondsFromInput(input: Record<string, unknown> | undefined): number | null {
  if (!input) return null;
  const candidates = [input.seconds, input.duration_seconds, input.durationSeconds, input.duration];
  for (const value of candidates) {
    const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
    if (Number.isFinite(n) && n >= 0) return n;
  }
  const msCandidates = [input.duration_ms, input.durationMs, input.ms, input.milliseconds];
  for (const value of msCandidates) {
    const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
    if (Number.isFinite(n) && n >= 0) return n / 1000;
  }
  if (typeof input.command === 'string') {
    const match = /^(?:\/usr\/bin\/)?sleep\s+(\d+(?:\.\d+)?)\s*$/i.exec(input.command.trim());
    if (match) {
      const seconds = Number(match[1]);
      if (Number.isFinite(seconds) && seconds >= 0) return seconds;
    }
  }
  return null;
}

function formatRemaining(ms: number): string {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${s.toString().padStart(2, '0')}s`;
}

export function SleepBlock({ block, message }: SleepBlockProps) {
  const { t } = useTranslation();
  const { skipSleep } = useIPC();
  const sessionId = message?.sessionId;
  const pendingSleep = useAppStore((s) =>
    sessionId ? (s.pendingSleepBySessionId[sessionId] ?? null) : null
  );

  const isPending = Boolean(pendingSleep && pendingSleep.toolUseId === block.id);
  const [skipped, setSkipped] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!isPending) return;
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [isPending]);

  const inputSeconds = parseSecondsFromInput(block.input as Record<string, unknown>);
  const durationMs = pendingSleep?.durationMs ?? (inputSeconds != null ? inputSeconds * 1000 : 0);
  const endsAt = pendingSleep?.endsAt ?? 0;
  const remainingMs = isPending && endsAt ? Math.max(0, endsAt - now) : 0;
  const progress = useMemo(() => {
    if (!durationMs || !isPending) return 1;
    return Math.min(1, Math.max(0, 1 - remainingMs / durationMs));
  }, [durationMs, isPending, remainingMs]);

  const showSkip = isPending && !skipped;

  const handleSkip = () => {
    if (!pendingSleep || !sessionId || skipped) return;
    setSkipped(true);
    skipSleep(sessionId, pendingSleep.sleepId);
  };

  const headerLabel = skipped
    ? t('messageCard.sleepSkipped')
    : isPending
      ? t('messageCard.sleeping')
      : t('messageCard.sleepCompleted');

  const detail = isPending
    ? t('messageCard.sleepRemaining', { time: formatRemaining(remainingMs) })
    : skipped
      ? t('messageCard.sleepSkippedDetail')
      : inputSeconds != null
        ? t('messageCard.sleepDoneDetail', { seconds: Math.round(inputSeconds) })
        : '';

  return (
    <div className="rounded-xl border border-border bg-surface overflow-hidden">
      <div className="px-4 py-3 flex items-center gap-3">
        <div className="w-8 h-8 rounded-lg bg-accent/15 flex items-center justify-center shrink-0">
          {isPending ? (
            <Clock className="w-4 h-4 text-accent animate-pulse" />
          ) : (
            <CheckCircle2 className="w-4 h-4 text-success" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-medium text-sm text-text-primary">{headerLabel}</div>
          {detail ? <div className="text-xs text-text-muted mt-0.5">{detail}</div> : null}
          {isPending ? (
            <div className="mt-2 h-1.5 rounded-full bg-border overflow-hidden">
              <div
                className="h-full bg-accent transition-[width] duration-200 ease-linear"
                style={{ width: `${Math.round(progress * 100)}%` }}
              />
            </div>
          ) : null}
        </div>
        {showSkip ? (
          <button
            type="button"
            onClick={handleSkip}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-accent text-white hover:bg-accent/90 shrink-0"
          >
            <SkipForward className="w-3.5 h-3.5" />
            {t('messageCard.sleepSkip')}
          </button>
        ) : null}
        {!isPending && !showSkip ? (
          <CheckCircle2 className="w-5 h-5 text-success shrink-0" />
        ) : null}
      </div>
    </div>
  );
}
