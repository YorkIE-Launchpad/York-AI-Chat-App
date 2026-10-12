import { Clock } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface ChatActivityProps {
  /** Status while the turn has started but nothing has streamed yet. */
  processingLabel: string | null;
  elapsedLabel: string | null;
  running: boolean;
}

/** In-flow "working" line and the turn timer under the last message. */
export function ChatActivity({ processingLabel, elapsedLabel, running }: ChatActivityProps) {
  const { t } = useTranslation();
  return (
    <>
      {processingLabel ? (
        <div className="flex min-w-0 max-w-md items-center gap-2.5 py-1 text-[13px] text-text-secondary">
          <span className="relative flex h-2 w-2 shrink-0">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent/50" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
          </span>
          <span className="truncate">{processingLabel}</span>
        </div>
      ) : null}
      {elapsedLabel ? (
        <div className="ml-0.5 mt-1 flex items-center gap-1.5 text-[11px] tabular-nums text-text-muted">
          <Clock className="h-3 w-3" />
          <span>
            {running ? elapsedLabel : t('messageCard.executionTime', { time: elapsedLabel })}
          </span>
        </div>
      ) : null}
    </>
  );
}
