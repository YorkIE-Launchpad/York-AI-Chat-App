// Dispatches a single ContentBlock to the appropriate sub-renderer
import { Suspense, lazy, isValidElement, cloneElement, memo, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../store';
import { PanelErrorBoundary } from '../PanelErrorBoundary';
import {
  splitTextByFileMentions,
  splitChildrenByFileMentions,
  getFileLinkButtonClassName,
} from '../../utils/file-link';
import { resolvePathAgainstWorkspace } from '../../../shared/workspace-path';
import {
  DEFAULT_JIRA_SITE_ORIGIN,
  isJiraRestApiUrl,
  jiraBrowseUrl,
  normalizeJiraSourceUrl,
} from '../../../shared/jira-urls';
import {
  normalizeLocalFileMarkdownLinks,
  resolveLocalFilePathFromHref,
} from '../../utils/markdown-local-link';
import { normalizeLatexDelimiters } from '../../utils/latex-delimiters';
import { parseMemoryHref } from '../../utils/memory-cite-link';
import { AUTO_TEXT_DIRECTION_PROPS } from '../../utils/text-direction';
import type {
  ToolUseContent,
  ToolResultContent,
  FileAttachmentContent,
  MeetingAttachmentContent,
  ExternalReferenceContent,
} from '../../types';
import { Mic } from 'lucide-react';
import { CodeBlock } from './CodeBlock';
import { ThinkingBlock, escapeThinkTags } from './ThinkingBlock';
import { ToolUseBlock } from './ToolUseBlock';
import { ToolResultBlock } from './ToolResultBlock';
import type { ContentBlockViewProps } from './types';
import { AttachmentImageThumb, ExternalReferenceChip } from '../attachments';
import { ALLOWED_IMAGE_MIME_TYPES } from '../../utils/attachment-preview';
import { FileAttachmentBlock } from './FileAttachmentBlock';
import { MemorySourceDetailPanel } from './MemorySourceDetailPanel';

const MessageMarkdown = lazy(() =>
  import('../MessageMarkdown').then((module) => ({ default: module.MessageMarkdown }))
);

// Cowork citation guidance can emit ~[Title](url)~ markers.
// Render them as regular links instead of strikethrough links.
function normalizeCitationMarkdownLinks(markdown: string): string {
  return markdown.replace(/~\[(.+?)\]\(([^)\s]+)\)~/g, '[$1]($2)');
}

function flattenReactText(node: React.ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(flattenReactText).join('');
  if (isValidElement(node)) {
    const props = node.props as { children?: React.ReactNode };
    return flattenReactText(props.children);
  }
  return '';
}

export const ContentBlockView = memo(function ContentBlockView({
  block,
  isUser,
  isStreaming,
  allBlocks,
  message,
}: ContentBlockViewProps) {
  const { t } = useTranslation();
  const [memorySourceId, setMemorySourceId] = useState<string | null>(null);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const sessions = useAppStore((s) => s.sessions);
  const workingDir = useAppStore((s) => s.workingDir);
  const setGlobalNotice = useAppStore((s) => s.setGlobalNotice);
  const messageSession = message?.sessionId
    ? sessions.find((s) => s.id === message.sessionId)
    : null;
  const activeSession = activeSessionId ? sessions.find((s) => s.id === activeSessionId) : null;
  // Prefer the message's own session cwd so file links open the chat workspace,
  // not a stale/global default_working_dir.
  const currentWorkingDir = messageSession?.cwd || activeSession?.cwd || workingDir;

  const resolveFilePath = (value: string) => resolvePathAgainstWorkspace(value, currentWorkingDir);

  const renderFileButton = (value: string, key?: string) => (
    <button
      key={key}
      type="button"
      onClick={async () => {
        if (typeof window === 'undefined' || !window.electronAPI?.showItemInFolder) {
          return;
        }
        const resolvedPath = resolveFilePath(value);
        try {
          const revealed = await window.electronAPI.showItemInFolder(
            resolvedPath,
            currentWorkingDir ?? undefined
          );
          if (!revealed) {
            setGlobalNotice({
              id: `message-card-reveal-failed-${Date.now()}`,
              type: 'warning',
              message: t('context.revealFailed'),
            });
          }
        } catch (error) {
          setGlobalNotice({
            id: `message-card-reveal-failed-${Date.now()}`,
            type: 'warning',
            message:
              error instanceof Error && error.message ? error.message : t('context.revealFailed'),
          });
        }
      }}
      className={getFileLinkButtonClassName()}
      title={resolveFilePath(value)}
    >
      {value}
    </button>
  );

  const renderFileMentionParts = (
    parts: ReturnType<typeof splitChildrenByFileMentions>,
    keyPrefix: string
  ) =>
    parts.map((part, partIndex) => {
      const key = `${keyPrefix}-${partIndex}`;
      if (part.type === 'file') {
        return renderFileButton(part.value, key);
      }
      if (part.type === 'text') {
        return <span key={key}>{part.value}</span>;
      }
      if (isValidElement(part.value)) {
        return part.value.key ? part.value : cloneElement(part.value, { key });
      }
      return <span key={key}>{String(part.value)}</span>;
    });

  const renderChildrenWithFileLinks = (children: unknown, keyPrefix: string) => {
    const normalized = Array.isArray(children) ? children : [children];
    const parts = splitChildrenByFileMentions(normalized);
    return renderFileMentionParts(parts, keyPrefix);
  };

  const markdownComponents = useMemo(
    () => ({
      a({ children, href }: { children?: React.ReactNode; href?: string }) {
        const memoryId = parseMemoryHref(href);
        if (memoryId) {
          return (
            <button
              type="button"
              onClick={() => setMemorySourceId(memoryId)}
              className={getFileLinkButtonClassName()}
              title={memoryId}
            >
              {children}
            </button>
          );
        }

        const localFilePath = resolveLocalFilePathFromHref(href, currentWorkingDir);
        if (localFilePath) {
          return (
            <button
              type="button"
              onClick={async () => {
                if (typeof window === 'undefined' || !window.electronAPI?.showItemInFolder) {
                  return;
                }
                try {
                  const revealed = await window.electronAPI.showItemInFolder(
                    localFilePath,
                    currentWorkingDir ?? undefined
                  );
                  if (!revealed) {
                    setGlobalNotice({
                      id: `message-card-reveal-failed-${Date.now()}`,
                      type: 'warning',
                      message: t('context.revealFailed'),
                    });
                  }
                } catch (error) {
                  setGlobalNotice({
                    id: `message-card-reveal-failed-${Date.now()}`,
                    type: 'warning',
                    message:
                      error instanceof Error && error.message
                        ? error.message
                        : t('context.revealFailed'),
                  });
                }
              }}
              className={getFileLinkButtonClassName()}
              title={localFilePath}
            >
              {children}
            </button>
          );
        }

        const safeHref = href && /^(?:https?:|mailto:)/i.test(href) ? href : undefined;
        if (!safeHref) {
          // Non-openable hrefs (invented memory URLs, junk schemes, bare fragments)
          // should not look clickable.
          return <span>{children}</span>;
        }

        const openHref = (() => {
          if (!isJiraRestApiUrl(safeHref)) return safeHref;
          const labelText = flattenReactText(children);
          const keyFromLabel = labelText.match(/\b([A-Z][A-Z0-9]+-\d+)\b/i)?.[1];
          return (
            normalizeJiraSourceUrl(safeHref, { issueKey: keyFromLabel }) ||
            (keyFromLabel ? jiraBrowseUrl(keyFromLabel, DEFAULT_JIRA_SITE_ORIGIN) : safeHref)
          );
        })();

        return (
          <a
            href={openHref}
            rel="noreferrer"
            onClick={(event) => {
              event.preventDefault();
              if (typeof window !== 'undefined' && window.electronAPI?.openExternal) {
                void window.electronAPI.openExternal(openHref);
              }
            }}
            className="text-accent hover:text-accent-hover"
          >
            {children}
          </a>
        );
      },
      blockquote({ children }: { children?: React.ReactNode }) {
        return (
          <blockquote className="border-l-2 border-accent/40 pl-4 text-text-muted">
            {children}
          </blockquote>
        );
      },
      code({ className, children, ...props }: { className?: string; children?: React.ReactNode }) {
        const match = /language-([\w+#.-]+)/.exec(className || '');
        const isInline = !match;

        if (isInline) {
          const raw = String(children);
          const parts = splitTextByFileMentions(raw);
          if (parts.length === 1 && parts[0]?.type === 'file') {
            return renderFileButton(parts[0].value);
          }
          return (
            <code
              className="px-1.5 py-0.5 rounded bg-surface-muted text-accent font-mono text-sm"
              {...props}
            >
              {children}
            </code>
          );
        }

        return <CodeBlock language={match[1]}>{String(children).replace(/\n$/, '')}</CodeBlock>;
      },
      p({ children }: { children?: React.ReactNode }) {
        return (
          <p {...AUTO_TEXT_DIRECTION_PROPS} className="text-start">
            {renderChildrenWithFileLinks(children, 'p')}
          </p>
        );
      },
      li({ children }: { children?: React.ReactNode }) {
        return (
          <li {...AUTO_TEXT_DIRECTION_PROPS} className="text-start">
            {renderChildrenWithFileLinks(children, 'li')}
          </li>
        );
      },
      table({ children }: { children?: React.ReactNode }) {
        return (
          <div className="overflow-x-auto my-3">
            <table className="min-w-full border-collapse">{children}</table>
          </div>
        );
      },
      th({ children, style }: { children?: React.ReactNode; style?: React.CSSProperties }) {
        return (
          <th
            className="border border-border px-3 py-2 text-sm font-semibold text-text-primary bg-surface-muted"
            style={style}
          >
            {children}
          </th>
        );
      },
      td({ children, style }: { children?: React.ReactNode; style?: React.CSSProperties }) {
        return (
          <td className="border border-border px-3 py-2 text-sm text-text-primary" style={style}>
            {children}
          </td>
        );
      },
      input({ checked, ...props }: { checked?: boolean }) {
        return (
          <input
            type="checkbox"
            checked={checked}
            readOnly
            className="mr-2 accent-accent"
            {...props}
          />
        );
      },
      strong({ children }: { children?: React.ReactNode }) {
        return <strong>{renderChildrenWithFileLinks(children, 'strong')}</strong>;
      },
      em({ children }: { children?: React.ReactNode }) {
        return <em>{renderChildrenWithFileLinks(children, 'em')}</em>;
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [currentWorkingDir, setGlobalNotice, t]
  );

  switch (block.type) {
    case 'text': {
      const textBlock = block as { type: 'text'; text: string };
      const text = textBlock.text || '';
      const normalizedText = normalizeCitationMarkdownLinks(
        normalizeLocalFileMarkdownLinks(normalizeLatexDelimiters(text))
      );

      if (!text) {
        return <span className="text-text-muted italic">{t('messageCard.emptyText')}</span>;
      }

      // Simple text display for user messages, Markdown for assistant
      if (isUser) {
        return (
          <p
            {...AUTO_TEXT_DIRECTION_PROPS}
            className="text-start text-text-primary whitespace-pre-wrap break-words break-anywhere"
          >
            {text}
            {isStreaming && <span className="inline-block w-2 h-4 bg-accent ml-1 animate-pulse" />}
          </p>
        );
      }

      return (
        <>
          <PanelErrorBoundary
            name="MessageMarkdown"
            fallback={
              <div
                {...AUTO_TEXT_DIRECTION_PROPS}
                className="prose-chat max-w-none text-text-primary whitespace-pre-wrap break-words text-start"
              >
                {normalizedText}
              </div>
            }
          >
            <Suspense
              fallback={
                <div
                  {...AUTO_TEXT_DIRECTION_PROPS}
                  className="prose-chat max-w-none text-text-primary whitespace-pre-wrap break-words text-start"
                >
                  {normalizedText}
                </div>
              }
            >
              <MessageMarkdown
                normalizedText={escapeThinkTags(normalizedText)}
                isStreaming={isStreaming}
                components={markdownComponents}
              />
            </Suspense>
          </PanelErrorBoundary>
          {memorySourceId && (
            <MemorySourceDetailPanel
              memoryId={memorySourceId}
              onClose={() => setMemorySourceId(null)}
            />
          )}
        </>
      );
    }

    case 'image': {
      const imageBlock = block as {
        type: 'image';
        source: { type: 'base64'; media_type: string; data: string };
      };
      if (!imageBlock.source?.media_type || !imageBlock.source?.data) {
        return null;
      }
      if (!ALLOWED_IMAGE_MIME_TYPES.has(imageBlock.source.media_type)) {
        return null;
      }
      const { source } = imageBlock;
      const imageSrc = `data:${source.media_type};base64,${source.data}`;

      return (
        <div className={`${isUser ? 'inline-block' : ''}`}>
          <AttachmentImageThumb src={imageSrc} alt={t('messageCard.pastedContentAlt')} />
        </div>
      );
    }

    case 'file_attachment': {
      const fileBlock = block as FileAttachmentContent;
      return <FileAttachmentBlock block={fileBlock} isUser={isUser} message={message} />;
    }

    case 'meeting_attachment': {
      const meetingBlock = block as MeetingAttachmentContent;
      return (
        <div className="flex max-w-full min-w-0 items-center gap-2 px-3 py-2 rounded-lg bg-surface-muted border border-border overflow-hidden">
          <Mic className="w-4 h-4 text-accent flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm text-text-primary truncate">{meetingBlock.title}</p>
            <p className="text-[11px] text-text-muted truncate">
              {meetingBlock.includeTranscript ? 'Notes + transcript' : 'Notes'}
            </p>
          </div>
        </div>
      );
    }

    case 'external_reference': {
      return <ExternalReferenceChip reference={block as ExternalReferenceContent} />;
    }

    case 'tool_use':
      return (
        <ToolUseBlock block={block as ToolUseContent} allBlocks={allBlocks} message={message} />
      );

    case 'tool_result':
      return (
        <ToolResultBlock
          block={block as ToolResultContent}
          allBlocks={allBlocks}
          message={message}
        />
      );

    case 'thinking':
      return (
        <ThinkingBlock
          block={block as { type: 'thinking'; thinking: string }}
          isStreaming={isStreaming}
        />
      );

    default:
      return null;
  }
});
