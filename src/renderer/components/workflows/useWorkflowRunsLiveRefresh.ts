/**
 * Live refresh while any listed run is non-terminal (OpenHuman useFlowRunsLiveRefresh).
 */
import { useEffect, useRef } from 'react';
import type { CheckpointRun } from '../../../shared/orchestration';
import { isWorkflowRunTerminal } from '../../../shared/workflows';

const POLL_MS = 5000;

/**
 * While `runs` contains a non-terminal run: poll via `refetch`, and listen to
 * workflows:run-progress to refetch sooner.
 */
export function useWorkflowRunsLiveRefresh(
  runs: CheckpointRun[],
  refetch: () => void
): void {
  const refetchRef = useRef(refetch);
  refetchRef.current = refetch;

  const hasActive = runs.some((run) => !isWorkflowRunTerminal(run.status));

  useEffect(() => {
    if (!hasActive) return undefined;

    const onProgress = () => {
      refetchRef.current();
    };

    const unsub = window.electronAPI?.workflows?.onRunProgress?.(onProgress);
    const timer = window.setInterval(() => {
      refetchRef.current();
    }, POLL_MS);

    return () => {
      unsub?.();
      window.clearInterval(timer);
    };
  }, [hasActive]);
}
