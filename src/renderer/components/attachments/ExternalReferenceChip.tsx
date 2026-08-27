import type { ReactNode } from 'react';
import { ExternalLink, FileText, Hash, MessageSquare } from 'lucide-react';
import type { ExternalReferenceContent, ExternalReferenceSource } from '../../../shared/external-reference';

const SOURCE_LABEL: Record<ExternalReferenceSource, string> = {
  drive: 'Drive',
  slack: 'Slack',
  jira: 'Jira',
};

function SourceIcon({ source }: { source: ExternalReferenceSource }) {
  if (source === 'slack') return <MessageSquare className="h-4 w-4 text-accent flex-shrink-0" />;
  if (source === 'jira') return <Hash className="h-4 w-4 text-accent flex-shrink-0" />;
  return <FileText className="h-4 w-4 text-accent flex-shrink-0" />;
}

interface ExternalReferenceChipProps {
  reference: ExternalReferenceContent;
  removeButton?: ReactNode;
  className?: string;
}

export function ExternalReferenceChip({
  reference,
  removeButton,
  className = '',
}: ExternalReferenceChipProps) {
  const body = (
    <>
      <SourceIcon source={reference.source} />
      <div className="flex-1 min-w-0">
        <p className="text-sm text-text-primary truncate">{reference.title}</p>
        <p className="text-[11px] text-text-muted truncate">
          {[SOURCE_LABEL[reference.source], reference.subtitle].filter(Boolean).join(' · ')}
        </p>
      </div>
    </>
  );

  return (
    <div
      className={`flex max-w-full min-w-0 items-center gap-2 px-3 py-2 rounded-lg bg-surface-muted border border-border overflow-hidden ${className}`}
    >
      {reference.url ? (
        <a
          href={reference.url}
          target="_blank"
          rel="noreferrer"
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          onClick={(event) => {
            event.stopPropagation();
            if (typeof window !== 'undefined' && window.electronAPI?.openExternal) {
              event.preventDefault();
              void window.electronAPI.openExternal(reference.url!);
            }
          }}
        >
          {body}
          <ExternalLink className="h-3.5 w-3.5 flex-shrink-0 text-text-muted" />
        </a>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-2">{body}</div>
      )}
      {removeButton}
    </div>
  );
}
