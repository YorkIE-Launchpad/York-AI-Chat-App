import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowUp, ExternalLink, Loader2, ShieldQuestion, Square, Wrench } from 'lucide-react';
import { MessageMarkdown } from '../MessageMarkdown';
import { DictationButton } from '../DictationButton';
import { ModelSelector } from '../ModelSelector';
import { SnapModelErrorCard } from './SnapModelErrorCard';
import { useDictation } from '../../hooks/useDictation';
import type { SnapChatState } from '../../hooks/useSnapChat';
import type { ContentBlock, Message, PermissionResult } from '../../types';
import { SESSION_ERROR_PREFIX } from '../../../shared/screen-snap';

interface SnapChatViewProps {
  state: SnapChatState;
  sessionId: string | null;
  onFollowUp: (text: string) => Promise<void>;
  onOpenInGrowthOS: () => void;
  /** Re-run the snap prompt in a fresh session (e.g. after switching model). */
  onRetry?: () => void;
  retrying?: boolean;
}

function textOf(content: ContentBlock[]): string {
  return content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('\n\n')
    .trim();
}

function imageOf(content: ContentBlock[]): string | null {
  const image = content.find(
    (block): block is Extract<ContentBlock, { type: 'image' }> => block.type === 'image'
  );
  return image ? `data:${image.source.media_type};base64,${image.source.data}` : null;
}

function toolNamesOf(content: ContentBlock[]): string[] {
  return content
    .filter(
      (block): block is Extract<ContentBlock, { type: 'tool_use' }> => block.type === 'tool_use'
    )
    .map((block) => block.displayName || block.name);
}

function ChatMessage({
  message,
  glow,
  onRetry,
  retrying,
}: {
  message: Message;
  glow: boolean;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  const { t } = useTranslation();
  const text = textOf(message.content);

  if (message.role === 'user') {
    if (message.content.every((block) => block.type === 'tool_result')) return null;
    const image = imageOf(message.content);
    return (
      <div className="flex flex-col items-end gap-1.5">
        {image ? (
          <div className={`snap-glow max-w-[60%] ${glow ? 'snap-glow--listening' : ''}`}>
            <img
              src={image}
              alt={t('snap.imageAlt')}
              className="block max-h-24 rounded-[14px] object-contain"
              draggable={false}
            />
          </div>
        ) : null}
        {text ? (
          <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-accent px-3 py-2 text-sm text-white">
            {text}
          </div>
        ) : null}
      </div>
    );
  }

  if (message.role !== 'assistant') return null;
  if (text.startsWith(SESSION_ERROR_PREFIX)) {
    return <SnapModelErrorCard message={text} onRetry={onRetry} retrying={retrying} />;
  }
  const tools = toolNamesOf(message.content);
  return (
    <div className="flex flex-col gap-1.5">
      {tools.map((name, index) => (
        <div
          key={`${name}-${index}`}
          className="flex items-center gap-1.5 text-[11px] text-text-muted"
        >
          <Wrench className="h-3 w-3" />
          {t('snap.usedTool', { tool: name })}
        </div>
      ))}
      {text ? (
        <div className="text-sm text-text-primary">
          <MessageMarkdown normalizedText={text} />
        </div>
      ) : null}
    </div>
  );
}

export function SnapChatView({
  state,
  sessionId,
  onFollowUp,
  onOpenInGrowthOS,
  onRetry,
  retrying,
}: SnapChatViewProps) {
  const { t } = useTranslation();
  const api = window.electronAPI;
  const [draft, setDraft] = useState('');
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const isRunning = state.status === 'running' || state.status === 'starting';
  const lastMessageIndex = state.messages.length - 1;
  const lastMessage = state.messages[lastMessageIndex];
  const lastMessageIsError =
    lastMessage?.role === 'assistant' &&
    textOf(lastMessage.content).startsWith(SESSION_ERROR_PREFIX);
  // Restarting only makes sense while the chat is still just the snap prompt.
  const hasFollowUps =
    state.messages.filter(
      (message) =>
        message.role === 'user' && !message.content.every((block) => block.type === 'tool_result')
    ).length > 1;

  const dictation = useDictation({
    enabled: Boolean(api?.snap),
    onTranscript: (text) => setDraft(text),
    getPrompt: () => draftRef.current,
  });

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.messages, state.partial, state.activeTool, state.permission, state.question]);

  useEffect(() => {
    if (!isRunning) inputRef.current?.focus();
  }, [isRunning]);

  const send = async () => {
    const text = draftRef.current.trim();
    if (!text || isRunning || !sessionId) return;
    dictation.stop();
    setDraft('');
    await onFollowUp(text);
  };

  const stop = () => {
    if (sessionId) api?.send({ type: 'session.stop', payload: { sessionId } });
  };

  const respondPermission = (result: PermissionResult) => {
    if (!state.permission) return;
    api?.send({
      type: 'permission.response',
      payload: { toolUseId: state.permission.toolUseId, result },
    });
  };

  const answerQuestion = (label: string) => {
    if (!state.question) return;
    api?.send({
      type: 'question.response',
      payload: { questionId: state.question.questionId, answer: JSON.stringify({ 0: [label] }) },
    });
  };

  const firstQuestion = state.question?.questions[0];
  const singleQuestion =
    state.question?.questions.length === 1 &&
    firstQuestion &&
    !firstQuestion.multiSelect &&
    (firstQuestion.options?.length ?? 0) > 0
      ? firstQuestion
      : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        className="snap-no-drag min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-3"
      >
        {state.messages.map((message, index) => (
          <ChatMessage
            key={message.id}
            message={message}
            glow={isRunning}
            onRetry={
              index === lastMessageIndex && !isRunning && !hasFollowUps ? onRetry : undefined
            }
            retrying={retrying}
          />
        ))}

        {state.partial ? (
          <div className="text-sm text-text-primary">
            <MessageMarkdown normalizedText={state.partial} isStreaming />
          </div>
        ) : null}

        {state.activeTool ? (
          <div className="flex items-center gap-1.5 text-[11px] text-text-muted">
            <Loader2 className="h-3 w-3 animate-spin" />
            {t('snap.usingTool', { tool: state.activeTool.name })}
          </div>
        ) : isRunning && !state.partial ? (
          <div className="flex items-center gap-1.5 text-[11px] text-text-muted">
            <Loader2 className="h-3 w-3 animate-spin" />
            {t('snap.thinking')}
          </div>
        ) : null}

        {state.permission ? (
          <div className="rounded-2xl border border-accent/40 bg-surface p-3">
            <div className="mb-2 flex items-center gap-2 text-xs font-medium text-text-primary">
              <ShieldQuestion className="h-4 w-4 text-accent" />
              {t('snap.permissionTitle', { tool: state.permission.toolName })}
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => respondPermission('allow')}
                className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white"
              >
                {t('snap.permissionAllow')}
              </button>
              <button
                type="button"
                onClick={() => respondPermission('allow_always')}
                className="rounded-lg border border-border px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary"
              >
                {t('snap.permissionAlways')}
              </button>
              <button
                type="button"
                onClick={() => respondPermission('deny')}
                className="rounded-lg border border-border px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary"
              >
                {t('snap.permissionDeny')}
              </button>
            </div>
          </div>
        ) : null}

        {state.question ? (
          <div className="rounded-2xl border border-accent/40 bg-surface p-3">
            {singleQuestion ? (
              <>
                <p className="mb-2 text-xs font-medium text-text-primary">
                  {singleQuestion.question}
                </p>
                <div className="flex flex-wrap gap-2">
                  {(singleQuestion.options ?? []).map((option) => (
                    <button
                      key={option.label}
                      type="button"
                      onClick={() => answerQuestion(option.label)}
                      title={option.description}
                      className={`rounded-lg px-3 py-1.5 text-xs ${
                        option.recommended
                          ? 'bg-accent font-medium text-white'
                          : 'border border-border text-text-secondary hover:text-text-primary'
                      }`}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <div className="flex items-center justify-between gap-2 text-xs text-text-secondary">
                <span>{t('snap.questionInGrowthOS')}</span>
                <button
                  type="button"
                  onClick={onOpenInGrowthOS}
                  className="rounded-lg bg-accent px-3 py-1.5 font-medium text-white"
                >
                  {t('snap.answerInGrowthOS')}
                </button>
              </div>
            )}
          </div>
        ) : null}

        {state.status === 'error' && state.error && !lastMessageIsError ? (
          <SnapModelErrorCard
            message={state.error}
            onRetry={hasFollowUps ? undefined : onRetry}
            retrying={retrying}
          />
        ) : null}
      </div>

      <div className="snap-no-drag px-4 pb-3 pt-1">
        <div className="flex items-end gap-2 rounded-2xl border border-border-subtle bg-surface px-2 py-2">
          <textarea
            ref={inputRef}
            value={draft}
            spellCheck={true}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
            rows={1}
            placeholder={t('snap.followUpPlaceholder')}
            aria-label={t('snap.followUpPlaceholder')}
            className="max-h-28 min-h-[2.25rem] flex-1 resize-none bg-transparent px-2 py-1.5 text-sm text-text-primary outline-none placeholder:text-text-muted"
          />
          <div className="flex flex-shrink-0 items-center gap-1 pb-0.5">
            <ModelSelector />
            <DictationButton
              status={dictation.status}
              errorKind={dictation.errorKind}
              disabled={!dictation.isAvailable || isRunning}
              onToggle={dictation.toggle}
            />
            {isRunning ? (
              <button
                type="button"
                onClick={stop}
                className="flex h-8 w-8 items-center justify-center rounded-xl border border-border text-text-secondary hover:text-text-primary"
                title={t('snap.stop')}
                aria-label={t('snap.stop')}
              >
                <Square className="h-3.5 w-3.5" />
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void send()}
                disabled={!draft.trim() || !sessionId}
                className="flex h-8 w-8 items-center justify-center rounded-xl bg-accent text-white disabled:cursor-not-allowed disabled:opacity-40"
                title={t('chat.sendMessage')}
                aria-label={t('chat.sendMessage')}
              >
                <ArrowUp className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
        <div className="mt-1.5 flex items-center justify-between px-1 text-[11px] text-text-muted">
          <span>{t('snap.savedToGrowthOS')}</span>
          <button
            type="button"
            onClick={onOpenInGrowthOS}
            disabled={!sessionId}
            className="inline-flex items-center gap-1 hover:text-text-primary disabled:opacity-40"
          >
            <ExternalLink className="h-3 w-3" />
            {t('snap.openInGrowthOS')}
          </button>
        </div>
      </div>
    </div>
  );
}
