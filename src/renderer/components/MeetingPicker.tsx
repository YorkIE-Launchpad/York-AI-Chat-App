import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Mic } from 'lucide-react';
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

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const load = async () => {
      setBusy(true);
      setError(null);
      try {
        const next = query.trim()
          ? await window.electronAPI.meetings.search(query.trim())
          : await window.electronAPI.meetings.list();
        if (!cancelled) {
          setItems(next.filter((item) => item.status === 'ready' && !excludeIds.includes(item.id)));
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
  }, [open, query, excludeIds.join('|')]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-border-muted bg-background shadow-soft">
        <div className="flex items-center justify-between border-b border-border-muted px-4 py-3">
          <div>
            <h3 className="text-sm font-semibold text-text-primary">{t('meetings.pickerTitle')}</h3>
            <p className="mt-0.5 text-xs text-text-muted">{t('meetings.pickerDesc')}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-text-muted hover:bg-surface-hover"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="border-b border-border-muted px-4 py-3">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('meetings.searchPlaceholder')}
            className="w-full rounded-md border border-border-muted bg-background px-3 py-2 text-sm text-text-primary"
          />
        </div>
        <div className="flex-1 space-y-1 overflow-y-auto p-3">
          {busy && <p className="px-2 text-sm text-text-muted">{t('common.loading')}</p>}
          {error && <p className="px-2 text-sm text-red-500">{error}</p>}
          {!busy && !error && items.length === 0 && (
            <p className="px-2 text-sm text-text-muted">{t('meetings.noMeetings')}</p>
          )}
          {items.map((item) => (
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
              className="flex w-full items-start gap-2 rounded-lg border border-transparent px-3 py-2 text-left hover:border-border-muted hover:bg-surface-hover"
            >
              <Mic className="mt-0.5 h-4 w-4 flex-shrink-0 text-accent" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-text-primary">{item.title}</p>
                <p className="mt-0.5 text-[11px] text-text-muted">
                  {new Date(item.startedAt).toLocaleString()}
                </p>
                {item.summary && (
                  <p className="mt-1 line-clamp-2 text-xs text-text-secondary">{item.summary}</p>
                )}
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
