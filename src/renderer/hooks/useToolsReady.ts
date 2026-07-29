import { useEffect, useRef, useState } from 'react';
import type { McpToolsReadyState } from '../../shared/ipc-types';

const POLL_WHILE_NOT_READY_MS = 1500;
const POLL_WHILE_READY_MS = 5000;

const NOT_READY: McpToolsReadyState = {
  ready: false,
  connectingCount: 0,
  bootstrapComplete: false,
};

export function nextToolsReadyPollIntervalMs(ready: boolean): number {
  return ready ? POLL_WHILE_READY_MS : POLL_WHILE_NOT_READY_MS;
}

/**
 * Polls MCP tools readiness. Defaults to not-ready until the first successful poll
 * so startup always shows the connecting indicator briefly.
 */
export function useToolsReady(isElectron: boolean): McpToolsReadyState {
  const [state, setState] = useState<McpToolsReadyState>(NOT_READY);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    if (
      !isElectron ||
      typeof window === 'undefined' ||
      !window.electronAPI?.mcp?.getToolsReadyState
    ) {
      setState({ ready: true, connectingCount: 0, bootstrapComplete: true });
      return;
    }

    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const scheduleNext = (ready: boolean) => {
      if (cancelled) return;
      timeoutId = setTimeout(() => {
        void poll();
      }, nextToolsReadyPollIntervalMs(ready));
    };

    const poll = async () => {
      try {
        const next = await window.electronAPI.mcp.getToolsReadyState();
        if (cancelled) return;
        setState(next);
        scheduleNext(next.ready);
      } catch (err) {
        console.error('Failed to load MCP tools ready state:', err);
        if (cancelled) return;
        scheduleNext(stateRef.current.ready);
      }
    };

    void poll();

    return () => {
      cancelled = true;
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [isElectron]);

  return state;
}
