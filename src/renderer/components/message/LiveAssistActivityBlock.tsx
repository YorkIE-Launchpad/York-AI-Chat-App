import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bot, CheckCircle2, ChevronDown, ChevronRight, Loader2, XCircle } from 'lucide-react';
import type { LiveAssistActivityContent } from '../../types';

interface LiveAssistActivityBlockProps {
  block: LiveAssistActivityContent;
}

function phaseLabelKey(phase: LiveAssistActivityContent['phase']): string {
  switch (phase) {
    case 'detected':
      return 'meetings.liveAssistPhaseDetected';
    case 'planning':
      return 'meetings.liveAssistPhasePlanning';
    case 'mcp':
      return 'meetings.liveAssistPhaseMcp';
    case 'summarizing':
      return 'meetings.liveAssistPhaseSummarizing';
    case 'done':
      return 'meetings.liveAssistPhaseDone';
    case 'failed':
      return 'meetings.liveAssistPhaseFailed';
    default:
      return 'meetings.liveAssistPhaseDetected';
  }
}

export const LiveAssistActivityBlock = memo(function LiveAssistActivityBlock({
  block,
}: LiveAssistActivityBlockProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(block.status === 'running');

  const isRunning = block.status === 'running';
  const isFailed = block.status === 'failed';

  return (
    <div
      className={`rounded-2xl border overflow-hidden max-w-full ${
        isFailed
          ? 'border-error/25 bg-error/5'
          : isRunning
            ? 'border-accent/15 bg-accent/5'
            : 'border-border-subtle bg-background/40'
      }`}
    >
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-surface-hover/50 transition-colors"
      >
        <div
          className={`flex-shrink-0 ${
            isFailed ? 'text-error' : isRunning ? 'text-accent' : 'text-success'
          }`}
        >
          {isRunning ? (
            <Loader2 className="w-4 h-4 animate-spin" aria-hidden />
          ) : isFailed ? (
            <XCircle className="w-4 h-4" aria-hidden />
          ) : (
            <CheckCircle2 className="w-4 h-4" aria-hidden />
          )}
        </div>
        <Bot className="w-4 h-4 text-text-muted flex-shrink-0" aria-hidden />
        <span className="text-xs font-medium text-text-secondary truncate flex-1 min-w-0">
          {t('meetings.liveAssistResearching')}: {block.question}
        </span>
        {expanded ? (
          <ChevronDown className="w-3.5 h-3.5 text-text-muted flex-shrink-0" aria-hidden />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-text-muted flex-shrink-0" aria-hidden />
        )}
      </button>

      {expanded ? (
        <div className="px-3 pb-3 space-y-1.5 border-t border-border-subtle/60">
          <p className="text-[11px] text-text-muted pt-2">{t(phaseLabelKey(block.phase))}</p>
          {block.detail ? (
            <p className="text-[11px] font-mono text-text-secondary break-all">{block.detail}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});
