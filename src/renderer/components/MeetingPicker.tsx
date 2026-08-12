import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { X, Mic, Loader2, Search } from 'lucide-react';
import type { MeetingListItem } from '../types';

export type AttachedMeeting = {
  meetingId: string;
  title: string;
  summary?: string;
  includeTranscript?: boolean;
};

interface MeetingPickerProps {
  open: boolean;
  onClose: () => void;
  onSelect: (meeting: AttachedMeeting) => void;
  excludeIds?: string[];
}

export function MeetingPicker({ open, onClose, onSelect, excludeIds = [] }: MeetingPickerProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<MeetingListItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const excludeKey = excludeIds.join('|');

  useEffect(() => {
    if (!open) {
      setQuery('');
      setError(null);
      return;
    }
    let cancelled = false;
    const load = async () => {
      setBusy(true);
      setError(null);
      try {
        const next = query.trim()
          ? await window.electronAPI.meetings.search(query.trim())
          : await window.electronAPI.meetings.list();
        if (!cancelled) {
          const excluded = new Set(excludeKey ? excludeKey.split('|') : []);
          setItems(next.filter((item) => item.status === 'ready' && !excluded.has(item.id)));
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setBusy(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [open, query, excludeKey]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/20 p-4 backdrop-blur-sm animate-fade-in"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="meeting-picker-title"
        className="card m-4 flex max-h-[80vh] w-full max-w-md flex-col overflow-hidden shadow-elevated animate-slide-up"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start gap-4 border-b border-border-subtle px-5 py-4">
          <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-xl bg-accent-muted">
            <Mic className="h-6 w-6 text-accent" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="meeting-picker-title" className="text-lg font-semibold text-text-primary">
              {t('meetings.pickerTitle')}
            </h2>
            <p className="mt-1 text-sm text-text-secondary">{t('meetings.pickerDesc')}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-2 text-text-secondary transition-colors hover:bg-surface-hover"
            title={t('common.close')}
            aria-label={t('common.close')}
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="border-b border-border-subtle px-5 py-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('meetings.searchPlaceholder')}
              className="input py-2.5 pl-9 text-sm"
            />
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2">
          {busy && (
            <div className="flex items-center justify-center gap-2 px-3 py-8 text-sm text-text-secondary">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('common.loading')}
            </div>
          )}
          {error && <p className="px-3 py-4 text-sm text-error">{error}</p>}
          {!busy && !error && items.length === 0 && (
            <p className="px-3 py-8 text-center text-sm text-text-muted">
              {t('meetings.noMeetings')}
            </p>
          )}
          {!busy &&
            !error &&
            items.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  onSelect({
                    meetingId: item.id,
                    title: item.title,
                    summary: item.summary,
                    includeTranscript: false,
                  });
                  onClose();
                }}
                className="flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left text-text-primary transition-colors hover:bg-surface-hover"
              >
                <div className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-accent-muted">
                  <Mic className="h-4 w-4 text-accent" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium">{item.title}</p>
                  <p className="mt-0.5 text-[11px] text-text-muted">
                    {new Date(item.startedAt).toLocaleString()}
                  </p>
                  {item.summary ? (
                    <p className="mt-1 line-clamp-2 text-[12px] leading-snug text-text-secondary">
                      {item.summary}
                    </p>
                  ) : null}
                </div>
              </button>
            ))}
        </div>
      </div>
    </div>,
    document.body
  );
}
