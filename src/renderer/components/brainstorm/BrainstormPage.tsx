import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import type { BrainstormDetail, BrainstormSummary } from '../../../shared/brainstorm-types';
import { useAppStore } from '../../store';
import { useIPC } from '../../hooks/useIPC';
import { BrainstormLibrary } from './BrainstormLibrary';
import { BrainstormSetup } from './BrainstormSetup';
import { BrainstormWorkspace } from './BrainstormWorkspace';

export function BrainstormPage({ onClose }: { onClose: () => void }) {
  const { invoke } = useIPC();
  const list = useAppStore((s) => s.brainstormList);
  const activeId = useAppStore((s) => s.activeBrainstormId);
  const detail = useAppStore((s) => (activeId ? s.brainstormsById[activeId] : undefined));
  const setList = useAppStore((s) => s.setBrainstormList);
  const upsert = useAppStore((s) => s.upsertBrainstorm);
  const setActive = useAppStore((s) => s.setActiveBrainstormId);
  const remove = useAppStore((s) => s.removeBrainstorm);
  const setGlobalNotice = useAppStore((s) => s.setGlobalNotice);
  const [roomId, setRoomId] = useState('');

  useEffect(() => {
    let cancelled = false;
    void invoke<BrainstormSummary[]>({ type: 'brainstorm.list', payload: {} })
      .then((items) => {
        if (!cancelled && Array.isArray(items)) setList(items);
      })
      .catch(() => {
        /* list stays as last known */
      });
    return () => {
      cancelled = true;
    };
  }, [invoke, setList]);

  useEffect(() => {
    if (!activeId || detail) return;
    let cancelled = false;
    void invoke<BrainstormDetail | null>({ type: 'brainstorm.get', payload: { id: activeId } })
      .then((next) => {
        if (!cancelled && next) upsert(next);
      })
      .catch(() => {
        if (!cancelled) setActive(null);
      });
    return () => {
      cancelled = true;
    };
  }, [activeId, detail, invoke, setActive, upsert]);

  const open = (id: string) => setActive(id);

  const deleteOne = async (id: string) => {
    if (!window.confirm('Delete this brainstorm and its chat?')) return;
    try {
      await invoke<boolean>({ type: 'brainstorm.delete', payload: { id } });
      remove(id);
    } catch (error) {
      setGlobalNotice({
        id: `brainstorm-delete-${Date.now()}`,
        type: 'error',
        message: error instanceof Error ? error.message : 'Could not delete the brainstorm',
      });
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      {activeId && !detail ? (
        <div className="flex flex-1 items-center justify-center text-[13px] text-text-muted">
          Opening brainstorm…
        </div>
      ) : detail ? (
        <BrainstormWorkspace detail={detail} onBack={() => setActive(null)} />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-6">
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-text-primary">
                  Brainstorm
                </h1>
                <p className="mt-1 text-[13px] text-text-secondary">
                  Name a topic. York researches and facilitates on a board instead of a plain chat.
                </p>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg p-1 text-text-muted hover:bg-surface-hover hover:text-text-primary"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <BrainstormSetup />
            <form
              className="flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                const trimmed = roomId.trim();
                if (!trimmed) return;
                void invoke<BrainstormDetail>({
                  type: 'brainstorm.join',
                  payload: { roomId: trimmed },
                })
                  .then((detail) => {
                    upsert(detail);
                    setActive(detail.id);
                    setRoomId('');
                  })
                  .catch((error: unknown) => {
                    setGlobalNotice({
                      id: `brainstorm-join-${Date.now()}`,
                      type: 'error',
                      message: error instanceof Error ? error.message : 'Could not join that room',
                    });
                  });
              }}
            >
              <input
                value={roomId}
                onChange={(event) => setRoomId(event.target.value)}
                placeholder="Join with a room ID"
                className="min-w-0 flex-1 rounded-xl border border-border-subtle bg-background px-3 py-2 text-[13px] text-text-primary"
              />
              <button
                type="submit"
                className="rounded-full border border-border-subtle px-3 py-1.5 text-[12px] text-text-secondary"
              >
                Join
              </button>
            </form>
            <BrainstormLibrary items={list} onOpen={open} onDelete={(id) => void deleteOne(id)} />
          </div>
        </div>
      )}
    </div>
  );
}
