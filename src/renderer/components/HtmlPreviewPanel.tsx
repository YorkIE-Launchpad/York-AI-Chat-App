import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  X,
  RefreshCw,
  FolderOpen,
  ExternalLink,
  Loader2,
  AlertTriangle,
  FileCode2,
} from 'lucide-react';
import { useAppStore } from '../store';
import { getArtifactLabel } from '../utils/artifact-steps';

const MIN_PREVIEW_WIDTH = 280;
const MAX_PREVIEW_WIDTH_RATIO = 0.75;
const DEFAULT_PREVIEW_WIDTH = 520;
const PREVIEW_WIDTH_STORAGE_KEY = 'yorkie.htmlPreviewWidth';

function clampPreviewWidth(width: number, viewportWidth = window.innerWidth): number {
  const maxWidth = Math.max(MIN_PREVIEW_WIDTH, Math.floor(viewportWidth * MAX_PREVIEW_WIDTH_RATIO));
  return Math.min(maxWidth, Math.max(MIN_PREVIEW_WIDTH, Math.round(width)));
}

function readStoredPreviewWidth(): number {
  if (typeof window === 'undefined') {
    return DEFAULT_PREVIEW_WIDTH;
  }
  try {
    const raw = window.localStorage.getItem(PREVIEW_WIDTH_STORAGE_KEY);
    const parsed = raw ? Number(raw) : NaN;
    if (Number.isFinite(parsed)) {
      return clampPreviewWidth(parsed);
    }
  } catch {
    // ignore storage failures
  }
  return clampPreviewWidth(Math.min(window.innerWidth * 0.5, 720));
}

export function HtmlPreviewPanel() {
  const { t } = useTranslation();
  const activeHtmlPreview = useAppStore((s) => s.activeHtmlPreview);
  const closeHtmlPreview = useAppStore((s) => s.closeHtmlPreview);
  const openHtmlPreview = useAppStore((s) => s.openHtmlPreview);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const sessions = useAppStore((s) => s.sessions);
  const workingDir = useAppStore((s) => s.workingDir);
  const setGlobalNotice = useAppStore((s) => s.setGlobalNotice);

  const [html, setHtml] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [panelWidth, setPanelWidth] = useState(readStoredPreviewWidth);
  const [isResizing, setIsResizing] = useState(false);
  const dragStateRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const activeSession = activeSessionId ? sessions.find((s) => s.id === activeSessionId) : null;
  const cwd = activeSession?.cwd || workingDir;

  const title = useMemo(() => {
    if (!activeHtmlPreview) {
      return t('context.htmlPreviewTitle');
    }
    return (
      activeHtmlPreview.title ||
      getArtifactLabel(activeHtmlPreview.path) ||
      t('context.htmlPreviewTitle')
    );
  }, [activeHtmlPreview, t]);

  const loadPreview = useCallback(async () => {
    if (!activeHtmlPreview?.path) {
      setHtml(null);
      setError(null);
      return;
    }
    if (typeof window === 'undefined' || !window.electronAPI?.artifacts?.readTextFile) {
      setError(t('context.htmlPreviewFailed'));
      setHtml(null);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const result = await window.electronAPI.artifacts.readTextFile(
        activeHtmlPreview.path,
        cwd ?? undefined
      );
      if (!result.success || typeof result.content !== 'string') {
        setHtml(null);
        setError(result.error || t('context.htmlPreviewFailed'));
        return;
      }
      setHtml(result.content);
    } catch (err) {
      console.error('[HtmlPreviewPanel] load failed:', err);
      setHtml(null);
      setError(t('context.htmlPreviewFailed'));
    } finally {
      setLoading(false);
    }
  }, [activeHtmlPreview?.path, activeHtmlPreview?.revision, cwd, t]);

  useEffect(() => {
    void loadPreview();
  }, [loadPreview]);

  useEffect(() => {
    const onWindowResize = () => {
      setPanelWidth((prev) => clampPreviewWidth(prev));
    };
    window.addEventListener('resize', onWindowResize);
    return () => window.removeEventListener('resize', onWindowResize);
  }, []);

  useEffect(() => {
    if (!isResizing) {
      return;
    }

    const onPointerMove = (event: PointerEvent) => {
      const drag = dragStateRef.current;
      if (!drag) {
        return;
      }
      // Dragging the left edge: moving left grows the panel.
      const nextWidth = clampPreviewWidth(drag.startWidth + (drag.startX - event.clientX));
      setPanelWidth(nextWidth);
    };

    const endResize = () => {
      dragStateRef.current = null;
      setIsResizing(false);
      setPanelWidth((prev) => {
        const clamped = clampPreviewWidth(prev);
        try {
          window.localStorage.setItem(PREVIEW_WIDTH_STORAGE_KEY, String(clamped));
        } catch {
          // ignore storage failures
        }
        return clamped;
      });
    };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', endResize);
    window.addEventListener('pointercancel', endResize);

    return () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', endResize);
      window.removeEventListener('pointercancel', endResize);
    };
  }, [isResizing]);

  const handleResizePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragStateRef.current = {
      startX: event.clientX,
      startWidth: panelWidth,
    };
    setIsResizing(true);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const handleRefresh = () => {
    if (!activeHtmlPreview) {
      return;
    }
    openHtmlPreview(activeHtmlPreview.path, activeHtmlPreview.title);
  };

  const handleReveal = async () => {
    if (!activeHtmlPreview?.path || !window.electronAPI?.showItemInFolder) {
      return;
    }
    const revealed = await window.electronAPI.showItemInFolder(
      activeHtmlPreview.path,
      cwd ?? undefined
    );
    if (!revealed) {
      setGlobalNotice({
        id: `html-preview-reveal-failed-${Date.now()}`,
        type: 'warning',
        message: t('context.revealFailed'),
      });
    }
  };

  const handleOpenExternal = async () => {
    if (!activeHtmlPreview?.path) {
      return;
    }
    if (!window.electronAPI?.openPath) {
      await handleReveal();
      return;
    }
    const result = await window.electronAPI.openPath(activeHtmlPreview.path, cwd ?? undefined);
    if (!result.success) {
      setGlobalNotice({
        id: `html-preview-open-failed-${Date.now()}`,
        type: 'warning',
        message: result.error || t('context.htmlPreviewOpenFailed'),
      });
    }
  };

  if (!activeHtmlPreview) {
    return null;
  }

  return (
    <div
      className="relative flex shrink-0 border-l border-border-muted bg-background flex-col overflow-hidden min-h-0"
      style={{ width: panelWidth }}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t('context.htmlPreviewResize')}
        aria-valuemin={MIN_PREVIEW_WIDTH}
        aria-valuemax={Math.floor(window.innerWidth * MAX_PREVIEW_WIDTH_RATIO)}
        aria-valuenow={panelWidth}
        tabIndex={0}
        onPointerDown={handleResizePointerDown}
        onKeyDown={(event: ReactKeyboardEvent<HTMLDivElement>) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
            return;
          }
          event.preventDefault();
          const delta = event.key === 'ArrowLeft' ? 24 : -24;
          setPanelWidth((prev) => {
            const next = clampPreviewWidth(prev + delta);
            try {
              window.localStorage.setItem(PREVIEW_WIDTH_STORAGE_KEY, String(next));
            } catch {
              // ignore
            }
            return next;
          });
        }}
        className={`absolute left-0 top-0 bottom-0 z-20 w-1.5 -ml-0.5 cursor-col-resize touch-none group ${
          isResizing ? 'bg-accent-primary/40' : 'bg-transparent hover:bg-accent-primary/30'
        }`}
      >
        <div
          className={`absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors ${
            isResizing ? 'bg-accent-primary' : 'bg-transparent group-hover:bg-border-muted'
          }`}
        />
      </div>

      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-border-muted shrink-0">
        <FileCode2 className="w-4 h-4 text-text-muted shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-text-primary truncate" title={title}>
            {title}
          </p>
          <p className="text-[10px] text-text-muted truncate" title={activeHtmlPreview.path}>
            {activeHtmlPreview.path}
          </p>
        </div>
        <button
          type="button"
          onClick={handleRefresh}
          className="w-7 h-7 rounded-md flex items-center justify-center hover:bg-surface-hover text-text-muted hover:text-text-primary transition-colors"
          title={t('context.htmlPreviewRefresh')}
          aria-label={t('context.htmlPreviewRefresh')}
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
        <button
          type="button"
          onClick={() => void handleReveal()}
          className="w-7 h-7 rounded-md flex items-center justify-center hover:bg-surface-hover text-text-muted hover:text-text-primary transition-colors"
          title={t('context.htmlPreviewReveal')}
          aria-label={t('context.htmlPreviewReveal')}
        >
          <FolderOpen className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          onClick={() => void handleOpenExternal()}
          className="w-7 h-7 rounded-md flex items-center justify-center hover:bg-surface-hover text-text-muted hover:text-text-primary transition-colors"
          title={t('context.htmlPreviewOpenExternal')}
          aria-label={t('context.htmlPreviewOpenExternal')}
        >
          <ExternalLink className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          onClick={closeHtmlPreview}
          className="w-7 h-7 rounded-md flex items-center justify-center hover:bg-surface-hover text-text-muted hover:text-text-primary transition-colors"
          title={t('context.htmlPreviewClose')}
          aria-label={t('context.htmlPreviewClose')}
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="flex-1 min-h-0 relative bg-white">
        {loading && !html && (
          <div className="absolute inset-0 flex items-center justify-center gap-2 text-xs text-text-muted bg-background">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span>{t('context.htmlPreviewLoading')}</span>
          </div>
        )}
        {error && !loading && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center bg-background">
            <AlertTriangle className="w-5 h-5 text-warning" />
            <p className="text-xs text-text-secondary">{error}</p>
            <button
              type="button"
              onClick={handleRefresh}
              className="text-xs text-accent-primary hover:underline"
            >
              {t('context.htmlPreviewRefresh')}
            </button>
          </div>
        )}
        {!error && html !== null && (
          <iframe
            key={`${activeHtmlPreview.path}:${activeHtmlPreview.revision}`}
            title={title}
            srcDoc={html}
            sandbox="allow-scripts"
            className={`w-full h-full border-0 bg-white ${isResizing ? 'pointer-events-none' : ''}`}
          />
        )}
        {!loading && !error && html === null && (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-text-muted bg-background">
            {t('context.htmlPreviewEmpty')}
          </div>
        )}
      </div>
    </div>
  );
}
