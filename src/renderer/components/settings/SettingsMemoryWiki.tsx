/**
 * Memory Wiki browse/edit panel (M1) — mounted inside Settings → Memory.
 */
import { useCallback, useEffect, useState } from 'react';
import type { WikiPage, WikiSearchResult } from '../../../shared/wiki';
import { SettingsContentSection } from './shared';

export function SettingsMemoryWiki() {
  const [pages, setPages] = useState<WikiPage[]>([]);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<WikiSearchResult[] | null>(null);
  const [selected, setSelected] = useState<WikiPage | null>(null);
  const [draftBody, setDraftBody] = useState('');
  const [draftTitle, setDraftTitle] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [count, setCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [superContextMode, setSuperContextMode] = useState<'off' | 'cold_intent' | 'always'>(
    'cold_intent'
  );

  const refresh = useCallback(async () => {
    const api = window.electronAPI?.wiki;
    if (!api) return;
    const [list, c] = await Promise.all([api.list(), api.count()]);
    setPages(list);
    setCount(c.count);
  }, []);

  useEffect(() => {
    void refresh();
    void window.electronAPI?.config?.get?.().then((cfg) => {
      const mode = (cfg as { superContextMode?: string } | null)?.superContextMode;
      if (mode === 'off' || mode === 'always' || mode === 'cold_intent') {
        setSuperContextMode(mode);
      }
    });
  }, [refresh]);

  const openPage = async (id: string) => {
    const page = await window.electronAPI.wiki.get(id);
    if (!page) return;
    setSelected(page);
    setDraftBody(page.body);
    setDraftTitle(page.title);
  };

  const search = async () => {
    if (!query.trim()) {
      setResults(null);
      return;
    }
    setResults(await window.electronAPI.wiki.search(query.trim(), 30));
  };

  const save = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const updated = await window.electronAPI.wiki.update({
        id: selected.id,
        body: draftBody,
        title: draftTitle,
      });
      setSelected(updated);
      setStatus('Page saved (SQLite + vault mirror)');
      await refresh();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const saveSuperContext = async (mode: 'off' | 'cold_intent' | 'always') => {
    setSuperContextMode(mode);
    await window.electronAPI.config.save({ superContextMode: mode });
    setStatus(`SuperContext mode: ${mode}`);
  };

  const display = results
    ? results.map((r) => ({ id: r.id, path: r.path, title: r.title, hint: r.excerpt }))
    : pages.map((p) => ({
        id: p.id,
        path: p.path,
        title: p.title,
        hint: p.body.slice(0, 80),
      }));

  return (
    <div className="space-y-6">
      <SettingsContentSection
        title="Memory Wiki"
        description="Compressed company knowledge (Matter auto-fetch + meetings). SQLite primary, Markdown vault under memory-wiki/. Incognito chats never write here."
      >
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-text-muted">
          <span>{count} pages</span>
          <button
            type="button"
            onClick={() => void refresh()}
            className="rounded-md border border-border px-2 py-1 hover:bg-surface-hover"
          >
            Refresh
          </button>
        </div>

        <div className="mt-3 flex gap-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search wiki…"
            className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm"
            onKeyDown={(e) => {
              if (e.key === 'Enter') void search();
            }}
          />
          <button
            type="button"
            onClick={() => void search()}
            className="rounded-lg bg-accent px-3 py-2 text-sm text-white"
          >
            Search
          </button>
        </div>

        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <div className="max-h-80 space-y-1 overflow-y-auto rounded-lg border border-border-muted p-2">
            {display.length === 0 ? (
              <p className="p-2 text-xs text-text-muted">
                No wiki pages yet. Run a Matter scan or capture a meeting.
              </p>
            ) : (
              display.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => void openPage(item.id)}
                  className={`block w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-surface-hover ${
                    selected?.id === item.id ? 'bg-accent/10' : ''
                  }`}
                >
                  <div className="font-medium text-text-primary">{item.title}</div>
                  <div className="truncate text-[11px] text-text-muted">{item.path}</div>
                </button>
              ))
            )}
          </div>

          <div className="space-y-2 rounded-lg border border-border-muted p-3">
            {selected ? (
              <>
                <input
                  value={draftTitle}
                  onChange={(e) => setDraftTitle(e.target.value)}
                  className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm font-medium"
                />
                <p className="text-[11px] text-text-muted">{selected.path}</p>
                <textarea
                  value={draftBody}
                  onChange={(e) => setDraftBody(e.target.value)}
                  rows={12}
                  className="w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs leading-5"
                />
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void save()}
                  className="rounded-lg bg-accent px-3 py-1.5 text-sm text-white disabled:opacity-50"
                >
                  Save edit
                </button>
              </>
            ) : (
              <p className="text-sm text-text-muted">Select a page to review or edit.</p>
            )}
          </div>
        </div>
        {status && <p className="mt-2 text-xs text-text-muted">{status}</p>}
      </SettingsContentSection>

      <SettingsContentSection
        title="SuperContext"
        description="Budgeted pre-turn scout from wiki, Matter, and meetings. Disabled in Incognito sessions."
      >
        <div className="flex flex-wrap gap-2">
          {(
            [
              ['off', 'Off'],
              ['cold_intent', 'Cold start + brief intents'],
              ['always', 'Always'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => void saveSuperContext(value)}
              className={`rounded-lg border px-3 py-1.5 text-sm ${
                superContextMode === value
                  ? 'border-accent bg-accent/10 text-text-primary'
                  : 'border-border text-text-secondary hover:bg-surface-hover'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </SettingsContentSection>
    </div>
  );
}
