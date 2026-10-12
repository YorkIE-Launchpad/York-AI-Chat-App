import type { RefObject } from 'react';
import { FileUp, Plug, RefreshCw, Share2, Users, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface ChatHeaderProps {
  title: string;
  workspaceLabel: string;
  shared?: { peerCount: number } | null;
  canShare: boolean;
  onShare: () => void;
  onExport: () => void;
  loopLabel?: string | null;
  onStopLoop: () => void;
  connectorCount: number;
  showConnectorLabel: boolean;
  headerRef: RefObject<HTMLDivElement>;
  rightActionsRef: RefObject<HTMLDivElement>;
  connectorMeasureRef: RefObject<HTMLDivElement>;
  connectorBadgeRef: RefObject<HTMLDivElement>;
}

const iconButton =
  'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-surface-hover hover:text-text-primary disabled:pointer-events-none disabled:opacity-40';

/** Chat header: workspace chip · title · actions. Measure refs keep the connector label from overlapping. */
export function ChatHeader({
  title,
  workspaceLabel,
  shared,
  canShare,
  onShare,
  onExport,
  loopLabel,
  onStopLoop,
  connectorCount,
  showConnectorLabel,
  headerRef,
  rightActionsRef,
  connectorMeasureRef,
  connectorBadgeRef,
}: ChatHeaderProps) {
  const { t } = useTranslation();
  const connectorText = t('chat.connectorCount', { count: connectorCount });

  return (
    <div
      ref={headerRef}
      className="relative flex h-12 shrink-0 items-center gap-2.5 border-b border-border-muted bg-background/88 px-4 backdrop-blur-md lg:px-6"
    >
      <span
        className="max-w-[30%] shrink-0 truncate rounded-md border border-border-subtle bg-surface px-1.5 py-0.5 text-[11px] font-medium text-text-secondary"
        title={workspaceLabel}
      >
        {workspaceLabel}
      </span>
      <h2
        className="min-w-0 flex-1 truncate text-[14px] font-semibold tracking-[-0.005em] text-text-primary"
        title={title}
      >
        {title}
        {shared ? (
          <span className="ml-2 inline-flex items-center gap-1 rounded-md bg-surface-hover px-1.5 py-0.5 align-middle text-[10.5px] font-medium text-text-muted">
            <Users className="h-3 w-3" />
            {t('chat.collabSharedBadge')}
            {shared.peerCount > 0 ? ` · ${shared.peerCount}` : null}
          </span>
        ) : null}
      </h2>
      <div ref={rightActionsRef} className="relative flex shrink-0 items-center gap-1">
        {loopLabel ? (
          <button
            type="button"
            onClick={onStopLoop}
            className="group mr-1 flex max-w-[10rem] shrink-0 items-center gap-1.5 rounded-full border border-accent/25 bg-accent/10 px-2.5 py-1 text-xs font-medium text-accent-text transition-colors hover:bg-accent/15"
            title={t('loop.stopButton')}
          >
            <RefreshCw className="h-3.5 w-3.5 shrink-0 animate-spin [animation-duration:3s]" />
            <span className="truncate">{loopLabel}</span>
            <X className="h-3 w-3 shrink-0 opacity-60 group-hover:opacity-100" />
          </button>
        ) : null}
        {connectorCount > 0 ? (
          <>
            <div
              ref={connectorMeasureRef}
              aria-hidden="true"
              className="pointer-events-none absolute left-0 top-0 -z-10 opacity-0"
            >
              <div className="flex items-center gap-1.5 px-2.5 py-1">
                <Plug className="h-3.5 w-3.5" />
                <span className="whitespace-nowrap text-xs font-medium">{connectorText}</span>
              </div>
            </div>
            <div
              ref={connectorBadgeRef}
              className="mr-1 flex shrink-0 items-center gap-1.5 rounded-full border border-mcp/15 bg-mcp/8 px-2.5 py-1"
              title={connectorText}
            >
              <Plug className="h-3.5 w-3.5 shrink-0 text-mcp" />
              <span className="whitespace-nowrap text-xs font-medium text-mcp">
                {showConnectorLabel ? connectorText : connectorCount}
              </span>
            </div>
          </>
        ) : null}
        <button
          type="button"
          onClick={onShare}
          disabled={!canShare}
          className={iconButton}
          title={t('chat.shareChat')}
          aria-label={t('chat.shareChat')}
        >
          <Share2 className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={onExport}
          disabled={!canShare}
          className={iconButton}
          title={t('chat.exportChat')}
          aria-label={t('chat.exportChat')}
        >
          <FileUp className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
