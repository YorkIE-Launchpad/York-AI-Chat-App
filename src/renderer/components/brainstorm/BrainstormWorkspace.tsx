import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { ArrowLeft, Loader2, Send, Share2, Square } from 'lucide-react';
import type { BrainstormDetail, BrainstormIdeaPatch } from '../../../shared/brainstorm-types';
import { useAppStore } from '../../store';
import { EMPTY_MESSAGES } from '../../store/selectors';
import { useIPC } from '../../hooks/useIPC';
import { MessageCard } from '../MessageCard';
import { PhaseStepper } from './PhaseStepper';
import { SignalsDrawer } from './SignalsDrawer';
import { IdeaBoard } from './IdeaBoard';
import { BrainstormBrief } from './BrainstormBrief';
import { ActivityTimeline } from './ActivityTimeline';
import { ShareBrainstormDialog } from './ShareBrainstormDialog';
import { ModelSelector } from '../ModelSelector';
import { PanelErrorBoundary } from '../PanelErrorBoundary';

const SPLIT_KEY = 'brainstorm-chat-ratio';
const SPLIT_MIN = 0.24;
const SPLIT_MAX = 0.7;

function isFacilitatorKickoff(message: { role: string; content: unknown }): boolean {
  if (message.role !== 'user' || !Array.isArray(message.content)) return false;
  const text = message.content
    .map((block) => {
      if (!block || typeof block !== 'object') return '';
      const rec = block as { type?: string; text?: string };
      return rec.type === 'text' && typeof rec.text === 'string' ? rec.text : '';
    })
    .join('\n');
  return text.includes('lens privately') && text.includes('brainstorm_set_phase');
}

function readChatRatio(): number {
  try {
    const value = Number(window.localStorage.getItem(SPLIT_KEY));
    if (value >= SPLIT_MIN && value <= SPLIT_MAX) return value;
  } catch {
    /* keep the default split */
  }
  return 0.4;
}

export function BrainstormWorkspace({
  detail,
  onBack,
}: {
  detail: BrainstormDetail;
  onBack: () => void;
}) {
  const { invoke, continueSession, stopSession, getSessionMessages, isElectron } = useIPC();
  const messages = useAppStore(
    (s) => s.sessionStates[detail.sessionId]?.messages ?? EMPTY_MESSAGES
  );
  const partial = useAppStore((s) => s.sessionStates[detail.sessionId]?.partialMessage ?? '');
  const session = useAppStore((s) => s.sessions.find((item) => item.id === detail.sessionId));
  const upsertBrainstorm = useAppStore((s) => s.upsertBrainstorm);
  const setGlobalNotice = useAppStore((s) => s.setGlobalNotice);
  const openHtmlPreview = useAppStore((s) => s.openHtmlPreview);
  const [draft, setDraft] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [showBrief, setShowBrief] = useState(detail.phase === 'wrapup' || Boolean(detail.brief));
  const [pane, setPane] = useState<'board' | 'timeline'>('board');
  const [sharing, setSharing] = useState(false);
  const [peers, setPeers] = useState<string[]>([]);
  const scroller = useRef<HTMLDivElement>(null);
  const splitRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startX: number; startRatio: number } | null>(null);
  const [chatRatio, setChatRatio] = useState(readChatRatio);
  const running = session?.status === 'running';
  const visibleMessages = messages.filter((message) => !isFacilitatorKickoff(message));
  const ideas = detail.ideas || [];
  const signals = detail.signals || [];
  const activity = detail.activity || [];

  useEffect(() => {
    if (!isElectron || messages.length > 0) return;
    void getSessionMessages(detail.sessionId).then((loaded) => {
      if (loaded?.length) useAppStore.getState().setMessages(detail.sessionId, loaded);
    });
  }, [detail.sessionId, getSessionMessages, isElectron, messages.length]);

  useEffect(() => {
    const node = scroller.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [messages.length, partial]);

  useEffect(() => {
    if (detail.phase === 'wrapup' || detail.brief) setShowBrief(true);
  }, [detail.phase, detail.brief]);

  const notice = (message: string) => {
    setGlobalNotice({ id: `brainstorm-${Date.now()}`, type: 'error', message });
  };

  const patchIdea = async (id: string, patch: BrainstormIdeaPatch) => {
    try {
      const next = await invoke<BrainstormDetail | null>({
        type: 'brainstorm.updateIdea',
        payload: { id, patch },
      });
      if (next) upsertBrainstorm(next);
    } catch (error) {
      notice(error instanceof Error ? error.message : 'Could not update the idea');
    }
  };

  const addThought = async (ideaId: string | null, text: string) => {
    const next = await invoke<BrainstormDetail>({
      type: 'brainstorm.addThought',
      payload: { id: detail.id, ideaId, text },
    });
    if (next) upsertBrainstorm(next);
  };

  const addFiles = async (paths: string[]) => {
    const next = await invoke<BrainstormDetail>({
      type: 'brainstorm.addFiles',
      payload: { id: detail.id, paths },
    });
    if (next) upsertBrainstorm(next);
  };

  const addIdea = async (title: string, body: string) => {
    try {
      const next = await invoke<BrainstormDetail | null>({
        type: 'brainstorm.addIdea',
        payload: { brainstormId: detail.id, title, body },
      });
      if (next) upsertBrainstorm(next);
    } catch (error) {
      notice(error instanceof Error ? error.message : 'Could not add the idea');
    }
  };

  const askAboutSelection = (verb: 'Expand' | 'Combine') => {
    const chosen = ideas.filter((idea) => selected.includes(idea.id));
    if (chosen.length === 0) return;
    const list = chosen.map((idea) => `- ${idea.id}: ${idea.title}`).join('\n');
    const prompt =
      verb === 'Expand'
        ? `Expand these ideas into sharper versions and update the cards:\n${list}`
        : `Combine these ideas into one stronger card, and say what you dropped:\n${list}`;
    void continueSession(detail.sessionId, prompt);
    setSelected([]);
  };

  const send = () => {
    const text = draft.trim();
    if (!text || running) return;
    setDraft('');
    void continueSession(detail.sessionId, text);
  };

  const exportBrief = async () => {
    setBusy(true);
    try {
      const result = await invoke<{ path: string; html: string }>({
        type: 'brainstorm.exportBrief',
        payload: { id: detail.id },
      });
      openHtmlPreview(result.path, `${detail.topic} brief`, 'html');
      if (window.electronAPI?.openPath) {
        await window.electronAPI.openPath(result.path);
      }
    } catch (error) {
      notice(error instanceof Error ? error.message : 'Could not export the brief');
    } finally {
      setBusy(false);
    }
  };

  const sendFollowUps = async () => {
    const experiments = detail.brief?.experiments || [];
    if (!window.electronAPI?.loops?.create || experiments.length === 0) return;
    setBusy(true);
    try {
      for (const experiment of experiments) {
        await window.electronAPI.loops.create({
          title: experiment.title,
          notes: `${experiment.steps}\n\nFrom brainstorm: ${detail.topic}`,
          research: false,
        });
      }
      setGlobalNotice({
        id: `brainstorm-loops-${Date.now()}`,
        type: 'success',
        message: `Sent ${experiments.length} experiment${experiments.length === 1 ? '' : 's'} to Follow-ups.`,
      });
    } catch (error) {
      notice(error instanceof Error ? error.message : 'Could not create follow-ups');
    } finally {
      setBusy(false);
    }
  };

  const ratioRef = useRef(chatRatio);

  const rememberSplit = (ratio: number) => {
    const next = Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, ratio));
    ratioRef.current = next;
    setChatRatio(next);
    try {
      window.localStorage.setItem(SPLIT_KEY, String(next));
    } catch {
      /* the drag still applies for this visit */
    }
  };

  const onSplitPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragRef.current = { startX: event.clientX, startRatio: ratioRef.current };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onSplitPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const bounds = splitRef.current?.getBoundingClientRect();
    if (!drag || !bounds?.width || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const next = Math.min(
      SPLIT_MAX,
      Math.max(SPLIT_MIN, drag.startRatio + (event.clientX - drag.startX) / bounds.width)
    );
    ratioRef.current = next;
    setChatRatio(next);
  };

  const onSplitPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    rememberSplit(ratioRef.current);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-start gap-3 border-b border-border-subtle px-4 py-3">
        <button
          type="button"
          onClick={onBack}
          className="mt-0.5 rounded-lg p-1 text-text-muted hover:bg-surface-hover hover:text-text-primary"
          aria-label="Back to brainstorms"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[16px] font-semibold text-text-primary">{detail.topic}</h1>
          {detail.goal ? (
            <p className="truncate text-[12px] text-text-muted">{detail.goal}</p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => {
            setSharing(true);
            void window.electronAPI?.collab
              ?.getState?.(detail.sessionId)
              .then((state) => {
                if (state && Array.isArray(state.peerNames)) setPeers(state.peerNames);
              })
              .catch(() => undefined);
          }}
          className="inline-flex items-center gap-1 rounded-full border border-border-subtle px-2.5 py-1 text-[12px] text-text-secondary"
        >
          <Share2 className="h-3.5 w-3.5" />
          Share
        </button>
        {running ? (
          <button
            type="button"
            onClick={() => stopSession(detail.sessionId)}
            className="inline-flex items-center gap-1 rounded-full border border-border-subtle px-2.5 py-1 text-[12px] text-text-secondary"
          >
            <Square className="h-3 w-3" />
            Stop
          </button>
        ) : null}
      </header>
      <div ref={splitRef} className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <section
          className="flex min-h-0 w-full min-w-0 flex-col overflow-hidden border-b border-border-subtle max-lg:!w-full lg:shrink-0 lg:border-b-0 lg:border-r"
          style={{ width: `${chatRatio * 100}%` }}
        >
          <div ref={scroller} className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-3">
            {visibleMessages.map((message, index) => (
              <PanelErrorBoundary
                key={message.id}
                name="BrainstormMessage"
                resetKey={message.id}
                fallback={
                  <p className="px-2 text-[12px] text-text-muted">
                    This update could not be shown.
                  </p>
                }
              >
                <MessageCard
                  message={message}
                  allMessages={visibleMessages}
                  isStreaming={
                    running && index === visibleMessages.length - 1 && message.role === 'assistant'
                  }
                />
              </PanelErrorBoundary>
            ))}
            {partial ? (
              <p className="whitespace-pre-wrap px-2 text-[13px] leading-relaxed text-text-secondary">
                {partial}
              </p>
            ) : null}
            {running && !partial ? (
              <p className="inline-flex items-center gap-1.5 px-2 text-[12px] text-text-muted">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Working the board
              </p>
            ) : null}
          </div>
          <form
            className="border-t border-border-subtle p-3"
            onSubmit={(event) => {
              event.preventDefault();
              send();
            }}
          >
            <div className="relative flex items-end gap-2">
              <ModelSelector
                fitContent
                sessionId={detail.sessionId}
                brainstormId={detail.id}
                className="mb-1 shrink-0"
              />
              <textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    send();
                  }
                }}
                rows={2}
                placeholder="Answer, push back, or ask for more"
                className="min-h-[44px] flex-1 resize-none rounded-xl border border-border-subtle bg-background px-3 py-2 text-[13px] text-text-primary"
              />
              <button
                type="submit"
                disabled={!draft.trim() || running}
                className="rounded-xl bg-text-primary p-2 text-background disabled:opacity-40"
                aria-label="Send"
              >
                <Send className="h-4 w-4" />
              </button>
            </div>
          </form>
        </section>
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize chat and board"
          aria-valuemin={24}
          aria-valuemax={70}
          aria-valuenow={Math.round(chatRatio * 100)}
          tabIndex={0}
          onPointerDown={onSplitPointerDown}
          onPointerMove={onSplitPointerMove}
          onPointerUp={onSplitPointerUp}
          onPointerCancel={onSplitPointerUp}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
            event.preventDefault();
            rememberSplit(ratioRef.current + (event.key === 'ArrowRight' ? 0.04 : -0.04));
          }}
          className="relative hidden w-1.5 shrink-0 cursor-col-resize touch-none hover:bg-text-primary/15 lg:block"
        />
        <section className="min-h-0 min-w-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
          <PhaseStepper phase={detail.phase} />
          <SignalsDrawer signals={signals} onAddFiles={(paths) => void addFiles(paths)} />
          {showBrief ? null : (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setShowBrief(true)}
                className="rounded-full border border-border-subtle px-2.5 py-1 text-[11px] text-text-secondary"
              >
                Brief
              </button>
            </div>
          )}
          {showBrief ? (
            <BrainstormBrief
              detail={detail}
              busy={busy}
              onExport={() => void exportBrief()}
              onSendFollowUps={() => void sendFollowUps()}
            />
          ) : null}
          <div className="flex gap-1">
            <button
              type="button"
              onClick={() => setPane('board')}
              className={`rounded-full px-2.5 py-1 text-[11px] ${pane === 'board' ? 'bg-text-primary text-background' : 'text-text-secondary'}`}
            >
              Board
            </button>
            <button
              type="button"
              onClick={() => setPane('timeline')}
              className={`rounded-full px-2.5 py-1 text-[11px] ${pane === 'timeline' ? 'bg-text-primary text-background' : 'text-text-secondary'}`}
            >
              Timeline
            </button>
          </div>
          {selected.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] text-text-muted">{selected.length} picked</span>
              <button
                type="button"
                disabled={running}
                onClick={() => askAboutSelection('Expand')}
                className="rounded-full border border-border-subtle px-2.5 py-1 text-[11px] text-text-secondary disabled:opacity-40"
              >
                Say more
              </button>
              <button
                type="button"
                disabled={selected.length < 2 || running}
                onClick={() => askAboutSelection('Combine')}
                className="rounded-full border border-border-subtle px-2.5 py-1 text-[11px] text-text-secondary disabled:opacity-40"
              >
                Merge
              </button>
            </div>
          ) : null}
          {pane === 'timeline' ? (
            <ActivityTimeline activity={activity} ideas={ideas} />
          ) : (
            <IdeaBoard
              ideas={ideas}
              selectedIds={selected}
              onToggleSelect={(id) =>
                setSelected((current) =>
                  current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
                )
              }
              onPatch={(id, patch) => void patchIdea(id, patch)}
              onAdd={(title, body) => void addIdea(title, body)}
              onThought={(ideaId, text) => void addThought(ideaId, text)}
              activity={activity}
            />
          )}
        </section>
      </div>
      {sharing ? (
        <ShareBrainstormDialog
          brainstormId={detail.id}
          roomId={detail.roomId}
          peers={peers}
          onClose={() => setSharing(false)}
        />
      ) : null}
    </div>
  );
}
