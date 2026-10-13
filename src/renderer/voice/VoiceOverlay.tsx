import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Check, Copy, Loader2, Mic, MicOff, PenLine, X, AlertTriangle } from 'lucide-react';
import type { VoiceActionResult, VoiceDraftUpdate } from '../../shared/voice-control';
import { VoiceRealtimeSession, type VoiceSessionStatus } from './voice-session';

const STATUS_LABEL: Record<VoiceSessionStatus, string> = {
  connecting: 'Connecting…',
  listening: 'Listening — say a command',
  hearing: 'Hearing you…',
  thinking: 'Working on it…',
  acting: 'Doing it…',
  speaking: 'Replying…',
  error: 'Voice control stopped',
  ended: 'Mic off',
};

const ACTION_LABEL: Record<string, string> = {
  scroll: 'Scroll',
  switch_tab: 'Switch tab',
  open_app: 'Open app',
  focus_app: 'Focus app',
  press_keys: 'Keys',
  type_text: 'Type',
  do_on_screen: 'Screen',
  write: 'Write',
  set_model: 'Model',
  get_model: 'Model',
  stop_listening: 'Stop',
};

/** Keep a finished draft readable after the mic closes. */
const DRAFT_LINGER_MS = 8000;

/** Floating voice-control pill (rendered in its own non-focusable window via `#voice`). */
export function VoiceOverlay() {
  const [status, setStatus] = useState<VoiceSessionStatus>('connecting');
  const [userText, setUserText] = useState('');
  const [assistantText, setAssistantText] = useState('');
  const [lastAction, setLastAction] = useState<{ name: string; result: VoiceActionResult } | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<VoiceDraftUpdate | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const draftShownRef = useRef(false);
  const sessionRef = useRef<VoiceRealtimeSession | null>(null);

  useEffect(() => {
    draftShownRef.current = draft !== null;
  }, [draft]);

  useEffect(() => {
    document.documentElement.style.background = 'transparent';
    document.body.style.background = 'transparent';
    const api = window.electronAPI.voice;
    let disposed = false;
    let closeTimer: number | null = null;

    const finish = (delayMs: number) => {
      if (closeTimer !== null) return;
      closeTimer = window.setTimeout(() => void api.sessionEnded(), delayMs);
    };

    void api.getOverlayInit().then((init) => {
      if (disposed) return;
      const session = new VoiceRealtimeSession(init.followUpSeconds * 1000, {
        onStatus: setStatus,
        onUserTranscript: setUserText,
        onAssistantText: setAssistantText,
        onAction: (name, result) => {
          setLastAction({ name, result });
          setProgress(null);
        },
        onError: setError,
        // Keep errors on screen long enough to read; close quietly otherwise.
        onEnded: (reason) =>
          finish(reason === 'error' ? 4000 : draftShownRef.current ? DRAFT_LINGER_MS : 250),
      });
      sessionRef.current = session;
      void session.start();
    });

    const offStop = api.onStop(() => {
      if (sessionRef.current) sessionRef.current.end('user');
      else finish(0);
    });
    const offDraft = api.onDraft(setDraft);
    const offProgress = api.onProgress(setProgress);
    return () => {
      disposed = true;
      offStop();
      offDraft();
      offProgress();
      sessionRef.current?.end('user');
      if (closeTimer !== null) window.clearTimeout(closeTimer);
    };
  }, []);

  const active = status !== 'ended' && status !== 'error';
  const busy = status === 'connecting' || status === 'thinking' || status === 'acting';

  return (
    <div className="flex h-screen w-screen flex-col items-center justify-start gap-2 p-1 select-none">
      <div
        className="w-full rounded-2xl border border-white/10 bg-neutral-900/90 px-4 py-3 text-white shadow-2xl backdrop-blur-xl"
        style={{ WebkitAppRegion: 'drag' } as CSSProperties}
      >
        <div className="flex items-center gap-3">
          <div
            className={`relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
              status === 'error' ? 'bg-red-500/20' : active ? 'bg-emerald-500/20' : 'bg-white/10'
            }`}
          >
            {(status === 'listening' || status === 'hearing') && (
              <span className="absolute inset-0 animate-ping rounded-full bg-emerald-400/30" />
            )}
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin text-emerald-300" />
            ) : status === 'error' ? (
              <AlertTriangle className="h-4 w-4 text-red-300" />
            ) : active ? (
              <Mic className="h-4 w-4 text-emerald-300" />
            ) : (
              <MicOff className="h-4 w-4 text-white/60" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">{STATUS_LABEL[status]}</div>
            <div className="truncate text-xs text-white/60">
              {error ??
                (status === 'acting' && progress
                  ? progress
                  : userText
                    ? `“${userText}”`
                    : 'Esc or say “stop” to close')}
            </div>
          </div>
          <button
            type="button"
            aria-label="Stop voice control"
            onClick={() => {
              sessionRef.current?.end('user');
              void window.electronAPI.voice.sessionEnded();
            }}
            className="flex h-7 w-7 items-center justify-center rounded-full text-white/60 hover:bg-white/10 hover:text-white"
            style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {(lastAction || assistantText) && (
          <div className="mt-2 flex items-center gap-2 border-t border-white/10 pt-2 text-xs text-white/70">
            {lastAction && (
              <span
                className={`inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 ${
                  lastAction.result.ok
                    ? 'bg-emerald-500/15 text-emerald-200'
                    : 'bg-amber-500/15 text-amber-200'
                }`}
              >
                {lastAction.result.ok && <Check className="h-3 w-3" />}
                {ACTION_LABEL[lastAction.name] ?? lastAction.name}
              </span>
            )}
            <span className="truncate">
              {assistantText ||
                (lastAction && !lastAction.result.ok ? lastAction.result.message : '')}
            </span>
          </div>
        )}
      </div>
      {draft && (
        <DraftCard
          draft={draft}
          onCopy={() => void window.electronAPI.voice.copyDraft(draft.text)}
          onDismiss={() => {
            setDraft(null);
            void window.electronAPI.voice.dismissDraft();
          }}
        />
      )}
    </div>
  );
}

const DRAFT_PHASE_LABEL: Record<VoiceDraftUpdate['phase'], string> = {
  drafting: 'Drafting from your screen…',
  pasted: 'Pasted — not sent',
  failed: 'Not pasted',
};

function DraftCard({
  draft,
  onCopy,
  onDismiss,
}: {
  draft: VoiceDraftUpdate;
  onCopy: () => void;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const noDrag = { WebkitAppRegion: 'no-drag' } as CSSProperties;

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col rounded-2xl border border-white/10 bg-neutral-900/90 px-4 py-3 text-white shadow-2xl backdrop-blur-xl">
      <div className="flex items-center gap-2">
        <PenLine className="h-3.5 w-3.5 shrink-0 text-emerald-300" />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium">{DRAFT_PHASE_LABEL[draft.phase]}</div>
          <div className="truncate text-[11px] text-white/50">{draft.instruction}</div>
        </div>
        {draft.phase === 'drafting' && (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-emerald-300" />
        )}
      </div>
      <div
        className="mt-2 min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap rounded-lg bg-white/5 px-3 py-2 text-sm leading-relaxed text-white/90 select-text"
        style={noDrag}
      >
        {draft.text || <span className="text-white/40">Reading the screen…</span>}
      </div>
      {draft.note && <div className="mt-1.5 text-[11px] text-amber-200">{draft.note}</div>}
      {draft.phase !== 'drafting' && (
        <div className="mt-2 flex justify-end gap-2" style={noDrag}>
          <button
            type="button"
            disabled={!draft.text}
            onClick={() => {
              onCopy();
              setCopied(true);
            }}
            className="inline-flex h-7 items-center gap-1 rounded-lg bg-white/10 px-2.5 text-xs hover:bg-white/15 disabled:opacity-40"
          >
            {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button
            type="button"
            onClick={onDismiss}
            className="inline-flex h-7 items-center rounded-lg px-2.5 text-xs text-white/70 hover:bg-white/10 hover:text-white"
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}
