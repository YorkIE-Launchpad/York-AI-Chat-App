import { useState } from 'react';
import { BookOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TurnSources } from '../../utils/session-sources';
import { parseMemoryHref } from '../../utils/memory-cite-link';
import { CitationRow } from '../message/Citations';
import { MemorySourceDetailPanel } from '../message/MemorySourceDetailPanel';

interface SessionSourcesPaneProps {
  turns: TurnSources[];
}

export function SessionSourcesPane({ turns }: SessionSourcesPaneProps) {
  const { t } = useTranslation();
  const [memoryId, setMemoryId] = useState<string | null>(null);

  const open = (url?: string) => {
    if (!url) return;
    const memory = parseMemoryHref(url);
    if (memory) {
      setMemoryId(memory);
      return;
    }
    if (/^https?:/i.test(url)) void window.electronAPI?.openExternal?.(url);
  };

  if (turns.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
        <BookOpen className="h-5 w-5 text-text-muted" />
        <p className="text-[13px] font-medium text-text-primary">{t('inspector.noSources')}</p>
        <p className="text-xs leading-5 text-text-muted">{t('inspector.noSourcesHint')}</p>
      </div>
    );
  }

  return (
    <div className="flex-1 space-y-4 overflow-y-auto px-3 py-3">
      {[...turns].reverse().map((turn) => (
        <section key={turn.userMessageId}>
          <p
            className="mb-1 truncate px-1.5 text-[11.5px] font-medium text-text-muted"
            title={turn.question}
          >
            {turn.question || t('inspector.untitledQuestion')}
          </p>
          <ol className="space-y-0.5">
            {turn.sources.map((source) => (
              <li key={`${turn.userMessageId}:${source.n}`}>
                <CitationRow source={source} onOpen={open} stacked />
              </li>
            ))}
          </ol>
        </section>
      ))}
      {memoryId && (
        <MemorySourceDetailPanel memoryId={memoryId} onClose={() => setMemoryId(null)} />
      )}
    </div>
  );
}
