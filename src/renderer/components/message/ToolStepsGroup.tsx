// Collapses a run of consecutive tool calls into one summary line ("Checked 3 sources in 9s").
import { memo, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Loader2, XCircle, CheckCircle2 } from 'lucide-react';
import { useAppStore } from '../../store';
import type { ContentBlock, Message, ToolResultContent, ToolUseContent } from '../../types';
import type { MatterSource } from '../../../shared/matter';
import { SOURCE_TILE } from '../today/today-format';
import { ToolUseBlock } from './ToolUseBlock';
import { getToolLabel } from './toolHelpers';

interface ToolStepsGroupProps {
  blocks: ToolUseContent[];
  allBlocks: ContentBlock[];
  message: Message;
}

const EMPTY_MESSAGES: Message[] = [];

export function sourceForToolName(name: string): MatterSource | null {
  const match = name.match(/^mcp__(.+?)__/);
  if (!match) return null;
  const server = match[1].toLowerCase();
  if (server.includes('slack')) return 'slack';
  if (server.includes('gmail') || server.includes('mail')) return 'gmail';
  if (server.includes('calendar')) return 'calendar';
  if (server.includes('drive') || server.includes('docs')) return 'drive';
  if (server.includes('jira') || server.includes('atlassian') || server.includes('confluence'))
    return 'jira';
  if (server.includes('zoom') || server.includes('meeting')) return 'meeting';
  if (server.includes('launchpad') || server.includes('pulse')) return 'launchpad';
  if (server.includes('hub') || server.includes('york')) return 'hub';
  return 'fused';
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(s < 10 ? 1 : 0)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

export const ToolStepsGroup = memo(function ToolStepsGroup({
  blocks,
  allBlocks,
  message,
}: ToolStepsGroupProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const sessionId = message.sessionId;
  const traceSteps = useAppStore((s) =>
    sessionId ? (s.sessionStates[sessionId]?.traceSteps ?? null) : null
  );
  const allMessages = useAppStore((s) =>
    sessionId ? (s.sessionStates[sessionId]?.messages ?? EMPTY_MESSAGES) : EMPTY_MESSAGES
  );
  const hasActiveTurn = useAppStore((s) =>
    sessionId ? Boolean(s.sessionStates[sessionId]?.activeTurn) : false
  );

  const stats = useMemo(() => {
    const results = new Map<string, ToolResultContent>();
    const collect = (list: ContentBlock[]) => {
      for (const b of list) {
        if (b.type === 'tool_result') {
          const r = b as ToolResultContent;
          results.set(r.toolUseId, r);
        }
      }
    };
    collect(allBlocks);
    for (const m of allMessages) {
      if (Array.isArray(m.content)) collect(m.content as ContentBlock[]);
    }
    let done = 0;
    let errors = 0;
    let durationMs = 0;
    let running: ToolUseContent | null = null;
    const sources: MatterSource[] = [];
    for (const b of blocks) {
      const r = results.get(b.id);
      if (r) {
        done += 1;
        if (r.isError) errors += 1;
      } else if (!running && hasActiveTurn) {
        running = b;
      }
      const step = traceSteps?.find((s) => s.id === b.id && s.type === 'tool_result');
      if (step?.duration) durationMs += step.duration;
      const src = sourceForToolName(b.name);
      if (src && !sources.includes(src)) sources.push(src);
    }
    return { done, errors, durationMs, running, sources };
  }, [allBlocks, allMessages, blocks, hasActiveTurn, traceSteps]);

  const total = blocks.length;
  const isRunning = stats.running !== null;
  const label = isRunning
    ? t('chat.steps.running', {
        step: Math.min(stats.done + 1, total),
        count: total,
        label: getToolLabel(stats.running!.name, stats.running!.input, stats.running!.displayName),
      })
    : stats.sources.length > 0
      ? t('chat.steps.checkedSources', { count: stats.sources.length, steps: total })
      : t('chat.steps.ranSteps', { count: total });

  return (
    <div
      className={`overflow-hidden rounded-xl border transition-colors ${
        stats.errors > 0 && !isRunning
          ? 'border-error/25'
          : isRunning
            ? 'border-accent/20 bg-accent/5'
            : 'border-border-subtle'
      }`}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12.5px] text-text-secondary transition-colors hover:bg-surface-hover/50"
      >
        {isRunning ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-accent-text" />
        ) : stats.errors > 0 ? (
          <XCircle className="h-3.5 w-3.5 shrink-0 text-error" />
        ) : (
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" />
        )}
        <span className="min-w-0 truncate">{label}</span>
        {!isRunning && stats.durationMs > 0 ? (
          <span className="shrink-0 tabular-nums text-text-muted">
            {t('chat.steps.inTime', { time: formatDuration(stats.durationMs) })}
          </span>
        ) : null}
        {stats.sources.length > 0 ? (
          <span className="ml-1 flex shrink-0 gap-[3px]" aria-hidden>
            {stats.sources.slice(0, 6).map((src) => (
              <span
                key={src}
                className={`grid h-4 w-4 place-items-center rounded text-[8px] font-extrabold ${SOURCE_TILE[src].className}`}
              >
                {SOURCE_TILE[src].abbr}
              </span>
            ))}
          </span>
        ) : null}
        {stats.errors > 0 && !isRunning ? (
          <span className="shrink-0 text-error">
            {t('chat.steps.failed', { count: stats.errors })}
          </span>
        ) : null}
        <ChevronRight
          className={`ml-auto h-3.5 w-3.5 shrink-0 text-text-muted transition-transform ${
            open ? 'rotate-90' : ''
          }`}
        />
      </button>
      {open ? (
        <div className="space-y-1.5 border-t border-border-subtle bg-background/30 p-2 animate-fade-in">
          {blocks.map((b) => (
            <ToolUseBlock key={b.id} block={b} allBlocks={allBlocks} message={message} />
          ))}
        </div>
      ) : null}
    </div>
  );
});
