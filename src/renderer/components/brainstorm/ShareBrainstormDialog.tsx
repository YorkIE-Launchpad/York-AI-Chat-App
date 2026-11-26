import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { useIPC } from '../../hooks/useIPC';

export function ShareBrainstormDialog({
  brainstormId,
  roomId,
  peers,
  onClose,
}: {
  brainstormId: string;
  roomId?: string | null;
  peers: string[];
  onClose: () => void;
}) {
  const { invoke } = useIPC();
  const [sharedRoom, setSharedRoom] = useState(roomId || '');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    void invoke<{ roomId: string }>({
      type: 'brainstorm.share',
      payload: { id: brainstormId },
    })
      .then((result) => {
        if (!cancelled) setSharedRoom(result.roomId);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setNotice(error instanceof Error ? error.message : 'Could not open the room');
        }
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [brainstormId, invoke]);

  const copyRoom = async () => {
    if (!sharedRoom) return;
    setBusy(true);
    try {
      await navigator.clipboard.writeText(sharedRoom);
      setNotice('Room ID copied.');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not copy the room ID');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/30 px-4 pt-24">
      <div className="w-full max-w-md rounded-2xl border border-border-subtle bg-background p-4 shadow-xl">
        <div className="mb-3 flex items-center gap-2">
          <h2 className="flex-1 text-[15px] font-semibold text-text-primary">Share brainstorm</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="text-text-muted">
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="text-[13px] leading-relaxed text-text-secondary">
          Copy the room ID. The other person pastes it on the Brainstorm page while you are both
          online. The board syncs live over the socket and is not stored on the server.
        </p>
        {peers.length > 0 ? (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {peers.map((name) => (
              <span
                key={name}
                className="inline-flex items-center gap-1 rounded-full bg-surface px-2 py-0.5 text-[12px] text-text-secondary"
              >
                <span className="flex h-4 w-4 items-center justify-center rounded-full bg-background text-[10px]">
                  {name.slice(0, 1).toUpperCase()}
                </span>
                {name}
              </span>
            ))}
          </div>
        ) : null}
        <p className="mt-3 break-all rounded-xl border border-border-subtle bg-surface px-3 py-2 font-mono text-[12px] text-text-primary">
          {sharedRoom || (busy ? 'Opening the room…' : 'Room not open')}
        </p>
        <button
          type="button"
          disabled={!sharedRoom || busy}
          onClick={() => void copyRoom()}
          className="mt-3 rounded-full bg-text-primary px-3 py-1.5 text-[12px] text-background disabled:opacity-40"
        >
          Copy room ID
        </button>
        {notice ? <p className="mt-2 text-[12px] text-text-secondary">{notice}</p> : null}
      </div>
    </div>
  );
}
