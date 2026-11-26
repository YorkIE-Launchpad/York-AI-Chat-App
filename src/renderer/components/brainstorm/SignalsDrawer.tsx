import { useState } from 'react';
import { ChevronDown, FileText, Newspaper } from 'lucide-react';
import type { BrainstormSignal } from '../../../shared/brainstorm-types';
import { normalizeSelectedFiles } from '../../utils/load-composer-image';

export function SignalsDrawer({
  signals,
  onAddFiles,
}: {
  signals: BrainstormSignal[];
  onAddFiles: (paths: string[]) => void;
}) {
  const [open, setOpen] = useState(true);
  const files = signals.filter((signal) => signal.kind === 'file');
  const web = signals.filter((signal) => signal.kind !== 'file');

  const pick = async () => {
    const selected = await window.electronAPI?.selectFiles?.();
    const paths = normalizeSelectedFiles(selected || []).map((file) => file.path);
    if (paths.length > 0) onAddFiles(paths);
  };

  return (
    <section className="rounded-xl border border-border-subtle bg-background">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-text-secondary"
      >
        <Newspaper className="h-3.5 w-3.5" />
        <span className="flex-1 font-medium">Sources</span>
        <span className="text-text-muted">{signals.length}</span>
        <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open ? (
        <div className="space-y-2 border-t border-border-subtle px-3 py-2">
          <button
            type="button"
            onClick={() => void pick()}
            className="text-[12px] text-text-secondary underline"
          >
            Add file
          </button>
          {files.length > 0 ? (
            <ul className="space-y-1.5">
              {files.map((signal) => (
                <li key={signal.id} className="flex items-center gap-2 text-[12.5px]">
                  <FileText className="h-3.5 w-3.5 text-text-muted" />
                  <span className="min-w-0 flex-1 truncate text-text-primary">{signal.title}</span>
                  <span className="text-[11px] text-text-muted">{signal.status || 'ready'}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {web.length === 0 && files.length === 0 ? (
            <p className="text-[12px] text-text-muted">
              Uploaded files, connected tools, and web research show up here.
            </p>
          ) : (
            <ul className="space-y-2">
              {web.map((signal) => (
                <li key={signal.id} className="text-[12.5px] leading-snug">
                  <p className="font-medium text-text-primary">{signal.title}</p>
                  {signal.summary ? (
                    <p className="mt-0.5 text-text-secondary">{signal.summary}</p>
                  ) : null}
                  {signal.url ? (
                    <a
                      href={signal.url}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-0.5 inline-block text-[11px] text-text-muted underline"
                    >
                      {signal.source || signal.url}
                    </a>
                  ) : signal.source ? (
                    <p className="mt-0.5 text-[11px] text-text-muted">{signal.source}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  );
}
