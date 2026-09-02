import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Loader2, Search, X } from 'lucide-react';
import { useAppStore } from '../store';
import type { ChatSearchHit, ChatSearchScope } from '../../shared/chat-search';
import { chatSearchHitToDivisionFields } from '../../shared/chat-search';
import { activeDivisionFromSession, divisionLabel } from '../../shared/workspace-division';

interface ChatSearchModalProps {
  open: boolean;
  onClose: () => void;
  onSelect: (hit: ChatSearchHit) => void;
}

function formatHitDate(timestamp: number): string {
  if (!timestamp) return '';
  try {
    return new Date(timestamp).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return '';
  }
}

export function ChatSearchModal({ open, onClose, onSelect }: ChatSearchModalProps) {
  const { t } = useTranslation();
  const activeDivision = useAppStore((s) => s.activeDivision);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<ChatSearchHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [searchScope, setSearchScope] = useState<ChatSearchScope>('workspace');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setHits([]);
      setError(null);
      setSearchScope('workspace');
      return;
    }
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const trimmed = query.trim();
    if (!trimmed) {
      setHits([]);
      setBusy(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setBusy(true);
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const next = await window.electronAPI.session.searchChats(trimmed, 30, {
            scope: searchScope,
            activeDivision,
          });
          if (!cancelled) {
            setHits(next);
            setSelectedIndex(0);
            setError(null);
          }
        } catch (err) {
          if (!cancelled) {
            setError(err instanceof Error ? err.message : String(err));
            setHits([]);
          }
        } finally {
          if (!cancelled) setBusy(false);
        }
      })();
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, query, searchScope, activeDivision]);

  const choose = useCallback(
    (hit: ChatSearchHit) => {
      onSelect(hit);
      onClose();
    },
    [onClose, onSelect]
  );

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSelectedIndex((index) => Math.min(index + 1, Math.max(hits.length - 1, 0)));
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSelectedIndex((index) => Math.max(index - 1, 0));
        return;
      }
      if (event.key === 'Enter' && hits[selectedIndex]) {
        event.preventDefault();
        choose(hits[selectedIndex]);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [choose, hits, onClose, open, selectedIndex]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-start justify-center bg-black/20 p-4 pt-[12vh] backdrop-blur-sm animate-fade-in"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="chat-search-title"
        className="card m-4 flex max-h-[70vh] w-full max-w-xl flex-col overflow-hidden shadow-elevated animate-slide-up"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-border-subtle px-4 py-3">
          <Search className="h-4 w-4 flex-shrink-0 text-text-muted" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('sidebar.searchAllPlaceholder')}
            className="min-w-0 flex-1 bg-transparent text-[15px] text-text-primary outline-none placeholder:text-text-muted"
            aria-label={t('sidebar.searchAllTitle')}
          />
          {busy && <Loader2 className="h-4 w-4 animate-spin text-text-muted" />}
          <button
            type="button"
            onClick={() =>
              setSearchScope((scope) => (scope === 'workspace' ? 'all' : 'workspace'))
            }
            className={`rounded-lg border px-2 py-1 text-[10px] font-medium transition-colors ${
              searchScope === 'all'
                ? 'border-accent/40 bg-accent/10 text-accent'
                : 'border-border-subtle text-text-muted hover:bg-surface-hover'
            }`}
            title={searchScope === 'all' ? 'Searching all workspaces' : 'Searching this workspace only'}
          >
            {searchScope === 'all' ? 'All' : 'Here'}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-text-secondary transition-colors hover:bg-surface-hover"
            title={t('common.close')}
            aria-label={t('common.close')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {error && <p className="px-3 py-4 text-sm text-error">{error}</p>}
          {!error && !query.trim() && (
            <p className="px-3 py-8 text-center text-sm text-text-muted">
              {t('sidebar.searchAllHint')}
            </p>
          )}
          {!error && query.trim() && !busy && hits.length === 0 && (
            <p className="px-3 py-8 text-center text-sm text-text-muted">
              {t('sidebar.searchNoResults')}
            </p>
          )}
          {hits.map((hit, index) => (
            <button
              key={`${hit.sessionId}:${hit.messageId ?? 'title'}`}
              type="button"
              onClick={() => choose(hit)}
              className={`flex w-full flex-col gap-0.5 rounded-xl px-3 py-2.5 text-left transition-colors ${
                index === selectedIndex ? 'bg-surface-hover' : 'hover:bg-surface-hover/70'
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-text-primary">
                  {hit.title}
                </span>
                <span className="flex-shrink-0 rounded-md bg-background px-1.5 py-0.5 text-[10px] font-medium text-text-muted">
                  {divisionLabel(activeDivisionFromSession(chatSearchHitToDivisionFields(hit)))}
                </span>
                <span className="flex-shrink-0 text-[11px] text-text-muted">
                  {formatHitDate(hit.timestamp)}
                </span>
              </div>
              {hit.snippet && hit.snippet !== hit.title && (
                <p className="line-clamp-2 text-[12px] leading-4 text-text-secondary">
                  {hit.snippet}
                </p>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.body
  );
}

export function useChatSearchHotkey(onOpen: () => void, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return;
      if (event.key.toLowerCase() !== 'k') return;
      event.preventDefault();
      event.stopPropagation();
      onOpen();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [enabled, onOpen]);
}
