import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Check, Loader2, Mic, MicOff, X, AlertTriangle } from 'lucide-react';
import type { VoiceActionResult } from '../../shared/voice-control';
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
  stop_listening: 'Stop',
};

/** Floating voice-control pill (rendered in its own non-focusable window via `#voice`). */
export function VoiceOverlay() {
  const [status, setStatus] = useState<VoiceSessionStatus>('connecting');
  const [userText, setUserText] = useState('');
  const [assistantText, setAssistantText] = useState('');
  const [lastAction, setLastAction] = useState<{ name: string; result: VoiceActionResult } | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);
  const sessionRef = useRef<VoiceRealtimeSession | null>(null);

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
        onAction: (name, result) => setLastAction({ name, result }),
        onError: setError,
        // Keep errors on screen long enough to read; close quietly otherwise.
        onEnded: (reason) => finish(reason === 'error' ? 4000 : 250),
      });
      sessionRef.current = session;
      void session.start();
    });

    const offStop = api.onStop(() => {
      if (sessionRef.current) sessionRef.current.end('user');
      else finish(0);
    });
    return () => {
      disposed = true;
      offStop();
      sessionRef.current?.end('user');
      if (closeTimer !== null) window.clearTimeout(closeTimer);
    };
  }, []);

  const active = status !== 'ended' && status !== 'error';
  const busy = status === 'connecting' || status === 'thinking' || status === 'acting';

  return (
    <div className="flex h-screen w-screen items-start justify-center p-1 select-none">
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
              {error ?? (userText ? `“${userText}”` : 'Esc or say “stop” to close')}
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
    </div>
  );
}
