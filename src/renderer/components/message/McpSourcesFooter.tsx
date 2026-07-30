import { ExternalLink } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { McpSourceItem } from '../../utils/mcp-sources';

interface McpSourcesFooterProps {
  sources: McpSourceItem[];
}

export function McpSourcesFooter({ sources }: McpSourcesFooterProps) {
  const { t } = useTranslation();

  if (sources.length === 0) return null;

  const openUrl = (url: string) => {
    if (typeof window !== 'undefined' && window.electronAPI?.openExternal) {
      void window.electronAPI.openExternal(url);
    }
  };

  return (
    <div className="mt-3 pt-3 border-t border-border-muted">
      <p className="text-[11px] uppercase tracking-[0.08em] text-text-muted mb-2">
        {t('messageCard.sources')}
      </p>
      <ul className="space-y-1.5">
        {sources.map((source) => {
          const key = source.url || `server:${source.serverName}:${source.title}`;
          if (source.url) {
            return (
              <li key={key}>
                <button
                  type="button"
                  onClick={() => openUrl(source.url!)}
                  className="inline-flex items-center gap-1.5 text-sm text-accent hover:text-accent-hover text-left max-w-full"
                  title={source.url}
                >
                  <ExternalLink className="w-3 h-3 flex-shrink-0 opacity-70" />
                  <span className="truncate">{source.title}</span>
                </button>
              </li>
            );
          }
          return (
            <li key={key} className="text-sm text-text-secondary">
              {source.title}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
