import { useTranslation } from 'react-i18next';
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react';
import { toolImpactKey, useToolsHealth } from '../../hooks/useToolsHealth';

/**
 * Inline status line for Today and above the chat composer. Silent when every
 * tool is connected; explains impact and offers Retry when something is down.
 */
export function ToolsHealthNote({ variant = 'today' }: { variant?: 'today' | 'chat' }) {
  const { t } = useTranslation();
  const health = useToolsHealth();
  const { failed, connecting, level, retrying } = health;

  if (!health.loaded || level === 'ok' || level === 'none') return null;

  const busy = failed.some((s) => retrying.includes(s.id));

  if (level === 'connecting') {
    const names = connecting.map((s) => s.name).join(', ');
    if (variant === 'chat') {
      return (
        <div
          role="status"
          aria-live="polite"
          className="mb-2 flex min-h-[18px] items-center gap-2 px-1 text-[12px] text-text-muted"
        >
          <Loader2 className="h-3 w-3 shrink-0 animate-spin text-warning" aria-hidden />
          <span className="min-w-0 truncate">
            {names
              ? t('health.note.connectingNamed', { names })
              : t('health.note.connecting', { count: health.ready.connectingCount })}
          </span>
        </div>
      );
    }
    return (
      <div
        role="status"
        aria-live="polite"
        className="flex items-center gap-2.5 rounded-[10px] bg-warning/10 px-3 py-2 text-[13px] text-text-secondary"
      >
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-warning" />
        <span className="min-w-0 flex-1 truncate">
          {names
            ? t('health.note.connectingNamed', { names })
            : t('health.note.connecting', { count: health.ready.connectingCount })}
        </span>
      </div>
    );
  }

  const first = failed[0];

  if (variant === 'chat') {
    const text =
      failed.length === 1
        ? t('health.note.chatOneFailed', { name: first.name })
        : t('health.note.chatManyFailed', { count: failed.length });
    return (
      <div
        role="status"
        aria-live="polite"
        className="mb-2 flex min-h-[18px] items-center gap-2 px-1 text-[12px] text-text-muted"
      >
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-error" aria-hidden />
        <span className="min-w-0 truncate" title={first.lastError ?? undefined}>
          {text}
        </span>
        <button
          type="button"
          onClick={() => void health.retryAllFailed()}
          disabled={busy}
          className="shrink-0 font-semibold text-accent-text hover:underline disabled:opacity-60"
        >
          {busy ? t('health.retrying') : t('health.retry')}
        </button>
      </div>
    );
  }

  const message =
    failed.length === 1
      ? t('health.note.oneFailed', { name: first.name, impact: t(toolImpactKey(first.name)) })
      : t('health.note.manyFailed', {
          count: failed.length,
          names: failed.map((s) => s.name).join(', '),
        });

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center gap-2.5 rounded-[10px] bg-error/10 px-3 py-2 text-[13px] text-text-primary"
    >
      <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-error" />
      <span className="min-w-0 flex-1">{message}</span>
      <button
        type="button"
        onClick={() => void health.retryAllFailed()}
        disabled={busy}
        className="btn btn-sm btn-secondary ml-auto shrink-0"
      >
        <RefreshCw className={`h-3 w-3 ${busy ? 'animate-spin' : ''}`} />
        {busy ? t('health.retrying') : t('health.retry')}
      </button>
    </div>
  );
}
