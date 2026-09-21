import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw } from 'lucide-react';
import type { McpServerStatus, McpToolsReadyState } from '../../shared/ipc-types';
import { nextToolsReadyPollIntervalMs } from '../hooks/useToolsReady';

function statusDotClass(status: McpServerStatus['status']): string {
  switch (status) {
    case 'connecting':
      return 'bg-warning';
    case 'failed':
      return 'bg-error';
    case 'connected':
      return 'bg-success';
    default:
      return 'bg-text-muted';
  }
}

function statusLabelKey(status: McpServerStatus['status']): string {
  switch (status) {
    case 'connecting':
      return 'mcp.connecting';
    case 'failed':
      return 'mcp.failed';
    case 'connected':
      return 'mcp.connected';
    default:
      return 'mcp.disabled';
  }
}

export function ToolsConnectingStatus({
  toolsReadyState,
}: {
  toolsReadyState: McpToolsReadyState;
}) {
  const { t } = useTranslation();
  const { ready, connectingCount } = toolsReadyState;
  const [servers, setServers] = useState<McpServerStatus[]>([]);

  useEffect(() => {
    if (ready) {
      setServers([]);
      return;
    }

    if (typeof window === 'undefined' || !window.electronAPI?.mcp?.getServerStatus) {
      return;
    }

    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      try {
        const statuses = await window.electronAPI.mcp.getServerStatus();
        if (cancelled) return;
        setServers((statuses ?? []).filter((s) => s.status !== 'disabled'));
      } catch (err) {
        console.error('Failed to load MCP server status:', err);
      } finally {
        if (!cancelled) {
          timeoutId = setTimeout(() => {
            void poll();
          }, nextToolsReadyPollIntervalMs(false));
        }
      }
    };

    void poll();

    return () => {
      cancelled = true;
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [ready]);

  if (ready) return null;

  const summary =
    connectingCount > 0
      ? t('chat.toolsConnectingCount', { count: connectingCount })
      : t('chat.toolsNotReady');

  return (
    <div
      className="px-4 py-2 text-xs text-text-secondary border-b border-border-muted bg-surface/60 flex flex-col gap-1.5 shrink-0"
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center gap-2">
        <RefreshCw
          className="w-3.5 h-3.5 animate-spin shrink-0 text-text-muted"
          style={{ animationDuration: '3s' }}
          aria-hidden="true"
        />
        <span>{summary}</span>
      </div>
      {servers.length > 0 && (
        <ul className="flex flex-wrap items-center gap-1.5 list-none m-0 p-0 ml-5">
          {servers.map((server) => {
            const label = t(statusLabelKey(server.status));
            return (
              <li
                key={server.id}
                className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-surface-muted border border-border-muted"
                title={label}
              >
                <span
                  className={`w-1.5 h-1.5 rounded-full shrink-0 ${statusDotClass(server.status)}`}
                  aria-hidden="true"
                />
                <span className="text-text-primary font-medium truncate max-w-[10rem]">
                  {server.name}
                </span>
                <span className="text-text-muted truncate">{label}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
