import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { FileText, Layers } from 'lucide-react';
import { useAppStore } from '../store';
import { useIPC } from '../hooks/useIPC';
import type { SharedDocWithAccess } from '../../shared/shared-docs/types';

/** Join / list shared documents — shown in the right context panel. */
export function SharedDocsPanelControls() {
  const { t } = useTranslation();
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const sessions = useAppStore((s) => s.sessions);
  const workingDir = useAppStore((s) => s.workingDir);
  const setGlobalNotice = useAppStore((s) => s.setGlobalNotice);
  const { joinSharedDoc, listSharedDocs, openSharedDoc, isElectron } = useIPC();

  const [joinDocModalOpen, setJoinDocModalOpen] = useState(false);
  const [joinDocDraft, setJoinDocDraft] = useState('');
  const [joiningDoc, setJoiningDoc] = useState(false);
  const [sharedDocsModalOpen, setSharedDocsModalOpen] = useState(false);
  const [sharedDocsList, setSharedDocsList] = useState<SharedDocWithAccess[]>([]);
  const [loadingSharedDocs, setLoadingSharedDocs] = useState(false);
  const joinDocInputRef = useRef<HTMLInputElement>(null);

  const handleJoinSharedDoc = () => {
    if (!isElectron || !activeSessionId) return;
    setJoinDocDraft('');
    setJoinDocModalOpen(true);
    requestAnimationFrame(() => joinDocInputRef.current?.focus());
  };

  const handleOpenSharedDocsList = () => {
    if (!isElectron || !activeSessionId) return;
    setSharedDocsModalOpen(true);
    setLoadingSharedDocs(true);
    void listSharedDocs(activeSessionId)
      .then((result) => {
        if (result.success && result.docs) {
          setSharedDocsList(result.docs);
        } else {
          setSharedDocsList([]);
        }
      })
      .finally(() => setLoadingSharedDocs(false));
  };

  useEffect(() => {
    if (!activeSessionId) {
      if (sharedDocsModalOpen) {
        setSharedDocsModalOpen(false);
      }
      setSharedDocsList([]);
      return;
    }
    if (!sharedDocsModalOpen) {
      return;
    }
    setLoadingSharedDocs(true);
    void listSharedDocs(activeSessionId)
      .then((result) => {
        if (result.success && result.docs) {
          setSharedDocsList(result.docs);
        } else {
          setSharedDocsList([]);
        }
      })
      .finally(() => setLoadingSharedDocs(false));
  }, [activeSessionId, sharedDocsModalOpen, listSharedDocs]);

  const handleSubmitJoinSharedDoc = async () => {
    const token = joinDocDraft.trim();
    if (!token || joiningDoc || !activeSessionId) return;
    const session = sessions.find((s) => s.id === activeSessionId);
    const cwd = session?.cwd || workingDir;
    if (!cwd) {
      setGlobalNotice({
        id: `join-doc-${Date.now()}`,
        type: 'error',
        message: 'Select a workspace folder before opening a shared document.',
      });
      return;
    }
    setJoiningDoc(true);
    try {
      const result = await joinSharedDoc(token, activeSessionId, cwd);
      if (result.success) {
        setJoinDocModalOpen(false);
        setJoinDocDraft('');
        setGlobalNotice({
          id: `join-doc-ok-${Date.now()}`,
          type: 'success',
          message: '',
          messageKey: 'sidebar.joinSharedDocSuccess',
        });
      } else {
        setGlobalNotice({
          id: `join-doc-fail-${Date.now()}`,
          type: 'error',
          message: result.error || t('sidebar.joinSharedDocFailed'),
        });
      }
    } catch (error) {
      setGlobalNotice({
        id: `join-doc-fail-${Date.now()}`,
        type: 'error',
        message: error instanceof Error ? error.message : t('sidebar.joinSharedDocFailed'),
      });
    } finally {
      setJoiningDoc(false);
    }
  };

  const joinSharedDocModal =
    joinDocModalOpen && typeof document !== 'undefined'
      ? createPortal(
          <div
            className="fixed inset-0 z-[90] flex items-center justify-center bg-black/20 p-4 backdrop-blur-sm animate-fade-in"
            onClick={() => !joiningDoc && setJoinDocModalOpen(false)}
          >
            <div
              role="dialog"
              aria-modal="true"
              className="w-full max-w-md rounded-2xl border border-border-subtle bg-background p-4 shadow-xl"
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className="text-sm font-medium text-text-primary">{t('sidebar.joinSharedDoc')}</h3>
              <p className="mt-1 text-xs text-text-muted">{t('sidebar.joinSharedDocPrompt')}</p>
              <input
                ref={joinDocInputRef}
                type="text"
                value={joinDocDraft}
                onChange={(e) => setJoinDocDraft(e.target.value)}
                disabled={joiningDoc}
                className="mt-3 w-full rounded-xl border border-border-subtle bg-surface px-3 py-2 text-sm"
              />
              <div className="mt-3 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setJoinDocModalOpen(false)}
                  disabled={joiningDoc}
                  className="rounded-xl px-3 py-1.5 text-sm text-text-secondary hover:bg-surface-hover"
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="button"
                  onClick={() => void handleSubmitJoinSharedDoc()}
                  disabled={joiningDoc || !joinDocDraft.trim()}
                  className="rounded-xl bg-accent px-3 py-1.5 text-sm font-medium text-white"
                >
                  {t('sidebar.joinSharedDoc')}
                </button>
              </div>
            </div>
          </div>,
          document.body
        )
      : null;

  const sharedDocsModal =
    sharedDocsModalOpen && typeof document !== 'undefined'
      ? createPortal(
          <div
            className="fixed inset-0 z-[90] flex items-center justify-center bg-black/20 p-4 backdrop-blur-sm"
            onClick={() => setSharedDocsModalOpen(false)}
          >
            <div
              role="dialog"
              aria-modal="true"
              className="w-full max-w-lg rounded-2xl border border-border-subtle bg-background p-4 shadow-xl max-h-[70vh] overflow-hidden flex flex-col"
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className="text-sm font-medium text-text-primary">{t('sidebar.sharedDocsList')}</h3>
              <div className="mt-3 flex-1 overflow-y-auto space-y-2">
                {loadingSharedDocs && (
                  <p className="text-xs text-text-muted">
                    {t('common.loading', { defaultValue: 'Loading…' })}
                  </p>
                )}
                {!loadingSharedDocs && sharedDocsList.length === 0 && (
                  <p className="text-xs text-text-muted">{t('sidebar.sharedDocsEmpty')}</p>
                )}
                {sharedDocsList.map((doc) => (
                  <div
                    key={doc.id}
                    className="flex items-center justify-between gap-2 rounded-lg border border-border-subtle px-3 py-2"
                  >
                    <div className="min-w-0">
                      <p className="text-sm truncate">{doc.title}</p>
                      <p className="text-[10px] text-text-muted">
                        {doc.permission}
                        {doc.s3UpdatedAt
                          ? ` · ${new Date(doc.s3UpdatedAt).toLocaleString()}`
                          : ''}
                      </p>
                    </div>
                    <button
                      type="button"
                      className="text-xs text-accent-primary hover:underline shrink-0"
                      onClick={() => {
                        if (!activeSessionId) return;
                        const session = sessions.find((s) => s.id === activeSessionId);
                        const cwd = session?.cwd || workingDir;
                        if (!cwd) return;
                        void openSharedDoc({ sessionId: activeSessionId, cwd, docId: doc.id });
                        setSharedDocsModalOpen(false);
                      }}
                    >
                      {t('sidebar.sharedDocsOpen')}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>,
          document.body
        )
      : null;

  return (
    <>
      <div className="ml-auto flex items-center gap-0.5">
        <button
          type="button"
          onClick={handleJoinSharedDoc}
          disabled={!isElectron || !activeSessionId}
          className="w-7 h-7 rounded-md flex items-center justify-center hover:bg-surface-hover text-text-muted hover:text-text-primary transition-colors disabled:opacity-50"
          aria-label={t('sidebar.joinSharedDoc')}
          title={t('sidebar.joinSharedDoc')}
        >
          <FileText className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          onClick={handleOpenSharedDocsList}
          disabled={!isElectron || !activeSessionId}
          className="w-7 h-7 rounded-md flex items-center justify-center hover:bg-surface-hover text-text-muted hover:text-text-primary transition-colors disabled:opacity-50"
          aria-label={t('sidebar.sharedDocsList')}
          title={t('sidebar.sharedDocsList')}
        >
          <Layers className="w-3.5 h-3.5" />
        </button>
      </div>
      {joinSharedDocModal}
      {sharedDocsModal}
    </>
  );
}
