import { useCallback, useSyncExternalStore } from 'react';
import type { ConnectorStatus, McpServerStatus, McpToolsReadyState } from '../../shared/ipc-types';

export type ToolHealthLevel = 'ok' | 'connecting' | 'degraded' | 'none';

export interface ToolsHealthState {
  loaded: boolean;
  servers: McpServerStatus[];
  connectors: ConnectorStatus[];
  ready: McpToolsReadyState;
  checkedAt: number | null;
  /** Server ids with a retry in flight. */
  retrying: string[];
}

const POLL_CONNECTING_MS = 1500;
const POLL_STEADY_MS = 10_000;

let state: ToolsHealthState = {
  loaded: false,
  servers: [],
  connectors: [],
  ready: { ready: false, connectingCount: 0, bootstrapComplete: false },
  checkedAt: null,
  retrying: [],
};
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;
let inFlight: Promise<void> | null = null;

function emit(next: Partial<ToolsHealthState>) {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

function api() {
  return typeof window !== 'undefined' ? window.electronAPI : undefined;
}

async function poll(): Promise<void> {
  const electron = api();
  if (!electron?.mcp?.getServerStatus) {
    emit({
      loaded: true,
      ready: { ready: true, connectingCount: 0, bootstrapComplete: true },
      checkedAt: Date.now(),
    });
    return;
  }
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const [servers, ready, connectors] = await Promise.all([
        electron.mcp.getServerStatus(),
        electron.mcp.getToolsReadyState?.() ?? Promise.resolve(state.ready),
        electron.connectors?.getStatus?.().catch(() => [] as ConnectorStatus[]) ??
          Promise.resolve([] as ConnectorStatus[]),
      ]);
      emit({
        loaded: true,
        servers: (servers ?? []).filter((s) => s.status !== 'disabled'),
        ready,
        connectors: connectors ?? [],
        checkedAt: Date.now(),
      });
    } catch (err) {
      console.warn('[ToolsHealth] poll failed', err);
      emit({ loaded: true, checkedAt: Date.now() });
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

function schedule() {
  if (timer) clearTimeout(timer);
  if (listeners.size === 0) return;
  const connecting = !state.ready.ready || state.servers.some((s) => s.status === 'connecting');
  timer = setTimeout(
    () => {
      void poll().finally(schedule);
    },
    connecting ? POLL_CONNECTING_MS : POLL_STEADY_MS
  );
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) void poll().finally(schedule);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
}

function getSnapshot() {
  return state;
}

export function summarizeToolsHealth(s: ToolsHealthState) {
  const failed = s.servers.filter((x) => x.status === 'failed');
  const connecting = s.servers.filter((x) => x.status === 'connecting');
  const connected = s.servers.filter((x) => x.status === 'connected');
  const toolCount = connected.reduce((sum, x) => sum + (x.toolCount || 0), 0);
  let level: ToolHealthLevel = 'ok';
  if (s.servers.length === 0 && s.loaded) level = 'none';
  if (connecting.length > 0 || (!s.ready.ready && !s.ready.bootstrapComplete)) level = 'connecting';
  if (failed.length > 0) level = 'degraded';
  return { failed, connecting, connected, toolCount, level };
}

/** What the user loses while a server is down — shown on Today and in the popover. */
export function toolImpactKey(name: string): string {
  const n = name.toLowerCase();
  if (n.includes('jira') || n.includes('atlassian') || n.includes('confluence'))
    return 'health.impact.jira';
  if (n.includes('slack')) return 'health.impact.slack';
  if (n.includes('gmail') || n.includes('mail')) return 'health.impact.gmail';
  if (n.includes('calendar')) return 'health.impact.calendar';
  if (n.includes('drive') || n.includes('google')) return 'health.impact.google';
  if (n.includes('hub')) return 'health.impact.hub';
  if (n.includes('launchpad')) return 'health.impact.launchpad';
  return 'health.impact.generic';
}

export function useToolsHealth() {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const retry = useCallback(async (serverId: string) => {
    const electron = api();
    if (!electron?.mcp?.reconnectServer) return;
    emit({ retrying: [...state.retrying, serverId] });
    try {
      await electron.mcp.reconnectServer(serverId);
    } catch (err) {
      console.warn('[ToolsHealth] reconnect failed', err);
    } finally {
      emit({ retrying: state.retrying.filter((id) => id !== serverId) });
      await poll();
      schedule();
    }
  }, []);

  const retryAllFailed = useCallback(async () => {
    const failed = state.servers.filter((s) => s.status === 'failed');
    await Promise.all(failed.map((s) => retry(s.id)));
  }, [retry]);

  const refresh = useCallback(async () => {
    await poll();
    schedule();
  }, []);

  return { ...snapshot, ...summarizeToolsHealth(snapshot), retry, retryAllFailed, refresh };
}
