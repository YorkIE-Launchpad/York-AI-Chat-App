import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ImageIcon, MessageSquare } from 'lucide-react';
import { useAppStore } from '../store';
import { hasGptImage25Access } from '../../shared/image-generation';
import { useIPC } from '../hooks/useIPC';
import {
  BACKEND_MODELS_CATALOG_REFRESH_EVENT,
  refreshBackendModelsCatalog,
} from '../utils/backend-models-catalog';

export function ComposerModeDropdown({ disabled }: { disabled?: boolean }) {
  const { t } = useTranslation();
  const { isElectron } = useIPC();
  const composerMode = useAppStore((state) => state.composerMode);
  const setComposerMode = useAppStore((state) => state.setComposerMode);
  const models = useAppStore((state) => state.backendModelsCatalog);
  const imageAccess = hasGptImage25Access(models);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isElectron) return;
    void refreshBackendModelsCatalog({ usable: true, forceRefresh: true });
  }, [isElectron]);

  useEffect(() => {
    if (!isElectron) return;
    const handleRefresh = () => {
      void refreshBackendModelsCatalog({ usable: true, forceRefresh: true });
    };
    window.addEventListener(BACKEND_MODELS_CATALOG_REFRESH_EVENT, handleRefresh);
    return () => window.removeEventListener(BACKEND_MODELS_CATALOG_REFRESH_EVENT, handleRefresh);
  }, [isElectron]);

  useEffect(() => {
    if (!imageAccess && composerMode === 'image') {
      setComposerMode('chat');
    }
  }, [composerMode, imageAccess, setComposerMode]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  if (!imageAccess) {
    return null;
  }

  const label =
    composerMode === 'image' ? t('composer.modeImage') : t('composer.modeChat');

  return (
    <div ref={rootRef} className="composer-mode-dropdown relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
        className="flex h-8 max-w-[7.5rem] shrink-0 items-center gap-1 rounded-xl px-2 text-[12px] font-medium text-text-muted transition-colors hover:bg-surface-hover hover:text-text-primary disabled:opacity-50"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={label}
        title={t('composer.modeMenu')}
      >
        {composerMode === 'image' ? (
          <ImageIcon className="h-3.5 w-3.5 shrink-0" />
        ) : (
          <MessageSquare className="h-3.5 w-3.5 shrink-0" />
        )}
        <span className="composer-mode-label truncate">{label}</span>
        <ChevronDown className="composer-compact-chevron h-3.5 w-3.5 shrink-0 opacity-70" />
      </button>
      {open && (
        <div
          role="listbox"
          className="absolute bottom-[calc(100%+8px)] left-0 z-30 min-w-[9rem] overflow-hidden rounded-[1.25rem] border border-border-subtle bg-surface p-1.5 shadow-elevated"
          style={{ backgroundColor: 'var(--color-surface)' }}
        >
          <button
            type="button"
            role="option"
            aria-selected={composerMode === 'chat'}
            onClick={() => {
              setComposerMode('chat');
              setOpen(false);
            }}
            className={`flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-[13px] transition-colors hover:bg-surface-hover ${
              composerMode === 'chat' ? 'text-text-primary font-medium' : 'text-text-muted'
            }`}
          >
            <MessageSquare className="h-4 w-4" />
            {t('composer.modeChat')}
          </button>
          <button
            type="button"
            role="option"
            aria-selected={composerMode === 'image'}
            onClick={() => {
              setComposerMode('image');
              setOpen(false);
            }}
            className={`flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-[13px] transition-colors hover:bg-surface-hover ${
              composerMode === 'image' ? 'text-text-primary font-medium' : 'text-text-muted'
            }`}
          >
            <ImageIcon className="h-4 w-4" />
            {t('composer.modeImage')}
          </button>
        </div>
      )}
    </div>
  );
}
