import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowUp,
  Check,
  ClipboardCopy,
  CornerDownLeft,
  ExternalLink,
  Loader2,
  MessageSquarePlus,
  PenLine,
  RefreshCw,
  Square,
  X,
} from 'lucide-react';
import { useDictation } from '../hooks/useDictation';
import { useSnapChat } from '../hooks/useSnapChat';
import { DictationButton } from './DictationButton';
import { SnapChatView } from './snap/SnapChatView';
import logoSrc from '../assets/logo.png';
import { ClientOutdatedUpdateActions } from './ClientOutdatedUpdateActions';
import { formatAccelerator } from '../utils/shortcut-accelerator';
import type {
  ScreenSnapComposerState,
  ScreenSnapImage,
  ScreenSnapInsertResult,
  ScreenSnapMode,
} from '../../shared/screen-snap';

type GenerateStatus = 'idle' | 'generating' | 'done' | 'error';
type InsertFailure = Extract<ScreenSnapInsertResult, { success: false }>['reason'];

/**
 * Floating Screen Snap composer (rendered in its own transparent, always-on-top
 * window via `#snap`).
 * - Chat: chats right here in the panel, backed by a real GrowthOS session
 *   (also saved in GrowthOS; "Open in GrowthOS" hands it to the main window).
 * - Write into field: streams an answer into an editable preview, then pastes
 *   it into the field that was focused in the original app.
 */
export function SnapComposer() {
  const { t } = useTranslation();
  const api = typeof window !== 'undefined' ? window.electronAPI : undefined;
  const isElectron = Boolean(api?.snap);

  const [image, setImage] = useState<ScreenSnapImage | null>(null);
  const [mode, setMode] = useState<ScreenSnapMode>('chat');
  const [targetAppName, setTargetAppName] = useState<string | null>(null);
  const [prompt, setPrompt] = useState('');
  const [shortcut, setShortcut] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitFailed, setSubmitFailed] = useState(false);

  const [draft, setDraft] = useState('');
  const [generateStatus, setGenerateStatus] = useState<GenerateStatus>('idle');
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [insertFailure, setInsertFailure] = useState<InsertFailure | null>(null);
  const [isInserting, setIsInserting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [chatSessionId, setChatSessionId] = useState<string | null>(null);
  const snapChat = useSnapChat();
  const { reset: resetChat } = snapChat;

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const promptRef = useRef(prompt);
  promptRef.current = prompt;

  const isWrite = mode === 'write';
  const isGenerating = generateStatus === 'generating';

  const dictation = useDictation({
    enabled: isElectron && image !== null,
    onTranscript: (text) => setPrompt(text),
    getPrompt: () => promptRef.current,
  });

  // Transparent window: drop the app background and follow the saved theme.
  useEffect(() => {
    document.documentElement.style.background = 'transparent';
    document.body.style.background = 'transparent';
    if (!api) return;
    void (async () => {
      try {
        const [config, system] = await Promise.all([api.config.get(), api.getSystemTheme()]);
        const theme = config.theme ?? 'light';
        const effective =
          theme === 'system' ? (system.shouldUseDarkColors ? 'dark' : 'light') : theme;
        document.documentElement.classList.toggle('light', effective === 'light');
        document.documentElement.style.colorScheme = effective;
      } catch {
        document.documentElement.classList.add('light');
      }
    })();
  }, [api]);

  useEffect(() => {
    if (!api?.snap) return;
    const acceptState = (next: ScreenSnapComposerState | null) => {
      if (!next) return;
      setImage(next.image);
      setMode(next.mode);
      setTargetAppName(next.targetAppName);
      setPrompt('');
      setDraft('');
      setGenerateStatus('idle');
      setGenerateError(null);
      setInsertFailure(null);
      setSubmitFailed(false);
      setChatSessionId(null);
      resetChat();
      window.setTimeout(() => textareaRef.current?.focus(), 30);
    };
    void api.snap.getPendingState().then(acceptState);
    void api.snap.getShortcut().then((result) => setShortcut(result.shortcut));
    const offImage = api.snap.onImage(acceptState);
    const offDelta = api.snap.onGenerateDelta((text) => setDraft(text));
    return () => {
      offImage();
      offDelta();
    };
  }, [api, resetChat]);

  const cancel = useCallback(() => {
    dictation.stop();
    void api?.snap.cancel();
  }, [api, dictation]);

  const switchMode = (next: ScreenSnapMode) => {
    if (next === mode || (next === 'write' && !targetAppName)) return;
    setMode(next);
    setInsertFailure(null);
    void api?.snap.setMode(next);
    window.setTimeout(() => textareaRef.current?.focus(), 0);
  };

  const { markStarting, markSending, markFailed } = snapChat;

  const submitChat = useCallback(async () => {
    if (!api?.snap || !image || isSubmitting) return;
    dictation.stop();
    setIsSubmitting(true);
    setSubmitFailed(false);
    markStarting();
    try {
      const text = promptRef.current.trim() || t('snap.defaultPrompt');
      const result = await api.snap.startChat({ text, image });
      if (result.success) {
        setChatSessionId(result.sessionId);
      } else {
        resetChat();
        setSubmitFailed(true);
      }
    } catch {
      resetChat();
      setSubmitFailed(true);
    } finally {
      setIsSubmitting(false);
    }
  }, [api, dictation, image, isSubmitting, markStarting, resetChat, t]);

  const followUp = useCallback(
    async (text: string) => {
      if (!api?.snap) return;
      markSending();
      const result = await api.snap.continueChat(text);
      if (!result.success) markFailed(result.error || t('snap.submitFailed'));
    },
    [api, markFailed, markSending, t]
  );

  const openInGrowthOS = useCallback(() => {
    dictation.stop();
    void api?.snap.openInGrowthOS();
  }, [api, dictation]);

  const generate = useCallback(async () => {
    if (!api?.snap || !image || isGenerating) return;
    dictation.stop();
    const instruction = promptRef.current.trim() || t('snap.writeDefaultInstruction');
    setDraft('');
    setGenerateError(null);
    setInsertFailure(null);
    setGenerateStatus('generating');
    try {
      const result = await api.snap.generate({ instruction, image });
      if (result.success) {
        setDraft(result.text);
        setGenerateStatus('done');
      } else if (result.cancelled) {
        setGenerateStatus((status) => (status === 'generating' ? 'done' : status));
      } else {
        setGenerateError(result.error);
        setGenerateStatus('error');
      }
    } catch (error) {
      setGenerateError(error instanceof Error ? error.message : String(error));
      setGenerateStatus('error');
    }
  }, [api, dictation, image, isGenerating, t]);

  const stopGenerating = useCallback(() => {
    void api?.snap.cancelGenerate();
  }, [api]);

  const insert = useCallback(async () => {
    const text = draft.trim();
    if (!api?.snap || !text || isInserting || isGenerating) return;
    setIsInserting(true);
    setInsertFailure(null);
    try {
      const result = await api.snap.insert(text);
      if (!result.success) setInsertFailure(result.reason);
    } catch {
      setInsertFailure('failed');
    } finally {
      setIsInserting(false);
    }
  }, [api, draft, isGenerating, isInserting]);

  const copyDraft = useCallback(async () => {
    if (!draft.trim()) return;
    try {
      await navigator.clipboard.writeText(draft.trim());
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  }, [draft]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (isGenerating) {
          stopGenerating();
        } else {
          cancel();
        }
        return;
      }
      if (isWrite && event.key === 'Enter' && event.metaKey && generateStatus === 'done') {
        event.preventDefault();
        void insert();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [cancel, generateStatus, insert, isGenerating, isWrite, stopGenerating]);

  const onKeyDownComposer = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.metaKey || event.nativeEvent.isComposing) {
      return;
    }
    event.preventDefault();
    if (isWrite) {
      void generate();
    } else {
      void submitChat();
    }
  };

  const isListening = dictation.status === 'recording';
  const shortcutLabel = formatAccelerator(shortcut);
  const chatActive = !isWrite && snapChat.state.status !== null;
  const showPreview = isWrite && generateStatus !== 'idle';
  const glowFast = isListening || isGenerating;

  const insertFailureMessage =
    insertFailure === 'accessibility'
      ? t('snap.accessibilityCopied', { app: targetAppName ?? '' })
      : insertFailure === 'target_unavailable'
        ? t('snap.targetUnavailable', { app: targetAppName ?? '' })
        : insertFailure === 'no_target'
          ? t('snap.noTarget')
          : insertFailure === 'failed'
            ? t('snap.insertFailed')
            : null;

  return (
    <div className="flex h-full w-full items-center justify-center p-4">
      <div className="snap-card flex h-full w-full flex-col overflow-hidden rounded-3xl border border-border shadow-elevated">
        <div className="snap-drag flex items-center gap-3 px-5 pb-2 pt-4">
          <img
            src={logoSrc}
            alt="GrowthOS"
            className="h-7 w-7 flex-shrink-0 rounded-lg object-contain"
            draggable={false}
          />
          <div className="min-w-0 flex-1">
            <h1 className="text-sm font-semibold text-text-primary">{t('snap.title')}</h1>
            <p className="truncate text-[11px] text-text-muted">
              {chatActive
                ? t('snap.chatSubtitle')
                : shortcutLabel
                  ? t('snap.subtitle', { shortcut: shortcutLabel })
                  : t('snap.subtitleNoShortcut')}
            </p>
          </div>
          {chatActive ? (
            <button
              type="button"
              className="snap-no-drag inline-flex items-center gap-1.5 rounded-xl border border-border px-2.5 py-1.5 text-xs text-text-secondary hover:border-accent/50 hover:text-text-primary disabled:opacity-40"
              onClick={openInGrowthOS}
              disabled={!chatSessionId}
            >
              <ExternalLink className="h-3.5 w-3.5" />
              {t('snap.openInGrowthOS')}
            </button>
          ) : null}
          <button
            type="button"
            className="snap-no-drag flex h-8 w-8 items-center justify-center rounded-xl text-text-muted hover:bg-surface-hover hover:text-text-primary"
            onClick={cancel}
            title={t('snap.close')}
            aria-label={t('snap.close')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {chatActive ? (
          <SnapChatView
            state={snapChat.state}
            sessionId={chatSessionId}
            onFollowUp={followUp}
            onOpenInGrowthOS={openInGrowthOS}
          />
        ) : (
          <>
            <div className="snap-no-drag px-5 pb-1">
              <div
                role="tablist"
                aria-label={t('snap.modeLabel')}
                className="grid grid-cols-2 gap-1 rounded-xl border border-border-subtle bg-surface p-1"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={!isWrite}
                  onClick={() => switchMode('chat')}
                  className={`flex items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium transition-colors ${
                    !isWrite
                      ? 'bg-accent text-white'
                      : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary'
                  }`}
                >
                  <MessageSquarePlus className="h-3.5 w-3.5" />
                  {t('snap.modeChat')}
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={isWrite}
                  disabled={!targetAppName}
                  title={targetAppName ? undefined : t('snap.modeWriteUnavailable')}
                  onClick={() => switchMode('write')}
                  className={`flex min-w-0 items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                    isWrite
                      ? 'bg-accent text-white'
                      : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary'
                  }`}
                >
                  <PenLine className="h-3.5 w-3.5 flex-shrink-0" />
                  <span className="truncate">
                    {targetAppName
                      ? t('snap.modeWrite', { app: targetAppName })
                      : t('snap.modeWriteGeneric')}
                  </span>
                </button>
              </div>
            </div>

            <div className="flex min-h-0 flex-1 flex-col gap-3 px-6 py-3">
              <div className="flex min-h-0 flex-1 items-center justify-center">
                {image ? (
                  <div
                    className={`snap-glow max-h-full max-w-full ${glowFast ? 'snap-glow--listening' : ''}`}
                  >
                    <img
                      src={`data:${image.mediaType};base64,${image.base64}`}
                      alt={t('snap.imageAlt')}
                      className={`block max-w-full rounded-[14px] bg-black/40 object-contain ${
                        showPreview ? 'max-h-[120px]' : 'max-h-[220px]'
                      }`}
                      draggable={false}
                    />
                  </div>
                ) : (
                  <Loader2 className="h-5 w-5 animate-spin text-text-muted" />
                )}
              </div>

              {showPreview ? (
                <div className="snap-no-drag flex flex-col gap-2">
                  <div className="relative">
                    <textarea
                      value={draft}
                      onChange={(e) => {
                        setDraft(e.target.value);
                        setInsertFailure(null);
                      }}
                      readOnly={isGenerating}
                      spellCheck={true}
                      rows={6}
                      placeholder={isGenerating ? t('snap.writeGenerating') : ''}
                      aria-label={t('snap.writePreviewLabel')}
                      className="max-h-48 min-h-[7rem] w-full resize-none rounded-2xl border border-accent/40 bg-surface px-3 py-2 text-sm text-text-primary outline-none focus:border-accent"
                    />
                    {isGenerating ? (
                      <Loader2 className="absolute right-3 top-2.5 h-3.5 w-3.5 animate-spin text-accent" />
                    ) : null}
                  </div>
                  {generateStatus === 'error' && generateError ? (
                    <p className="px-1 text-[11px] text-error">
                      {t('snap.writeFailed')} {generateError}
                    </p>
                  ) : null}
                  <div className="flex items-center gap-2">
                    {isGenerating ? (
                      <button
                        type="button"
                        onClick={stopGenerating}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-text-secondary hover:border-accent/50 hover:text-text-primary"
                      >
                        <Square className="h-3 w-3" />
                        {t('snap.stop')}
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void insert()}
                        disabled={!draft.trim() || isInserting}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
                        title="⌘↩"
                      >
                        {isInserting ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <CornerDownLeft className="h-3 w-3" />
                        )}
                        {targetAppName
                          ? t('snap.insertInto', { app: targetAppName })
                          : t('snap.insert')}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => void copyDraft()}
                      disabled={!draft.trim()}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-text-secondary hover:border-accent/50 hover:text-text-primary disabled:opacity-40"
                    >
                      {copied ? (
                        <Check className="h-3 w-3" />
                      ) : (
                        <ClipboardCopy className="h-3 w-3" />
                      )}
                      {copied ? t('snap.copied') : t('snap.copy')}
                    </button>
                    <button
                      type="button"
                      onClick={() => void generate()}
                      disabled={isGenerating}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-text-secondary hover:border-accent/50 hover:text-text-primary disabled:opacity-40"
                    >
                      <RefreshCw className="h-3 w-3" />
                      {t('snap.regenerate')}
                    </button>
                  </div>
                  {insertFailureMessage ? (
                    <div className="flex flex-wrap items-center gap-2 px-1 text-[11px] text-amber-600 dark:text-amber-400">
                      <span>{insertFailureMessage}</span>
                      {insertFailure === 'accessibility' ? (
                        <button
                          type="button"
                          onClick={() => void api?.snap.openAccessibilitySettings()}
                          className="underline hover:text-text-primary"
                        >
                          {t('snap.accessibilityOpenSettings')}
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>

            <div className="snap-no-drag px-4 pb-4">
              <div className="flex items-end gap-2 rounded-2xl border border-border-subtle bg-surface px-2 py-2">
                <textarea
                  ref={textareaRef}
                  value={prompt}
                  spellCheck={true}
                  onChange={(e) => setPrompt(e.target.value)}
                  onKeyDown={onKeyDownComposer}
                  rows={isWrite ? 1 : 2}
                  placeholder={isWrite ? t('snap.writePlaceholder') : t('snap.placeholder')}
                  className="max-h-28 min-h-[2.25rem] flex-1 resize-none bg-transparent px-2 py-1.5 text-sm text-text-primary outline-none placeholder:text-text-muted"
                  aria-label={isWrite ? t('snap.writePlaceholder') : t('snap.placeholder')}
                  autoFocus
                />
                <div className="flex flex-shrink-0 items-center gap-1 pb-0.5">
                  <DictationButton
                    status={dictation.status}
                    errorKind={dictation.errorKind}
                    disabled={!dictation.isAvailable || isSubmitting || isGenerating}
                    onToggle={dictation.toggle}
                  />
                  <button
                    type="button"
                    onClick={() => void (isWrite ? generate() : submitChat())}
                    disabled={!image || isSubmitting || isGenerating}
                    className="flex h-8 w-8 items-center justify-center rounded-xl bg-accent text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
                    title={isWrite ? t('snap.writeGenerate') : t('chat.sendMessage')}
                    aria-label={isWrite ? t('snap.writeGenerate') : t('chat.sendMessage')}
                  >
                    {isSubmitting || isGenerating ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <ArrowUp className="h-3.5 w-3.5" />
                    )}
                  </button>
                </div>
              </div>
              {isListening ? (
                <p className="mt-1.5 px-1 text-[11px] text-accent">
                  {t('chat.dictationListening')}
                </p>
              ) : null}
              {dictation.status === 'error' && dictation.errorKind ? (
                dictation.errorKind === 'client_outdated' ? (
                  <ClientOutdatedUpdateActions className="mt-2" />
                ) : (
                  <p className="mt-1.5 px-1 text-[11px] text-error">
                    {dictation.errorKind === 'mic_denied'
                      ? t('chat.dictationMicDenied')
                      : dictation.errorKind === 'sign_in'
                        ? t('chat.dictationSignInRequired')
                        : t('chat.dictationFailed')}
                  </p>
                )
              ) : null}
              {submitFailed ? (
                <p className="mt-1.5 px-1 text-[11px] text-error">{t('snap.submitFailed')}</p>
              ) : null}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
