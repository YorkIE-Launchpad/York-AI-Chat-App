import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SlackRelayStatus } from '../../../shared/ipc-types';

const STATUS_POLL_MS = 5_000;

export function SlackRemoteControlToggle() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<SlackRelayStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const next = await window.electronAPI.remote.getSlackRelayStatus();
    setStatus(next);
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), STATUS_POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const handleToggle = async () => {
    if (!status) return;
    setBusy(true);
    setError(null);
    try {
      const result = await window.electronAPI.remote.setSlackRelayEnabled(!status.enabled);
      setStatus(result.status);
      if (!result.success) setError(result.error ?? null);
    } finally {
      setBusy(false);
    }
  };

  if (!status) return null;

  const statusLine = !status.enabled
    ? t('remote.slackRelayOff')
    : status.connected
      ? t('remote.slackRelayConnected')
      : status.lastError
        ? t('remote.slackRelayError', { error: status.lastError })
        : t('remote.slackRelayConnecting');

  return (
    <div className="mt-3 border-t border-border-subtle pt-3">
      <label className="flex cursor-pointer items-start gap-2">
        <input
          type="checkbox"
          checked={status.enabled}
          onChange={() => void handleToggle()}
          disabled={busy || (!status.enabled && !status.slackConnected)}
          className="mt-0.5 h-4 w-4 shrink-0 rounded border-border accent-accent disabled:opacity-50"
        />
        <div className="min-w-0">
          <p className="text-xs font-medium text-text-primary">{t('remote.slackRelayTitle')}</p>
          <p className="mt-1 text-xs leading-4 text-text-muted">{t('remote.slackRelayDesc')}</p>
        </div>
      </label>
      <p
        className={`mt-2 text-xs ${
          status.enabled && status.connected ? 'text-success' : 'text-text-muted'
        }`}
      >
        {statusLine}
      </p>
      {error && <p className="mt-1 text-xs text-error">{error}</p>}
      <p className="mt-2 text-[11px] leading-4 text-text-muted">
        {t('remote.slackRelayNotice', { hours: status.idleTimeoutHours })}
      </p>
    </div>
  );
}
