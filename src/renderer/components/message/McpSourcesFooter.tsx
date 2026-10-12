import type { McpSourceItem } from '../../utils/mcp-sources';
import { CitationList } from './Citations';

interface McpSourcesFooterProps {
  sources: McpSourceItem[];
}

export function McpSourcesFooter({ sources }: McpSourcesFooterProps) {
  if (sources.length === 0) return null;

  const openUrl = (url?: string) => {
    if (url && typeof window !== 'undefined' && window.electronAPI?.openExternal) {
      void window.electronAPI.openExternal(url);
    }
  };

  return (
    <CitationList
      className="mt-3"
      onOpen={openUrl}
      sources={sources.map((source, index) => ({
        n: index + 1,
        title: source.url ? source.title : `${source.title} · ${source.serverName}`,
        url: source.url,
      }))}
    />
  );
}
