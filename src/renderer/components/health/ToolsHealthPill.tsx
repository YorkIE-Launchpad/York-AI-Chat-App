import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, RefreshCw } from 'lucide-react';
import { toolImpactKey, useToolsHealth } from '../../hooks/useToolsHealth';
import { useAppStore } from '../../store';
import { relativeAgo } from '../today/today-format';
import type { ConnectorId } from '../../../shared/ipc-types';

const CONNECTOR_NAME: Record<ConnectorId, string> = {
  slack: 'Slack',
  google: 'Google (Gmail, Calendar, Drive)',
  zoom: 'Zoom',
};

function dotClass(status: 'connected' | 'connecting' | 'failed' | 'off'): string {
  switch (status) {
    case 'connected':
      return 'bg-accent';
    case 'connecting':
      return 'bg-warning animate-pulse';
    case 'failed':
      return 'bg-error';
    default:
      return 'bg-text-muted/50';
  }
}

/** Always-visible tools status in the titlebar, with a popover to retry or connect. */
export function ToolsHealthPill() {
  const { t } = useTranslation();
  const health = useToolsHealth();
  const setSettingsTab = useAppStore((s) => s.setSettingsTab);
  const setShowSettings = useAppStore((s) => s.setShowSettings);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    void health.refresh();
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refresh once per open
  }, [open]);

  const { level, failed, connecting, connected, toolCount, servers, connectors } = health;

  const label =
    level === 'degraded'
      ? t('health.pill.degraded', { count: failed.length })
      : level === 'connecting'
        ? t('health.pill.connecting')
        : level === 'none'
          ? t('health.pill.none')
          : t('health.pill.ok', { count: toolCount });

  const openApps = () => {
    setOpen(false);
    setSettingsTab('connectors');
    setShowSettings(true);
  };

  const sorted = [...servers].sort((a, b) => {
    const rank = (s: typeof a) => (s.status === 'failed' ? 0 : s.status === 'connecting' ? 1 : 2);
    return rank(a) - rank(b) || a.name.localeCompare(b.name);
  });

  return (
    <div ref={rootRef} className="titlebar-no-drag relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={t('health.pill.title')}
        className={`inline-flex h-[26px] items-center gap-[7px] rounded-full border px-2.5 text-[12px] font-semibold transition-colors ${
          level === 'degraded'
            ? 'border-error/40 bg-error/10 text-error'
            : 'border-border-subtle bg-surface text-text-secondary hover:border-border hover:text-text-primary'
        }`}
      >
        {level === 'connecting' ? (
          <Loader2 className="h-3 w-3 animate-spin text-warning" />
        ) : (
          <span
            className={`h-[7px] w-[7px] rounded-full ${
              level === 'degraded' ? 'bg-error' : level === 'none' ? 'bg-text-muted' : 'bg-accent'
            }`}
          />
        )}
        {label}
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label={t('health.popover.title')}
          className="absolute right-0 top-[calc(100%+8px)] z-[70] w-[360px] rounded-[14px] border border-border-subtle bg-surface-raised p-3 shadow-elevated animate-fade-in"
        >
          <div className="flex items-center gap-2 px-1 pb-2">
            <p className="text-[13px] font-semibold text-text-primary">
              {t('health.popover.title')}
            </p>
            <span className="ml-auto text-[11.5px] text-text-muted">
              {t('health.popover.checked', { when: relativeAgo(t, health.checkedAt) })}
            </span>
            <button
              type="button"
              onClick={() => void health.refresh()}
              className="flex h-6 w-6 items-center justify-center rounded-md text-text-muted hover:bg-surface-hover hover:text-text-primary"
              aria-label={t('health.popover.refresh')}
              title={t('health.popover.refresh')}
            >
              <RefreshCw className="h-3 w-3" />
            </button>
          </div>
          <p className="px-1 pb-2 text-[12px] leading-[1.5] text-text-secondary">
            {level === 'degraded'
              ? t('health.popover.summaryDegraded', {
                  failed: failed.length,
                  connected: connected.length,
                })
              : level === 'connecting'
                ? t('health.popover.summaryConnecting', { count: connecting.length })
                : t('health.popover.summaryOk', { count: connected.length, tools: toolCount })}
          </p>

          <ul className="max-h-[320px] overflow-y-auto">
            {sorted.map((s) => {
              const retrying = health.retrying.includes(s.id);
              const status = retrying ? 'connecting' : s.status === 'disabled' ? 'off' : s.status;
              return (
                <li
                  key={s.id}
                  className="flex items-start gap-2.5 rounded-lg px-1.5 py-2 hover:bg-surface-hover/60"
                >
                  <span
                    className={`mt-[6px] h-[7px] w-[7px] shrink-0 rounded-full ${dotClass(status)}`}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-medium text-text-primary">{s.name}</p>
                    <p className="text-[11.5px] text-text-muted">
                      {status === 'connected'
                        ? t('health.server.tools', { count: s.toolCount })
                        : status === 'connecting'
                          ? t('health.server.connecting')
                          : status === 'failed'
                            ? `${t('health.server.failed')} ${t(toolImpactKey(s.name))}`
                            : t('health.server.off')}
                    </p>
                    {status === 'failed' && s.lastError ? (
                      <p
                        className="mt-0.5 line-clamp-2 break-words font-mono text-[11px] text-error/90"
                        title={s.lastError}
                      >
                        {s.lastError}
                      </p>
                    ) : null}
                  </div>
                  {s.status === 'failed' ? (
                    <button
                      type="button"
                      onClick={() => void health.retry(s.id)}
                      disabled={retrying}
                      className="btn btn-sm btn-secondary shrink-0"
                    >
                      {retrying ? t('health.retrying') : t('health.retry')}
                    </button>
                  ) : null}
                </li>
              );
            })}
            {connectors.map((c) => (
              <li
                key={c.connectorId}
                className="flex items-start gap-2.5 rounded-lg px-1.5 py-2 hover:bg-surface-hover/60"
              >
                <span
                  className={`mt-[6px] h-[7px] w-[7px] shrink-0 rounded-full ${dotClass(
                    c.connected ? 'connected' : 'off'
                  )}`}
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium text-text-primary">
                    {CONNECTOR_NAME[c.connectorId] ?? c.connectorId}
                  </p>
                  <p className="truncate text-[11.5px] text-text-muted">
                    {c.connected
                      ? c.accountEmail ||
                        c.workspaceName ||
                        c.accountName ||
                        t('health.server.signedIn')
                      : t('health.server.notConnected')}
                  </p>
                </div>
                {!c.connected ? (
                  <button
                    type="button"
                    onClick={openApps}
                    className="btn btn-sm btn-secondary shrink-0"
                  >
                    {t('health.connect')}
                  </button>
                ) : null}
              </li>
            ))}
            {sorted.length === 0 && connectors.length === 0 ? (
              <li className="px-1.5 py-3 text-[12.5px] text-text-muted">
                {t('health.popover.empty')}
              </li>
            ) : null}
          </ul>

          <div className="mt-2 flex items-center gap-2 border-t border-border-subtle px-1 pt-2.5">
            {failed.length > 1 ? (
              <button
                type="button"
                onClick={() => void health.retryAllFailed()}
                className="btn btn-sm btn-secondary"
              >
                {t('health.retryAll')}
              </button>
            ) : null}
            <button
              type="button"
              onClick={openApps}
              className="ml-auto text-[12px] font-semibold text-accent-text hover:underline"
            >
              {t('health.popover.manage')}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
