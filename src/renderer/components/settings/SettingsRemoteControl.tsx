import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MessageSquare, Trash2 } from 'lucide-react';
import type { SlackRelayConnectionEvent, SlackRelayStatus } from '../../../shared/ipc-types';
import { useAppStore } from '../../store';
import { SettingsContentSection, SettingsSwitch } from './shared';

const STATUS_POLL_MS = 5_000;

function formatEventTime(at: number): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'medium',
    }).format(new Date(at));
  } catch {
    return new Date(at).toLocaleString();
  }
}

export function SettingsRemoteControl({ isActive }: { isActive: boolean }) {
  const { t } = useTranslation();
  const setSettingsTab = useAppStore((s) => s.setSettingsTab);
  const [status, setStatus] = useState<SlackRelayStatus | null>(null);
  const [events, setEvents] = useState<SlackRelayConnectionEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [nextStatus, nextLog] = await Promise.all([
      window.electronAPI.remote.getSlackRelayStatus(),
      window.electronAPI.remote.getSlackRelayConnectionLog(),
    ]);
    setStatus(nextStatus);
    setEvents(nextLog);
  }, []);

  useEffect(() => {
    if (!isActive) return;
    void refresh();
    const timer = setInterval(() => void refresh(), STATUS_POLL_MS);
    return () => clearInterval(timer);
  }, [isActive, refresh]);

  const handleToggle = async () => {
    if (!status) return;
    setBusy(true);
    setError(null);
    try {
      const result = await window.electronAPI.remote.setSlackRelayEnabled(!status.enabled);
      setStatus(result.status);
      if (!result.success) setError(result.error ?? null);
      const nextLog = await window.electronAPI.remote.getSlackRelayConnectionLog();
      setEvents(nextLog);
    } finally {
      setBusy(false);
    }
  };

  const handleClearLog = async () => {
    setBusy(true);
    try {
      await window.electronAPI.remote.clearSlackRelayConnectionLog();
      setEvents([]);
    } finally {
      setBusy(false);
    }
  };

  if (!status) {
    return <div className="py-8 text-sm text-text-muted">{t('common.loading')}</div>;
  }

  const statusLine = !status.enabled
    ? t('remote.slackRelayOff')
    : status.connected
      ? t('remote.slackRelayConnected')
      : status.lastError
        ? t('remote.slackRelayError', { error: status.lastError })
        : t('remote.slackRelayConnecting');

  const kindLabel = (kind: SlackRelayConnectionEvent['kind']) =>
    t(`remote.slackRelayLogKind.${kind}`);

  return (
    <div className="space-y-1">
      <SettingsContentSection
        title={t('remote.slackRelayTitle')}
        description={t('remote.slackRelayDesc')}
      >
        <div className="rounded-xl border border-border-subtle bg-background-secondary/40 p-4">
          <div className="flex items-start justify-between gap-4">
            <div className="flex min-w-0 items-start gap-3">
              <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-muted">
                <MessageSquare className="h-4 w-4 text-text-secondary" />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium text-text-primary">
                  {t('remote.slackRelayTitle')}
                </p>
                <p
                  className={`mt-1 text-xs ${
                    status.enabled && status.connected ? 'text-success' : 'text-text-muted'
                  }`}
                >
                  {statusLine}
                </p>
              </div>
            </div>
            <SettingsSwitch
              checked={status.enabled}
              onChange={() => void handleToggle()}
              disabled={busy || (!status.enabled && !status.slackConnected)}
              aria-label={t('remote.slackRelayTitle')}
            />
          </div>

          {!status.slackConnected && (
            <p className="mt-3 text-xs text-text-muted">
              {t('remote.slackRelayNeedsSlack')}{' '}
              <button
                type="button"
                onClick={() => setSettingsTab('connectors')}
                className="font-medium text-accent hover:underline"
              >
                {t('remote.slackRelayOpenConnectors')}
              </button>
            </p>
          )}

          {error && <p className="mt-2 text-xs text-error">{error}</p>}

          <p className="mt-3 text-[11px] leading-4 text-text-muted">
            {t('remote.slackRelayNotice')}
          </p>
        </div>
      </SettingsContentSection>

      <SettingsContentSection
        title={t('remote.slackRelayLogTitle')}
        description={t('remote.slackRelayLogDesc')}
      >
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-text-muted">
            {events.length === 0
              ? t('remote.slackRelayLogEmpty')
              : t('remote.slackRelayLogCount', { count: events.length })}
          </p>
          {events.length > 0 && (
            <button
              type="button"
              onClick={() => void handleClearLog()}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-md border border-border-subtle px-2.5 py-1 text-xs text-text-secondary transition-colors hover:bg-surface-hover disabled:opacity-50"
            >
              <Trash2 className="h-3.5 w-3.5" />
              {t('remote.slackRelayLogClear')}
            </button>
          )}
        </div>

        {events.length > 0 && (
          <ul className="divide-y divide-border-subtle overflow-hidden rounded-xl border border-border-subtle">
            {events.map((event) => (
              <li key={event.id} className="px-3.5 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-text-primary">{kindLabel(event.kind)}</p>
                    {event.detail && (
                      <p className="mt-1 text-xs leading-4 text-text-muted">{event.detail}</p>
                    )}
                    {event.hostname && (
                      <p className="mt-1 text-[11px] text-text-muted">
                        {t('remote.slackRelayLogHost', { host: event.hostname })}
                      </p>
                    )}
                  </div>
                  <time
                    dateTime={new Date(event.at).toISOString()}
                    className="shrink-0 text-[11px] tabular-nums text-text-muted"
                  >
                    {formatEventTime(event.at)}
                  </time>
                </div>
              </li>
            ))}
          </ul>
        )}
      </SettingsContentSection>
    </div>
  );
}
