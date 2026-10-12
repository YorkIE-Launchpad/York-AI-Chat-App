import { ArrowUpRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { citationHost, type Citation } from '../../utils/citations';

interface CitationChipProps {
  source: Citation;
  onOpen: (url?: string) => void;
}

export function CitationChip({ source, onOpen }: CitationChipProps) {
  const host = citationHost(source.url);
  return (
    <button
      type="button"
      className="cite-chip"
      onClick={() => onOpen(source.url)}
      title={host ? `${source.title} · ${host}` : source.title}
      aria-label={`Source ${source.n}: ${source.title}`}
      disabled={!source.url}
    >
      {source.n}
    </button>
  );
}

interface CitationListProps {
  sources: Citation[];
  onOpen: (url?: string) => void;
  className?: string;
}

export function CitationList({ sources, onOpen, className = 'mt-4' }: CitationListProps) {
  const { t } = useTranslation();
  if (sources.length === 0) return null;
  return (
    <div className={`${className} rounded-xl border border-border-muted bg-surface/60 px-3 py-2.5`}>
      <p className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-text-muted">
        {t('messageCard.sources')}
      </p>
      <ol className="space-y-0.5">
        {sources.map((source) => (
          <li key={source.n}>
            <CitationRow source={source} onOpen={onOpen} />
          </li>
        ))}
      </ol>
    </div>
  );
}

interface CitationRowProps extends CitationChipProps {
  /** Host on its own line under the title (narrow panels). */
  stacked?: boolean;
}

export function CitationRow({ source, onOpen, stacked = false }: CitationRowProps) {
  const host = citationHost(source.url);
  const body = stacked ? (
    <>
      <span className="cite-num mt-px">{source.n}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate">{source.title}</span>
        {host && <span className="block truncate text-[11px] text-text-muted">{host}</span>}
      </span>
    </>
  ) : (
    <>
      <span className="cite-num">{source.n}</span>
      <span className="min-w-0 flex-1 truncate">{source.title}</span>
      {host && (
        <span className="min-w-0 max-w-[40%] shrink truncate text-[11px] text-text-muted">
          {host}
        </span>
      )}
      {source.url && (
        <ArrowUpRight className="h-3 w-3 shrink-0 text-text-muted opacity-0 transition-opacity group-hover:opacity-100" />
      )}
    </>
  );
  const align = stacked ? 'items-start' : 'items-center';
  if (!source.url) {
    return (
      <div className={`flex ${align} gap-2 rounded-md px-1.5 py-1 text-[13px] text-text-secondary`}>
        {body}
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={() => onOpen(source.url)}
      title={source.url}
      className={`group flex w-full ${align} gap-2 rounded-md px-1.5 py-1 text-left text-[13px] text-text-primary transition-colors hover:bg-surface-hover`}
    >
      {body}
    </button>
  );
}
