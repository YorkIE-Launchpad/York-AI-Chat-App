import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertCircle,
  ArrowUpRight,
  BookOpen,
  FileText,
  HardDrive,
  Loader2,
  RefreshCw,
  Trash2,
  Upload,
} from 'lucide-react';
import type { KnowledgeScopeRef, KnowledgeSource } from '../../../shared/knowledge-base';
import type { ExternalReferenceSource } from '../../../shared/external-reference';
import { ConnectorReferencePicker } from '../ConnectorReferencePicker';
import { useAppStore } from '../../store';

/** Loads chat + folder sources and stays in sync with main-process changes. */
export function useKnowledgeSources(scopes: KnowledgeScopeRef[]) {
  const [sources, setSources] = useState<KnowledgeSource[]>([]);
  const scopeKey = scopes.map((s) => `${s.scope}:${s.scopeId}`).join('|');

  const reload = useCallback(async () => {
    const api = window.electronAPI?.knowledge;
    if (!api || scopes.length === 0) {
      setSources([]);
      return;
    }
    try {
      setSources(await api.list(scopes));
    } catch (error) {
      console.error('Failed to load knowledge sources:', error);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey]);

  useEffect(() => {
    void reload();
    const unsubscribe = window.electronAPI?.knowledge?.onChanged((event) => {
      if (scopeKey.split('|').includes(`${event.scope}:${event.scopeId}`)) void reload();
    });
    return () => unsubscribe?.();
  }, [reload, scopeKey]);

  return { sources, reload };
}

interface KnowledgeSourcesSectionProps {
  scopes: KnowledgeScopeRef[];
  sources: KnowledgeSource[];
  folderName?: string | null;
  incognito?: boolean;
}

export function KnowledgeSourcesSection({
  scopes,
  sources,
  folderName,
  incognito,
}: KnowledgeSourcesSectionProps) {
  const { t } = useTranslation();

  if (incognito) {
    return (
      <p className="px-1.5 text-xs leading-5 text-text-muted">{t('knowledge.disabledIncognito')}</p>
    );
  }

  return (
    <div className="space-y-4">
      {scopes.map((ref) => (
        <KnowledgeScopeGroup
          key={`${ref.scope}:${ref.scopeId}`}
          scopeRef={ref}
          sources={sources.filter((s) => s.scope === ref.scope && s.scopeId === ref.scopeId)}
          title={
            ref.scope === 'folder'
              ? t('knowledge.folderSources', { name: folderName || '' })
              : t('knowledge.chatSources')
          }
          hint={ref.scope === 'folder' ? t('knowledge.folderHint') : t('knowledge.chatHint')}
        />
      ))}
    </div>
  );
}

function KnowledgeScopeGroup({
  scopeRef,
  sources,
  title,
  hint,
}: {
  scopeRef: KnowledgeScopeRef;
  sources: KnowledgeSource[];
  title: string;
  hint: string;
}) {
  const { t } = useTranslation();
  const setGlobalNotice = useAppStore((s) => s.setGlobalNotice);
  const [picker, setPicker] = useState<ExternalReferenceSource | null>(null);
  const [uploading, setUploading] = useState(false);
  const [connectors, setConnectors] = useState<{ drive: boolean; confluence: boolean }>({
    drive: false,
    confluence: false,
  });

  useEffect(() => {
    void window.electronAPI?.references
      ?.getStatus()
      .then((status) => setConnectors({ drive: status.drive, confluence: status.confluence }))
      .catch(() => undefined);
  }, []);

  const notifyError = (error: unknown) =>
    setGlobalNotice({
      id: `knowledge-add-failed-${Date.now()}`,
      type: 'error',
      message: `${t('knowledge.addFailed')}: ${error instanceof Error ? error.message : String(error)}`,
    });

  const uploadFiles = async () => {
    try {
      const picked = await window.electronAPI.selectFiles();
      const paths = picked.map((file) => file.path).filter(Boolean);
      if (paths.length === 0) return;
      setUploading(true);
      await window.electronAPI.knowledge.addFiles({ ...scopeRef, paths });
    } catch (error) {
      notifyError(error);
    } finally {
      setUploading(false);
    }
  };

  const excludeIds = useMemo(
    () => sources.map((s) => s.meta?.externalId).filter((id): id is string => Boolean(id)),
    [sources]
  );

  return (
    <section>
      <div className="mb-1 flex items-center justify-between gap-2 px-1.5">
        <p className="truncate text-[11.5px] font-medium text-text-muted" title={hint}>
          {title}
        </p>
        {sources.length > 0 && (
          <span className="text-[11px] text-text-muted">{sources.length}</span>
        )}
      </div>

      {sources.length === 0 ? (
        <p className="px-1.5 pb-1 text-xs leading-5 text-text-muted">{hint}</p>
      ) : (
        <ul className="space-y-0.5">
          {sources.map((source) => (
            <li key={source.id}>
              <KnowledgeSourceRow source={source} />
            </li>
          ))}
        </ul>
      )}

      <div className="mt-1.5 flex flex-wrap gap-1 px-0.5">
        <AddButton
          icon={
            uploading ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Upload className="h-3 w-3" />
            )
          }
          label={t('knowledge.addFiles')}
          onClick={() => void uploadFiles()}
          disabled={uploading}
        />
        {connectors.drive && (
          <AddButton
            icon={<HardDrive className="h-3 w-3" />}
            label={t('knowledge.addDrive')}
            onClick={() => setPicker('drive')}
          />
        )}
        {connectors.confluence && (
          <AddButton
            icon={<BookOpen className="h-3 w-3" />}
            label={t('knowledge.addConfluence')}
            onClick={() => setPicker('confluence')}
          />
        )}
      </div>

      <ConnectorReferencePicker
        open={picker !== null}
        source={picker}
        excludeIds={excludeIds}
        onClose={() => setPicker(null)}
        onSelect={(item) => {
          void window.electronAPI.knowledge
            .addReference({
              ...scopeRef,
              source: item.source,
              externalId: item.externalId,
              title: item.title,
              url: item.url,
              meta: item.meta,
            })
            .catch(notifyError);
        }}
      />
    </section>
  );
}

function AddButton({
  icon,
  label,
  onClick,
  disabled,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center gap-1 rounded-md border border-border-muted px-2 py-1 text-[11.5px] text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary disabled:opacity-50"
    >
      {icon}
      {label}
    </button>
  );
}

function sourceIcon(kind: KnowledgeSource['kind']) {
  if (kind === 'drive') return HardDrive;
  if (kind === 'confluence') return BookOpen;
  return FileText;
}

function KnowledgeSourceRow({ source }: { source: KnowledgeSource }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const Icon = sourceIcon(source.kind);
  const indexing = source.status === 'indexing' || busy;

  const status = indexing
    ? t('knowledge.indexing')
    : source.status === 'error'
      ? `${t('knowledge.failed')}${source.error ? ` — ${source.error}` : ''}`
      : t('knowledge.words', { count: Math.max(1, Math.round(source.charCount / 6)) });

  const refresh = async () => {
    setBusy(true);
    try {
      await window.electronAPI.knowledge.refresh(source.id);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="group flex items-start gap-2 rounded-lg px-1.5 py-1.5 text-[13px] text-text-primary hover:bg-surface-hover">
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-text-muted" />
      <span className="min-w-0 flex-1">
        <span className="block truncate" title={source.title}>
          {source.title}
        </span>
        <span
          className={`flex items-center gap-1 truncate text-[11px] ${
            source.status === 'error' && !indexing ? 'text-error' : 'text-text-muted'
          }`}
          title={status}
        >
          {indexing && <Loader2 className="h-2.5 w-2.5 shrink-0 animate-spin" />}
          {source.status === 'error' && !indexing && (
            <AlertCircle className="h-2.5 w-2.5 shrink-0" />
          )}
          <span className="truncate">{status}</span>
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        {source.url && (
          <RowAction
            label={t('knowledge.open')}
            onClick={() => void window.electronAPI?.openExternal?.(source.url!)}
          >
            <ArrowUpRight className="h-3 w-3" />
          </RowAction>
        )}
        <RowAction
          label={t('knowledge.refresh')}
          onClick={() => void refresh()}
          disabled={indexing}
        >
          <RefreshCw className="h-3 w-3" />
        </RowAction>
        <RowAction
          label={t('knowledge.remove')}
          onClick={() => void window.electronAPI.knowledge.remove(source.id)}
        >
          <Trash2 className="h-3 w-3" />
        </RowAction>
      </span>
    </div>
  );
}

function RowAction({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className="rounded p-1 text-text-muted transition-colors hover:bg-surface-active hover:text-text-primary disabled:opacity-40"
    >
      {children}
    </button>
  );
}
