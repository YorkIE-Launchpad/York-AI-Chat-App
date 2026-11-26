// MessageCard — top-level chat message renderer.
// Delegates block rendering to ContentBlockView and its sub-components.
import { useState, memo, useMemo, useRef, useLayoutEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, Check, Ban, RefreshCw, Pencil } from 'lucide-react';
import type { Message, ContentBlock, ToolUseContent, ToolResultContent } from '../types';
import { isClientOutdatedError } from '../../shared/client-version';
import { ContentBlockView } from './message/ContentBlockView';
import { McpSourcesFooter } from './message/McpSourcesFooter';
import { ToolStepsGroup } from './message/ToolStepsGroup';
import { ClientOutdatedUpdateActions } from './ClientOutdatedUpdateActions';
import { shouldShowMcpSourcesFooter } from '../utils/mcp-sources';
import { formatAppDateTime } from '../utils/i18n-format';

/** Keep images and files; replace every text block with one edited prompt. */
function contentWithEditedText(blocks: ContentBlock[], text: string): ContentBlock[] {
  let inserted = false;
  const next: ContentBlock[] = [];
  for (const block of blocks) {
    if (block.type === 'text') {
      if (!inserted) {
        next.push({ type: 'text', text });
        inserted = true;
      }
      continue;
    }
    next.push(block);
  }
  if (!inserted) {
    next.unshift({ type: 'text', text });
  }
  return next;
}

interface MessageCardProps {
  message: Message;
  isStreaming?: boolean;
  /** Full session messages — used for turn-aware MCP Sources fallback. */
  allMessages?: Message[];
  /** Shown on the last completed assistant message (Claude-style regenerate). */
  onRegenerate?: () => void;
  /** Shown on the last user prompt when the chat is idle. */
  onEditResend?: (content: ContentBlock[]) => void;
}

export const MessageCard = memo(function MessageCard({
  message,
  isStreaming,
  allMessages,
  onRegenerate,
  onEditResend,
}: MessageCardProps) {
  const { t } = useTranslation();
  const isUser = message.role === 'user';
  const isCancelled = message.localStatus === 'cancelled';
  const contentBlocks = useMemo((): ContentBlock[] => {
    const rawContent = message.content as unknown;
    const blocks = Array.isArray(rawContent)
      ? (rawContent as ContentBlock[])
      : [{ type: 'text', text: String(rawContent ?? '') } as ContentBlock];
    return blocks.filter(
      (block): block is ContentBlock =>
        Boolean(block) &&
        typeof block === 'object' &&
        typeof (block as ContentBlock).type === 'string'
    );
  }, [message.content]);
  const isMeetingTranscriptMessage = useMemo(
    () =>
      isUser &&
      contentBlocks.length > 0 &&
      contentBlocks.every((block) => block.type === 'meeting_transcript'),
    [contentBlocks, isUser]
  );
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const editRef = useRef<HTMLTextAreaElement>(null);
  const messageTimeLabel = useMemo(
    () => (message.timestamp ? formatAppDateTime(message.timestamp) : ''),
    [message.timestamp]
  );

  // Build a set of tool_result IDs that have a matching tool_use (for merging)
  const mergedResultIds = useMemo(() => {
    const ids = new Set<string>();
    for (const b of contentBlocks) {
      if (b.type === 'tool_use') {
        const tu = b as ToolUseContent;
        const result = contentBlocks.find(
          (r) => r.type === 'tool_result' && (r as ToolResultContent).toolUseId === tu.id
        );
        if (result) ids.add((result as ToolResultContent).toolUseId);
      }
    }
    return ids;
  }, [contentBlocks]);

  type Segment =
    | { kind: 'block'; block: ContentBlock; index: number }
    | { kind: 'steps'; blocks: ToolUseContent[] };
  // Runs of 2+ consecutive tool calls collapse into one summary line.
  const segments = useMemo((): Segment[] => {
    const out: Segment[] = [];
    let run: Array<{ block: ToolUseContent; index: number }> = [];
    const flush = () => {
      if (run.length >= 2) out.push({ kind: 'steps', blocks: run.map((r) => r.block) });
      else for (const r of run) out.push({ kind: 'block', block: r.block, index: r.index });
      run = [];
    };
    contentBlocks.forEach((block, index) => {
      if (
        block.type === 'tool_result' &&
        mergedResultIds.has((block as ToolResultContent).toolUseId)
      ) {
        return;
      }
      if (block.type === 'tool_use') {
        const name = (block as ToolUseContent).name;
        if (name !== 'AskUserQuestion' && name !== 'TodoWrite') {
          run.push({ block: block as ToolUseContent, index });
          return;
        }
      }
      if (block.type === 'text' && !(block as { text?: string }).text?.trim()) return;
      flush();
      out.push({ kind: 'block', block, index });
    });
    flush();
    return out;
  }, [contentBlocks, mergedResultIds]);

  const mcpSourcesFooter = useMemo(() => {
    if (isUser || !allMessages || allMessages.length === 0) {
      return { show: false as const, sources: [] };
    }
    return shouldShowMcpSourcesFooter({
      messages: allMessages,
      messageId: message.id,
      isStreaming,
    });
  }, [allMessages, isStreaming, isUser, message.id]);

  // Extract plain text for the clipboard (answer text only, not tools/thinking UI)
  const textToCopy = useMemo(
    () =>
      contentBlocks
        .filter((block) => block.type === 'text')
        .map((block) => (block as { type: 'text'; text: string }).text.trim())
        .filter(Boolean)
        .join('\n\n'),
    [contentBlocks]
  );
  const editableText = useMemo(
    () =>
      contentBlocks
        .filter((block) => block.type === 'text')
        .map((block) => (block as { type: 'text'; text: string }).text)
        .join('\n\n'),
    [contentBlocks]
  );
  const canSaveEdit = draft.trim().length > 0 && draft.trim() !== editableText.trim();

  useLayoutEffect(() => {
    const el = editRef.current;
    if (!editing || !el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [editing, draft]);

  useLayoutEffect(() => {
    if (!editing) return;
    const el = editRef.current;
    if (!el) return;
    el.focus();
    const end = el.value.length;
    el.setSelectionRange(end, end);
  }, [editing]);

  const startEditing = () => {
    setDraft(editableText);
    setEditing(true);
  };

  const cancelEditing = () => {
    setEditing(false);
    setDraft('');
  };

  const saveAndResend = () => {
    if (!onEditResend || !canSaveEdit) return;
    onEditResend(contentWithEditedText(contentBlocks, draft.trim()));
    setEditing(false);
  };

  const showClientOutdatedUpdate = useMemo(
    () => !isUser && !isStreaming && isClientOutdatedError(textToCopy),
    [isStreaming, isUser, textToCopy]
  );

  const handleCopy = async () => {
    if (!textToCopy) return;
    try {
      await navigator.clipboard.writeText(textToCopy);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable
    }
  };

  const copyButton = (className: string) => (
    <button
      type="button"
      onClick={() => void handleCopy()}
      className={className}
      title={copied ? t('messageCard.copied') : t('messageCard.copyMessage')}
      aria-label={copied ? t('messageCard.copied') : t('messageCard.copyMessage')}
    >
      {copied ? (
        <Check className="w-3.5 h-3.5 text-success" aria-hidden />
      ) : (
        <Copy className="w-3.5 h-3.5 text-text-muted" aria-hidden />
      )}
    </button>
  );

  return (
    <div className="min-w-0 max-w-full animate-fade-in">
      {isUser && isMeetingTranscriptMessage ? (
        <div className="flex min-w-0 max-w-full flex-col items-start gap-1.5">
          {message.authorName ? (
            <span className="px-1 text-[11px] font-medium text-text-secondary">
              {message.authorName}
            </span>
          ) : null}
          {contentBlocks.map((block, index) => (
            <ContentBlockView
              key={`block-${block.type}-${index}`}
              block={block}
              isUser={false}
              isStreaming={isStreaming}
            />
          ))}
        </div>
      ) : isUser ? (
        // User message - compact styling with smaller padding and radius
        <div className="flex min-w-0 max-w-full flex-col items-end gap-1.5">
          {message.authorName ? (
            <span className="px-1 text-[11px] font-medium text-text-secondary">
              {message.authorName}
            </span>
          ) : null}
          {isCancelled && (
            <div className="inline-flex items-center gap-1.5 rounded-full bg-surface-muted px-2.5 py-1 text-[11px] font-medium text-text-muted">
              <Ban className="w-3 h-3 shrink-0" aria-hidden />
              <span>{t('messageCard.cancelledNotSent')}</span>
            </div>
          )}
          <div className="flex min-w-0 max-w-full flex-col items-end gap-1 group/message">
            <div className="flex min-w-0 max-w-full items-start justify-end gap-2">
              <div
                className={`message-user min-w-0 break-words px-3.5 py-2.5 ${
                  editing ? '!w-[min(28rem,70vw)] !max-w-full' : 'w-fit max-w-[90%]'
                } ${isCancelled ? 'opacity-55' : ''}`}
                aria-label={isCancelled ? t('messageCard.cancelledAria') : undefined}
              >
                {editing ? (
                  <div>
                    <textarea
                      ref={editRef}
                      value={draft}
                      rows={1}
                      onChange={(event) => setDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Escape') {
                          event.preventDefault();
                          cancelEditing();
                          return;
                        }
                        if (event.key === 'Enter' && !event.shiftKey) {
                          event.preventDefault();
                          saveAndResend();
                        }
                      }}
                      aria-label={t('messageCard.editPrompt')}
                      className="max-h-64 w-full resize-none overflow-y-auto bg-transparent text-[14px] leading-[1.55] text-inherit outline-none"
                    />
                    <div className="mt-2 flex items-center justify-end gap-1.5">
                      <button
                        type="button"
                        onClick={cancelEditing}
                        className="inline-flex h-7 items-center rounded-full px-2.5 text-[12px] text-text-muted hover:bg-surface-muted hover:text-text-secondary"
                      >
                        {t('messageCard.cancelEdit')}
                      </button>
                      <button
                        type="button"
                        onClick={saveAndResend}
                        disabled={!canSaveEdit}
                        className="inline-flex h-7 items-center rounded-full bg-accent px-2.5 text-[12px] text-white hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        {t('messageCard.saveAndSend')}
                      </button>
                    </div>
                  </div>
                ) : contentBlocks.length === 0 ? (
                  <span className="text-text-muted italic">{t('messageCard.emptyMessage')}</span>
                ) : (
                  <div
                    className={`space-y-2 ${isCancelled ? 'line-through decoration-text-muted/50' : ''}`}
                  >
                    {contentBlocks.map((block, index) => (
                      <ContentBlockView
                        key={
                          'id' in block
                            ? (block as { id: string }).id
                            : `block-${block.type}-${index}`
                        }
                        block={block}
                        isUser={isUser}
                        isStreaming={isStreaming}
                      />
                    ))}
                  </div>
                )}
              </div>
              {!editing && (onEditResend || textToCopy) ? (
                <div className="mt-1 flex flex-col gap-1 opacity-0 transition-all group-hover/message:opacity-100 focus-within:opacity-100">
                  {onEditResend ? (
                    <button
                      type="button"
                      onClick={startEditing}
                      className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md bg-surface-muted hover:bg-surface-active"
                      title={t('messageCard.editPrompt')}
                      aria-label={t('messageCard.editPrompt')}
                    >
                      <Pencil className="h-3.5 w-3.5 text-text-muted" aria-hidden />
                    </button>
                  ) : null}
                  {textToCopy
                    ? copyButton(
                        'w-7 h-7 flex items-center justify-center rounded-md bg-surface-muted hover:bg-surface-active flex-shrink-0'
                      )
                    : null}
                </div>
              ) : null}
            </div>
            <div className="flex items-center gap-1">
              {messageTimeLabel ? (
                <span className="px-1 text-[11px] text-text-muted" title={messageTimeLabel}>
                  {messageTimeLabel}
                </span>
              ) : null}
            </div>
          </div>
        </div>
      ) : (
        // Assistant message — no bubble, direct content + copy like ChatGPT/Claude
        <div className="group/assistant min-w-0 max-w-full space-y-1.5">
          {segments.map((segment) => {
            if (segment.kind === 'steps') {
              return (
                <ToolStepsGroup
                  key={`steps-${segment.blocks[0].id}`}
                  blocks={segment.blocks}
                  allBlocks={contentBlocks}
                  message={message}
                />
              );
            }
            const { block, index } = segment;
            return (
              <ContentBlockView
                key={'id' in block ? (block as { id: string }).id : `block-${block.type}-${index}`}
                block={block}
                isUser={isUser}
                isStreaming={isStreaming}
                allBlocks={contentBlocks}
                message={message}
              />
            );
          })}
          {mcpSourcesFooter.show && <McpSourcesFooter sources={mcpSourcesFooter.sources} />}
          {showClientOutdatedUpdate ? (
            <ClientOutdatedUpdateActions className="mt-2 max-w-md" />
          ) : null}
          {textToCopy && !isStreaming ? (
            <div className="flex items-center gap-1 pt-1 -ml-1.5">
              {copyButton(
                'inline-flex items-center justify-center gap-1.5 h-8 min-w-8 px-2 rounded-lg text-text-muted hover:text-text-secondary hover:bg-surface-muted transition-colors'
              )}
              {onRegenerate ? (
                <button
                  type="button"
                  onClick={onRegenerate}
                  className="inline-flex items-center justify-center gap-1.5 h-8 min-w-8 px-2 rounded-lg text-text-muted hover:text-text-secondary hover:bg-surface-muted transition-colors"
                  title={t('messageCard.regenerate')}
                  aria-label={t('messageCard.regenerate')}
                >
                  <RefreshCw className="w-3.5 h-3.5 text-text-muted" aria-hidden />
                </button>
              ) : null}
              {messageTimeLabel ? (
                <span className="ml-1 text-[11px] text-text-muted" title={messageTimeLabel}>
                  {messageTimeLabel}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
});
