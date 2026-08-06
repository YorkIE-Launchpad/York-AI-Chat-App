import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { ArrowUp, Loader2, Maximize2, Sparkles, X } from 'lucide-react';
import { useAppStore } from '../store';
import { useAskGrowthOSState, useSessionMessages } from '../store/selectors';
import { useIPC } from '../hooks/useIPC';
import { useDictation } from '../hooks/useDictation';
import { DictationButton } from './DictationButton';
import { MessageMarkdown } from './MessageMarkdown';
import { getInitialSessionTitle } from '../../shared/session-title';
import type { ContentBlock, Message } from '../types';

const HINT_KEYS = [
  'askGrowthOS.hintTimesheet',
  'askGrowthOS.hintSchedule',
  'askGrowthOS.hintCatchUp',
] as const;

function messagePlainText(message: Message): string {
  const raw = message.content as unknown;
  if (typeof raw === 'string') {
    return raw;
  }
  if (!Array.isArray(raw)) {
    return '';
  }
  return (raw as ContentBlock[])
    .filter((block) => block.type === 'text')
    .map((block) => ('text' in block ? String(block.text ?? '') : ''))
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

export function AskGrowthOSPopup() {
  const { t } = useTranslation();
  const { open, sessionId } = useAskGrowthOSState();
  const setAskGrowthOSOpen = useAppStore((s) => s.setAskGrowthOSOpen);
  const setAskGrowthOSSessionId = useAppStore((s) => s.setAskGrowthOSSessionId);
  const setActiveSession = useAppStore((s) => s.setActiveSession);
  const setShowSettings = useAppStore((s) => s.setShowSettings);
  const setShowMatter = useAppStore((s) => s.setShowMatter);
  const workingDir = useAppStore((s) => s.workingDir);
  const sessions = useAppStore((s) => s.sessions);
  const sessionStates = useAppStore((s) => s.sessionStates);

  const { startSession, continueSession, isElectron } = useIPC();
  const messages = useSessionMessages(sessionId ?? '');

  const [prompt, setPrompt] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const promptRef = useRef(prompt);
  promptRef.current = prompt;
  const autoDictationStartedRef = useRef(false);

  const boundSession = sessionId ? (sessions.find((s) => s.id === sessionId) ?? null) : null;
  const isRunning = boundSession?.status === 'running';
  const partialMessage = sessionId ? (sessionStates[sessionId]?.partialMessage ?? '') : '';
  const hasActiveTurn = Boolean(sessionId && sessionStates[sessionId]?.activeTurn);

  const dictation = useDictation({
    enabled: open && isElectron,
    onTranscript: (text) => setPrompt(text),
    getPrompt: () => promptRef.current,
  });

  const shortcutLabel = useMemo(() => {
    if (typeof window !== 'undefined' && window.electronAPI?.platform === 'darwin') {
      return '⌘⇧Space';
    }
    return 'Ctrl+Shift+Space';
  }, []);

  const close = useCallback(() => {
    dictation.stop();
    setAskGrowthOSOpen(false);
  }, [dictation, setAskGrowthOSOpen]);

  const openInChat = useCallback(() => {
    dictation.stop();
    if (sessionId) {
      setShowSettings(false);
      setShowMatter(false);
      setActiveSession(sessionId);
    }
    setAskGrowthOSOpen(false);
  }, [dictation, sessionId, setActiveSession, setAskGrowthOSOpen, setShowMatter, setShowSettings]);

  // Focus + auto-start dictation when opened
  useEffect(() => {
    if (!open) {
      autoDictationStartedRef.current = false;
      dictation.stop();
      return;
    }
    const focusTimer = window.setTimeout(() => {
      textareaRef.current?.focus();
    }, 50);

    let dictationTimer: number | undefined;
    if (isElectron && dictation.isAvailable && !autoDictationStartedRef.current) {
      autoDictationStartedRef.current = true;
      dictationTimer = window.setTimeout(() => {
        if (dictation.status === 'idle') {
          dictation.toggle();
        }
      }, 120);
    }

    return () => {
      window.clearTimeout(focusTimer);
      if (dictationTimer !== undefined) {
        window.clearTimeout(dictationTimer);
      }
    };
    // Intentionally depend on open + availability only — avoid re-toggling on status churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- dictation object is unstable
  }, [open, isElectron, dictation.isAvailable]);

  // Esc to close
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [open, close]);

  // Auto-scroll transcript
  useEffect(() => {
    if (!listRef.current) return;
    listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages, partialMessage, open]);

  const handleHint = (text: string) => {
    setPrompt(text);
    window.setTimeout(() => textareaRef.current?.focus(), 0);
  };

  const handleSubmit = async () => {
    const text = prompt.trim();
    if (!text || isSubmitting || isRunning) {
      return;
    }

    dictation.stop();
    setIsSubmitting(true);
    try {
      if (sessionId && sessions.some((s) => s.id === sessionId)) {
        await continueSession(sessionId, text);
        setPrompt('');
        return;
      }

      const title = getInitialSessionTitle(text);
      const session = await startSession(title, text, workingDir || undefined);
      if (session) {
        setAskGrowthOSSessionId(session.id);
        setPrompt('');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const onKeyDownComposer = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void handleSubmit();
    }
  };

  if (!open) {
    return null;
  }

  const canSubmit = prompt.trim().length > 0 && !isSubmitting && !isRunning;
  const busy = isSubmitting || isRunning || hasActiveTurn;

  return createPortal(
    <div
      className="fixed inset-0 z-[70] flex items-end justify-center bg-black/25 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] backdrop-blur-sm animate-fade-in sm:items-center"
      role="presentation"
      onClick={() => {
        if (!busy) {
          close();
        }
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="ask-growthos-title"
        className="card flex max-h-[min(85vh,720px)] w-full max-w-xl flex-col overflow-hidden p-0 shadow-elevated animate-slide-up"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start gap-3 border-b border-border-subtle px-5 py-4">
          <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-accent-muted">
            <Sparkles className="h-5 w-5 text-accent" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="ask-growthos-title" className="text-base font-semibold text-text-primary">
              {t('askGrowthOS.title')}
            </h2>
            <p className="mt-0.5 text-xs text-text-secondary">
              {t('askGrowthOS.subtitle', { shortcut: shortcutLabel })}
            </p>
          </div>
          <div className="flex items-center gap-1">
            {sessionId ? (
              <button
                type="button"
                className="btn btn-ghost h-8 px-2 text-xs"
                onClick={openInChat}
                title={t('askGrowthOS.openInChat')}
              >
                <Maximize2 className="mr-1 h-3.5 w-3.5" />
                {t('askGrowthOS.openInChat')}
              </button>
            ) : null}
            <button
              type="button"
              className="flex h-8 w-8 items-center justify-center rounded-xl text-text-muted hover:bg-surface-hover hover:text-text-primary"
              onClick={close}
              aria-label={t('askGrowthOS.close')}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div
          ref={listRef}
          className="min-h-[140px] flex-1 space-y-3 overflow-y-auto bg-surface-muted/40 px-5 py-4"
        >
          {messages.length === 0 && !partialMessage ? (
            <div className="space-y-3">
              <p className="text-sm text-text-secondary">{t('askGrowthOS.empty')}</p>
              <div className="flex flex-wrap gap-2">
                {HINT_KEYS.map((key) => {
                  const label = t(key);
                  return (
                    <button
                      key={key}
                      type="button"
                      className="rounded-full border border-border-subtle bg-background px-3 py-1.5 text-left text-xs text-text-secondary transition-colors hover:border-accent/40 hover:text-text-primary"
                      onClick={() => handleHint(label)}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            <>
              {messages.map((message) => {
                if (message.role !== 'user' && message.role !== 'assistant') {
                  return null;
                }
                const text = messagePlainText(message);
                if (!text && message.role === 'assistant') {
                  return null;
                }
                const isUser = message.role === 'user';
                return (
                  <div
                    key={message.id}
                    className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}
                  >
                    <div
                      className={`max-w-[92%] rounded-2xl px-3.5 py-2.5 text-sm ${
                        isUser
                          ? 'bg-accent text-white'
                          : 'border border-border-subtle bg-background text-text-primary'
                      }`}
                    >
                      {isUser ? (
                        <p className="whitespace-pre-wrap">{text || '…'}</p>
                      ) : (
                        <div className="prose-sm max-w-none">
                          <MessageMarkdown normalizedText={text} />
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
              {partialMessage ? (
                <div className="flex justify-start">
                  <div className="max-w-[92%] rounded-2xl border border-border-subtle bg-background px-3.5 py-2.5 text-sm text-text-primary">
                    <MessageMarkdown normalizedText={partialMessage} />
                  </div>
                </div>
              ) : null}
              {busy && !partialMessage ? (
                <div className="flex items-center gap-2 text-xs text-text-muted">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  {t('askGrowthOS.working')}
                </div>
              ) : null}
            </>
          )}
        </div>

        <div className="border-t border-border-subtle px-4 py-3">
          <div className="flex items-end gap-2 rounded-2xl border border-border-subtle bg-background px-2 py-2">
            <textarea
              ref={textareaRef}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={onKeyDownComposer}
              rows={2}
              placeholder={t('askGrowthOS.placeholder')}
              className="max-h-32 min-h-[2.75rem] flex-1 resize-none bg-transparent px-2 py-1.5 text-sm text-text-primary outline-none placeholder:text-text-muted"
              aria-label={t('askGrowthOS.placeholder')}
            />
            <div className="flex flex-shrink-0 items-center gap-1 pb-0.5">
              <DictationButton
                status={dictation.status}
                errorKind={dictation.errorKind}
                disabled={!isElectron || !dictation.isAvailable || isSubmitting}
                onToggle={dictation.toggle}
              />
              <button
                type="button"
                onClick={() => void handleSubmit()}
                disabled={!canSubmit}
                className="flex h-8 w-8 items-center justify-center rounded-xl bg-accent text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
                title={t('chat.sendMessage')}
                aria-label={t('chat.sendMessage')}
              >
                {isSubmitting ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <ArrowUp className="h-3.5 w-3.5" />
                )}
              </button>
            </div>
          </div>
          {dictation.status === 'recording' ? (
            <p className="mt-1.5 px-1 text-[11px] text-accent">{t('chat.dictationListening')}</p>
          ) : null}
          {dictation.status === 'error' && dictation.errorKind ? (
            <p className="mt-1.5 px-1 text-[11px] text-error">
              {dictation.errorKind === 'mic_denied'
                ? t('chat.dictationMicDenied')
                : dictation.errorKind === 'sign_in'
                  ? t('chat.dictationSignInRequired')
                  : t('chat.dictationFailed')}
            </p>
          ) : null}
        </div>
      </div>
    </div>,
    document.body
  );
}
