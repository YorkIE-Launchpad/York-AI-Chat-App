// MessageCard — top-level chat message renderer.
// Delegates block rendering to ContentBlockView and its sub-components.
import { useState, memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, Check, Ban } from 'lucide-react';
import type { Message, ContentBlock, ToolUseContent, ToolResultContent } from '../types';
import { isClientOutdatedError } from '../../shared/client-version';
import { ContentBlockView } from './message/ContentBlockView';
import { McpSourcesFooter } from './message/McpSourcesFooter';
import { ClientOutdatedUpdateActions } from './ClientOutdatedUpdateActions';
import { shouldShowMcpSourcesFooter } from '../utils/mcp-sources';

interface MessageCardProps {
  message: Message;
  isStreaming?: boolean;
  /** Full session messages — used for turn-aware MCP Sources fallback. */
  allMessages?: Message[];
}

export const MessageCard = memo(function MessageCard({
  message,
  isStreaming,
  allMessages,
}: MessageCardProps) {
  const { t } = useTranslation();
  const isUser = message.role === 'user';
  const isCancelled = message.localStatus === 'cancelled';
  const contentBlocks = useMemo((): ContentBlock[] => {
    const rawContent = message.content as unknown;
    return Array.isArray(rawContent)
      ? (rawContent as ContentBlock[])
      : [{ type: 'text', text: String(rawContent ?? '') } as ContentBlock];
  }, [message.content]);
  const isMeetingTranscriptMessage = useMemo(
    () =>
      isUser &&
      contentBlocks.length > 0 &&
      contentBlocks.every((block) => block.type === 'meeting_transcript'),
    [contentBlocks, isUser]
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
          {isCancelled && (
            <div className="inline-flex items-center gap-1.5 rounded-full bg-surface-muted px-2.5 py-1 text-[11px] font-medium text-text-muted">
              <Ban className="w-3 h-3 shrink-0" aria-hidden />
              <span>{t('messageCard.cancelledNotSent')}</span>
            </div>
          )}
          <div className="flex min-w-0 max-w-full items-start justify-end gap-2 group">
            <div
              className={`message-user min-w-0 w-fit max-w-[90%] break-words px-4 py-3 rounded-[1.65rem] ${
                isCancelled ? 'opacity-55' : ''
              }`}
              aria-label={isCancelled ? t('messageCard.cancelledAria') : undefined}
            >
              {contentBlocks.length === 0 ? (
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
            {textToCopy
              ? copyButton(
                  'mt-1 w-7 h-7 flex items-center justify-center rounded-md bg-surface-muted hover:bg-surface-active transition-all opacity-0 group-hover:opacity-100 focus-visible:opacity-100 flex-shrink-0'
                )
              : null}
          </div>
        </div>
      ) : (
        // Assistant message — no bubble, direct content + copy like ChatGPT/Claude
        <div className="group/assistant min-w-0 max-w-full space-y-1.5">
          {contentBlocks.map((block, index) => {
            // Skip tool_result blocks that are merged into their tool_use card
            if (
              block.type === 'tool_result' &&
              mergedResultIds.has((block as ToolResultContent).toolUseId)
            ) {
              return null;
            }
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
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
});
