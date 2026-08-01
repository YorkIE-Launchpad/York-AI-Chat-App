import { useMemo } from 'react';
import { useActiveCompactionHistory } from '../store/selectors';
import type { CompactionEvent } from '../store';

export type { CompactionEvent };

/**
 * Returns the list of compaction events for the active session,
 * ordered newest-first for display.
 */
export function useCompactionHistory(): CompactionEvent[] {
  const history = useActiveCompactionHistory();
  return useMemo(() => {
    if (history.length === 0) return history;
    return [...history].reverse();
  }, [history]);
}
