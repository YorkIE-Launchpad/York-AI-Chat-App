import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { FileText, Hash, Loader2, MessageSquare, Search, X, BookOpen } from 'lucide-react';
import type {
  ExternalReferenceSearchItem,
  ExternalReferenceSource,
} from '../../shared/external-reference';

interface ConnectorReferencePickerProps {
  open: boolean;
  source: ExternalReferenceSource | null;
  onClose: () => void;
  onSelect: (item: ExternalReferenceSearchItem) => void;
  excludeIds?: string[];
}

const SOURCE_META: Record<
  ExternalReferenceSource,
  { icon: typeof FileText; titleKey: string; descKey: string; placeholderKey: string }
> = {
  drive: {
    icon: FileText,
    titleKey: 'references.driveTitle',
    descKey: 'references.driveDesc',
    placeholderKey: 'references.drivePlaceholder',
  },
  slack: {
    icon: MessageSquare,
    titleKey: 'references.slackTitle',
    descKey: 'references.slackDesc',
    placeholderKey: 'references.slackPlaceholder',
  },
  jira: {
    icon: Hash,
    titleKey: 'references.jiraTitle',
    descKey: 'references.jiraDesc',
    placeholderKey: 'references.jiraPlaceholder',
  },
  confluence: {
    icon: BookOpen,
    titleKey: 'references.confluenceTitle',
    descKey: 'references.confluenceDesc',
    placeholderKey: 'references.confluencePlaceholder',
  },
};

export function ConnectorReferencePicker({
  open,
  source,
  onClose,
  onSelect,
  excludeIds = [],
}: ConnectorReferencePickerProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<ExternalReferenceSearchItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const excludeKey = excludeIds.join('|');

  useEffect(() => {
    if (!open || !source) {
      setQuery('');
      setError(null);
      setItems([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        setBusy(true);
        setError(null);
        try {
          const result = await window.electronAPI.references.search({
            source,
            query: query.trim(),
          });
          if (cancelled) return;
          const excluded = new Set(excludeKey ? excludeKey.split('|') : []);
          setItems(result.items.filter((item) => !excluded.has(item.externalId)));
          setError(result.error || null);
        } catch (err) {
          if (!cancelled) {
            setError(err instanceof Error ? err.message : String(err));
            setItems([]);
          }
        } finally {
          if (!cancelled) setBusy(false);
        }
      })();
    }, 220);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [excludeKey, open, query, source]);

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

  if (!open || !source) return null;

  const meta = SOURCE_META[source];
  const Icon = meta.icon;

  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/20 p-4 backdrop-blur-sm animate-fade-in"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="reference-picker-title"
        className="card m-4 flex max-h-[80vh] w-full max-w-md flex-col overflow-hidden shadow-elevated animate-slide-up"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start gap-4 border-b border-border-subtle px-5 py-4">
          <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-xl bg-accent-muted">
            <Icon className="h-6 w-6 text-accent" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="reference-picker-title" className="text-lg font-semibold text-text-primary">
              {t(meta.titleKey)}
            </h2>
            <p className="mt-1 text-sm text-text-secondary">{t(meta.descKey)}</p>
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
              placeholder={t(meta.placeholderKey)}
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
              {query.trim() ? t('references.noResults') : t('references.typeToSearch')}
            </p>
          )}
          {!busy &&
            !error &&
            items.map((item) => (
              <button
                key={item.externalId}
                type="button"
                onClick={() => {
                  onSelect(item);
                  onClose();
                }}
                className="flex w-full flex-col gap-0.5 rounded-xl px-3 py-2.5 text-left text-text-primary transition-colors hover:bg-surface-hover"
              >
                <span className="truncate text-sm font-medium">{item.title}</span>
                {item.subtitle && (
                  <span className="truncate text-[12px] text-text-muted">{item.subtitle}</span>
                )}
              </button>
            ))}
        </div>
      </div>
    </div>,
    document.body
  );
}
