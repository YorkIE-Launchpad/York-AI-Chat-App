import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import type { MemoryInspectSessionResult, MemoryReadResult } from '../../types';

interface MemorySourceDetailPanelProps {
  memoryId: string;
  onClose: () => void;
}

export function MemorySourceDetailPanel({ memoryId, onClose }: MemorySourceDetailPanelProps) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<MemoryReadResult | null>(null);
  const [inspectedSession, setInspectedSession] = useState<MemoryInspectSessionResult | null>(
    null
  );
  const [inspecting, setInspecting] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setDetail(null);
    setInspectedSession(null);

    void (async () => {
      try {
        if (typeof window === 'undefined' || !window.electronAPI?.memory?.read) {
          if (!cancelled) {
            setError(t('memory.sourceUnavailable', 'Memory source is unavailable.'));
            setLoading(false);
          }
          return;
        }
        const result = await window.electronAPI.memory.read(memoryId);
        if (cancelled) return;
        if (!result) {
          setError(t('memory.itemNotFound', 'Memory item not found.'));
          setLoading(false);
          return;
        }
        setDetail(result);
        setLoading(false);
      } catch (err) {
        if (cancelled) return;
        setError(
          err instanceof Error && err.message
            ? err.message
            : t('memory.itemNotFound', 'Memory item not found.')
        );
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [memoryId, t]);

  const handleInspectSession = async () => {
    if (!detail?.sessionId || typeof window === 'undefined') return;
    setInspecting(true);
    try {
      const workspaceKey = detail.sourceWorkspace || detail.workspaceKey;
      const inspected = await window.electronAPI.memory.inspectSession(
        detail.sessionId,
        workspaceKey
      );
      setInspectedSession(inspected);
      if (!inspected) {
        setError(t('memory.inspectFailed', 'Could not inspect session memory.'));
      }
    } catch (err) {
      setError(
        err instanceof Error && err.message
          ? err.message
          : t('memory.inspectFailed', 'Could not inspect session memory.')
      );
    } finally {
      setInspecting(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/20 p-4 backdrop-blur-sm animate-fade-in"
      role="presentation"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="memory-source-detail-title"
        className="card flex max-h-[min(80vh,640px)] w-full max-w-lg flex-col p-6 shadow-elevated animate-slide-up"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-xs uppercase tracking-wide text-text-muted">
              {t('messageCard.sources')}
            </p>
            <h2
              id="memory-source-detail-title"
              className="mt-1 text-lg font-semibold text-text-primary truncate"
            >
              {detail?.title || t('memory.detailTitle', 'Memory detail')}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-text-muted hover:bg-surface-hover hover:text-text-primary"
            title={t('common.close', 'Close')}
            aria-label={t('common.close', 'Close')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-4 min-h-0 flex-1 overflow-y-auto space-y-3">
          {loading && (
            <p className="text-sm text-text-muted">{t('common.loading', 'Loading…')}</p>
          )}
          {error && !loading && <p className="text-sm text-error">{error}</p>}
          {detail && !loading && (
            <>
              <div>
                <p className="text-xs uppercase tracking-wide text-text-muted">{detail.kind}</p>
                <p className="mt-1 text-sm text-text-secondary whitespace-pre-wrap">
                  {detail.summary}
                </p>
              </div>
              {detail.sourceFile && (
                <p className="text-xs text-text-muted">
                  {t('memory.sourceFile', 'Source file')}: {detail.sourceFile}
                </p>
              )}
              {detail.sessionId && (
                <button
                  type="button"
                  onClick={() => {
                    void handleInspectSession();
                  }}
                  disabled={inspecting}
                  className="rounded-lg border border-border bg-background px-3 py-2 text-xs font-medium text-text-primary disabled:opacity-60"
                >
                  {t('memory.inspectSession', 'View full memory for this session')}
                </button>
              )}
              {detail.details && (
                <pre className="max-h-56 overflow-auto rounded-lg bg-background-secondary/80 p-3 text-xs leading-5 text-text-secondary whitespace-pre-wrap">
                  {detail.details}
                </pre>
              )}
              {detail.rawText && (
                <pre className="max-h-64 overflow-auto rounded-lg bg-background-secondary/80 p-3 text-xs leading-5 text-text-secondary whitespace-pre-wrap">
                  {detail.rawText}
                </pre>
              )}
              {detail.sourceExcerpt && (
                <div className="rounded-lg border border-border-muted bg-background-secondary/60 p-3 text-xs text-text-secondary whitespace-pre-wrap">
                  {detail.sourceExcerpt}
                </div>
              )}
              {inspectedSession && (
                <div className="space-y-2 rounded-lg border border-border-muted bg-background-secondary/60 p-3">
                  <p className="text-xs text-text-muted">
                    {inspectedSession.sourceWorkspace ||
                      t('memory.noWorkspace', 'No workspace')}
                  </p>
                  <p className="text-sm font-medium text-text-primary">
                    {inspectedSession.session.summary}
                  </p>
                  {inspectedSession.chunks.length > 0 && (
                    <div className="space-y-2">
                      {inspectedSession.chunks.map((chunk) => (
                        <div
                          key={chunk.id}
                          className="rounded-lg border border-border-muted bg-background/80 p-3"
                        >
                          <p className="text-sm font-medium text-text-primary">{chunk.summary}</p>
                          <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap text-xs leading-5 text-text-secondary">
                            {chunk.rawText}
                          </pre>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
