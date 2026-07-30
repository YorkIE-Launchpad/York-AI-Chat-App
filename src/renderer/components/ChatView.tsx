import { useState, useRef, useEffect, useLayoutEffect, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  useActiveSessionId,
  useCurrentSession,
  useActiveSessionMessages,
  useActivePartialContent,
  useActiveTurn,
  usePendingTurns,
  useActiveExecutionClock,
} from '../store/selectors';
import { useAppStore } from '../store';
import { useIPC } from '../hooks/useIPC';
import { MessageCard } from './MessageCard';
import { ModelSelector } from './ModelSelector';
import { SlashCommandMenu } from './SlashCommandMenu';
import { SubagentTracker } from './SubagentTracker';
import { ContextUsageBar } from './ContextUsageBar';
import type { Message, ContentBlock, Skill, ChatLoopStatus } from '../types';
import {
  Send,
  Square,
  Plus,
  Loader2,
  Plug,
  X,
  Clock,
  Mic,
  Paperclip,
  RefreshCw,
} from 'lucide-react';
import { isScrollNearBottom, resolveSessionScrollTop } from '../utils/chat-scroll-position';
import {
  useSlashCommands,
  isMeetingSlashSkill,
  isLoopStopBuiltinSkill,
} from '../hooks/useSlashCommands';
import { MeetingPicker, type AttachedMeeting } from './MeetingPicker';
import { ChatLoopPanel } from './ChatLoopPanel';
import {
  formatInterval,
  isLoopSlashInput,
  msToLoopInterval,
  parseLoopCommand,
} from '../../shared/loop/parse';
import { DEFAULT_GOAL_MAX_ITERATIONS } from '../../shared/loop/types';
import { hasAssistantTextResponseForTurn, hasStreamingText } from '../utils/active-turn';
import { AttachmentImageThumb, FileAttachmentChip } from './attachments';
import { isImageExtension } from '../utils/attachment-preview';
import {
  isBrowserFileImage,
  loadComposerImageFromPath,
  mimeForAttachedFile,
  normalizeSelectedFiles,
} from '../utils/load-composer-image';

type AttachedFile = {
  name: string;
  path: string;
  size: number;
  type: string;
  inlineDataBase64?: string;
};

export function ChatView() {
  const { t } = useTranslation();
  // Scoped selectors — each subscription only re-renders when its slice changes
  const activeSessionId = useActiveSessionId();
  const activeSession = useCurrentSession();
  const messages = useActiveSessionMessages();
  const { partialMessage, partialThinking } = useActivePartialContent();
  const activeTurn = useActiveTurn();
  const pendingTurns = usePendingTurns();
  const executionClock = useActiveExecutionClock();
  const setGlobalNotice = useAppStore((s) => s.setGlobalNotice);
  const setStoreChatLoopStatus = useAppStore((s) => s.setChatLoopStatus);
  const chatLoopStatus = useAppStore((s) =>
    activeSessionId ? (s.chatLoopBySessionId[activeSessionId] ?? null) : null
  );
  const { continueSession, stopSession, isElectron } = useIPC();
  const [prompt, setPrompt] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const {
    isOpen: isSlashMenuOpen,
    filteredSkills: slashSkills,
    selectedIndex: slashSelectedIndex,
    selectedSkill: slashSelectedSkill,
    setSelectedIndex: setSlashSelectedIndex,
    moveSelection: moveSlashSelection,
    close: closeSlashMenu,
    meetingsReferenceAllowed,
  } = useSlashCommands(prompt);
  const [activeConnectors, setActiveConnectors] = useState<
    { id: string; name: string; connected: boolean; toolCount: number }[]
  >([]);
  const [showConnectorLabel, setShowConnectorLabel] = useState(true);
  const headerRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const connectorMeasureRef = useRef<HTMLDivElement>(null);
  const [pastedImages, setPastedImages] = useState<
    Array<{ url: string; base64: string; mediaType: string }>
  >([]);
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
  const [attachedMeetings, setAttachedMeetings] = useState<AttachedMeeting[]>([]);
  const [meetingPickerOpen, setMeetingPickerOpen] = useState(false);
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const [loopMenuOpen, setLoopMenuOpen] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [loopNotice, setLoopNotice] = useState<string | null>(null);
  const attachMenuRef = useRef<HTMLDivElement>(null);
  const loopMenuRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const isUserAtBottomRef = useRef(true);
  const isComposingRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const prevMessageCountRef = useRef(0);
  const prevPartialLengthRef = useRef(0);
  const scrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollRequestRef = useRef<number | null>(null);
  const scrollStateRequestRef = useRef<number | null>(null);
  const pendingScrollStateRef = useRef<{ sessionId: string; scrollTop: number } | null>(null);
  const isScrollingRef = useRef(false);

  const hasActiveTurn = Boolean(activeTurn);
  const pendingCount = pendingTurns.length;
  const hasTextResponseForTurn = hasAssistantTextResponseForTurn(
    messages,
    activeTurn?.userMessageId
  );
  const showProcessingIndicator =
    hasActiveTurn && !hasTextResponseForTurn && !hasStreamingText(partialMessage, partialThinking);
  const isSessionRunning = activeSession?.status === 'running';
  const canStop = isSessionRunning || hasActiveTurn || pendingCount > 0;

  const displayedMessages = useMemo(() => {
    if (!activeSessionId) return messages;
    // Show streaming message if we have partial text OR partial thinking
    const hasStreamingContent = partialMessage || partialThinking;
    if (!hasStreamingContent || !activeTurn?.userMessageId) return messages;
    const anchorIndex = messages.findIndex((message) => message.id === activeTurn.userMessageId);
    if (anchorIndex === -1) return messages;

    let insertIndex = anchorIndex + 1;
    while (insertIndex < messages.length) {
      if (messages[insertIndex].role === 'user') break;
      insertIndex += 1;
    }

    const contentBlocks: ContentBlock[] = [];
    if (partialThinking) {
      contentBlocks.push({ type: 'thinking', thinking: partialThinking });
    }
    if (partialMessage) {
      contentBlocks.push({ type: 'text', text: partialMessage });
    }

    const streamingMessage: Message = {
      id: `partial-${activeSessionId}`,
      sessionId: activeSessionId,
      role: 'assistant',
      content: contentBlocks,
      timestamp: Date.now(),
    };

    return [...messages.slice(0, insertIndex), streamingMessage, ...messages.slice(insertIndex)];
  }, [activeSessionId, activeTurn?.userMessageId, messages, partialMessage, partialThinking]);

  // Format execution time for display
  const formatExecutionTime = useCallback((ms: number): string => {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    const minutes = Math.floor(ms / 60000);
    const seconds = ((ms % 60000) / 1000).toFixed(0);
    return `${minutes}m ${seconds}s`;
  }, []);

  // --- Real-time execution timer ---
  const [clockNow, setClockNow] = useState(() => Date.now());

  useEffect(() => {
    const isActive = Boolean(executionClock?.startAt && executionClock.endAt === null);
    if (!isActive) {
      return;
    }
    setClockNow(Date.now());
    const interval = setInterval(() => {
      setClockNow(Date.now());
    }, 100);
    return () => clearInterval(interval);
  }, [executionClock?.startAt, executionClock?.endAt]);

  const liveElapsed =
    executionClock?.startAt == null
      ? 0
      : Math.max(0, (executionClock.endAt ?? clockNow) - executionClock.startAt);
  const timerActive = Boolean(executionClock?.startAt && executionClock.endAt === null);

  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    if (!container || !activeSessionId) return;

    const savedScrollTop = useAppStore.getState().sessionScrollPositions[activeSessionId];
    const restoredScrollTop = resolveSessionScrollTop(
      savedScrollTop,
      container.scrollHeight,
      container.clientHeight
    );
    container.scrollTop = restoredScrollTop;
    isUserAtBottomRef.current = isScrollNearBottom(
      restoredScrollTop,
      container.scrollHeight,
      container.clientHeight
    );

    // Prevent the generic new-message effect from overriding the session restore.
    const sessionState = useAppStore.getState().sessionStates[activeSessionId];
    prevMessageCountRef.current = sessionState?.messages.length ?? 0;
    prevPartialLengthRef.current =
      (sessionState?.partialMessage.length ?? 0) + (sessionState?.partialThinking.length ?? 0);
  }, [activeSessionId]);

  // Debounced scroll function to prevent scroll conflicts
  const scrollToBottom = useRef((behavior: ScrollBehavior = 'auto', immediate: boolean = false) => {
    // Cancel any pending scroll requests
    if (scrollTimeoutRef.current) {
      clearTimeout(scrollTimeoutRef.current);
      scrollTimeoutRef.current = null;
    }
    if (scrollRequestRef.current) {
      cancelAnimationFrame(scrollRequestRef.current);
      scrollRequestRef.current = null;
    }

    const performScroll = () => {
      if (!isUserAtBottomRef.current) return;

      // Mark as scrolling to prevent concurrent scrolls
      isScrollingRef.current = true;

      messagesEndRef.current?.scrollIntoView({ behavior });

      // Reset scrolling flag after a short delay
      setTimeout(
        () => {
          isScrollingRef.current = false;
        },
        behavior === 'smooth' ? 300 : 50
      );
    };

    if (immediate) {
      performScroll();
    } else {
      // Use RAF + timeout for debouncing
      scrollRequestRef.current = requestAnimationFrame(() => {
        scrollTimeoutRef.current = setTimeout(performScroll, 16); // ~1 frame delay
      });
    }
  }).current;

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const flushScrollPosition = () => {
      scrollStateRequestRef.current = null;
      const pending = pendingScrollStateRef.current;
      pendingScrollStateRef.current = null;
      if (pending) {
        useAppStore.getState().setSessionScrollPosition(pending.sessionId, pending.scrollTop);
      }
    };

    const updateScrollState = () => {
      const distanceToBottom =
        container.scrollHeight - container.scrollTop - container.clientHeight;
      isUserAtBottomRef.current = distanceToBottom <= 80;
      if (activeSessionId) {
        pendingScrollStateRef.current = {
          sessionId: activeSessionId,
          scrollTop: container.scrollTop,
        };
        if (scrollStateRequestRef.current === null) {
          scrollStateRequestRef.current = requestAnimationFrame(flushScrollPosition);
        }
      }
    };
    updateScrollState();
    // Keep new messages from interrupting the user while they read older content.
    const onScroll = () => updateScrollState();
    container.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      container.removeEventListener('scroll', onScroll);
      if (scrollStateRequestRef.current !== null) {
        cancelAnimationFrame(scrollStateRequestRef.current);
      }
      flushScrollPosition();
    };
  }, [activeSessionId]);

  useEffect(() => {
    const messageCount = messages.length;
    const partialLength = partialMessage.length + partialThinking.length;
    const hasNewMessage = messageCount !== prevMessageCountRef.current;
    const isStreamingTick = partialLength !== prevPartialLengthRef.current && !hasNewMessage;

    // Skip scroll if already scrolling (prevent conflicts)
    if (isScrollingRef.current) {
      prevMessageCountRef.current = messageCount;
      prevPartialLengthRef.current = partialLength;
      return;
    }

    if (isUserAtBottomRef.current) {
      if (!isStreamingTick) {
        // New message - use smooth scroll but with debounce
        const behavior: ScrollBehavior = hasNewMessage ? 'smooth' : 'auto';
        scrollToBottom(behavior, false);
      } else {
        // Streaming tick - use instant scroll with debounce
        scrollToBottom('auto', false);
      }
    }

    prevMessageCountRef.current = messageCount;
    prevPartialLengthRef.current = partialLength;
  }, [messages.length, partialMessage.length, partialThinking.length, scrollToBottom]);

  // Additional scroll trigger for content height changes (e.g., TodoWrite expand/collapse)
  useEffect(() => {
    const container = scrollContainerRef.current;
    const messagesContainer = messagesContainerRef.current;
    if (!container || !messagesContainer) return;

    const resizeObserver = new ResizeObserver(() => {
      // Don't interfere with ongoing scrolls
      if (!isScrollingRef.current && isUserAtBottomRef.current) {
        // Scroll to bottom when content height changes
        scrollToBottom('auto', false);
      }
    });

    resizeObserver.observe(messagesContainer);

    return () => {
      resizeObserver.disconnect();
    };
  }, [scrollToBottom]); // scrollToBottom is stable (useRef); ResizeObserver only needs that binding

  // Cleanup scroll timeouts on unmount
  useEffect(() => {
    return () => {
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current);
      }
      if (scrollRequestRef.current) {
        cancelAnimationFrame(scrollRequestRef.current);
      }
    };
  }, []);

  useEffect(() => {
    textareaRef.current?.focus();
  }, [activeSessionId]);

  // Handle paste event for images
  const handlePaste = async (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    const imageItems = Array.from(items).filter((item) => item.type.startsWith('image/'));
    if (imageItems.length === 0) return;

    e.preventDefault();

    const newImages: Array<{ url: string; base64: string; mediaType: string }> = [];

    for (const item of imageItems) {
      const blob = item.getAsFile();
      if (!blob) continue;

      try {
        // Resize if needed to stay under API limit
        const resizedBlob = await resizeImageIfNeeded(blob);
        const base64 = await blobToBase64(resizedBlob);
        const url = URL.createObjectURL(resizedBlob);
        newImages.push({
          url,
          base64,
          mediaType: resizedBlob.type as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
        });
      } catch (err) {
        // Notify the user instead of silently dropping the error
        setGlobalNotice({
          id: `image-paste-failed-${Date.now()}`,
          type: 'warning',
          message: t('chat.imageProcessFailed'),
        });
      }
    }

    setPastedImages((prev) => [...prev, ...newImages]);
  };

  const blobToBase64 = (blob: Blob): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const result = reader.result;
        if (typeof result !== 'string') {
          reject(new Error('FileReader result is not a string'));
          return;
        }
        // Remove data URL prefix (e.g., "data:image/png;base64,")
        const parts = result.split(',');
        resolve(parts[1] || '');
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  };

  // Resize and compress image if needed to stay under 5MB base64 limit
  const resizeImageIfNeeded = async (blob: Blob): Promise<Blob> => {
    // Claude API limit is 5MB for base64 encoded images
    // Base64 encoding increases size by ~33%, so we target 3.75MB for the blob
    const MAX_BLOB_SIZE = 3.75 * 1024 * 1024; // 3.75MB

    if (blob.size <= MAX_BLOB_SIZE) {
      return blob; // No need to resize
    }

    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(blob);

      img.onload = () => {
        URL.revokeObjectURL(url);

        // Calculate scaling factor to reduce file size
        // We use a more aggressive approach: scale down until size is acceptable
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('Failed to get canvas context'));
          return;
        }

        // Start with a scale factor based on size ratio
        const scale = Math.sqrt(MAX_BLOB_SIZE / blob.size);
        const quality = 0.9;

        const attemptCompress = (currentScale: number, currentQuality: number): Promise<Blob> => {
          canvas.width = Math.floor(img.width * currentScale);
          canvas.height = Math.floor(img.height * currentScale);

          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

          return new Promise((resolveBlob) => {
            canvas.toBlob(
              (compressedBlob) => {
                if (!compressedBlob) {
                  reject(new Error('Failed to compress image'));
                  return;
                }

                // If still too large, try again with lower quality or scale
                if (
                  compressedBlob.size > MAX_BLOB_SIZE &&
                  (currentQuality > 0.5 || currentScale > 0.3)
                ) {
                  const newQuality = Math.max(0.5, currentQuality - 0.1);
                  const newScale = currentQuality <= 0.5 ? currentScale * 0.9 : currentScale;
                  attemptCompress(newScale, newQuality).then(resolveBlob);
                } else {
                  resolveBlob(compressedBlob);
                }
              },
              blob.type || 'image/jpeg',
              currentQuality
            );
          });
        };

        attemptCompress(scale, quality).then(resolve).catch(reject);
      };

      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Failed to load image'));
      };

      img.src = url;
    });
  };

  const removeImage = (index: number) => {
    setPastedImages((prev) => {
      const updated = [...prev];
      URL.revokeObjectURL(updated[index].url);
      updated.splice(index, 1);
      return updated;
    });
  };

  const removeFile = (index: number) => {
    setAttachedFiles((prev) => {
      const updated = [...prev];
      updated.splice(index, 1);
      return updated;
    });
  };

  const handleFileSelect = async () => {
    if (!isElectron || !window.electronAPI) {
      console.log('[ChatView] Not in Electron, file selection not available');
      return;
    }

    try {
      const selected = normalizeSelectedFiles(await window.electronAPI.selectFiles());
      if (selected.length === 0) return;

      const newFiles: AttachedFile[] = [];
      const newImages: Array<{ url: string; base64: string; mediaType: string }> = [];

      for (const file of selected) {
        if (isImageExtension(file.name)) {
          const image = await loadComposerImageFromPath(
            file.path,
            file.name,
            resizeImageIfNeeded,
            blobToBase64,
            file.dataUrl
          );
          if (image) {
            newImages.push(image);
            continue;
          }
        }

        newFiles.push({
          name: file.name,
          path: file.path,
          size: file.size,
          type: mimeForAttachedFile(file.name, file.mimeType),
        });
      }

      if (newImages.length > 0) {
        setPastedImages((prev) => [...prev, ...newImages]);
      }
      if (newFiles.length > 0) {
        setAttachedFiles((prev) => [...prev, ...newFiles]);
      }
    } catch (error) {
      console.error('[ChatView] Error selecting files:', error);
    }
  };

  useEffect(() => {
    if (!attachMenuOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!attachMenuRef.current?.contains(event.target as Node)) {
        setAttachMenuOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setAttachMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [attachMenuOpen]);

  useEffect(() => {
    if (!loopMenuOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!loopMenuRef.current?.contains(event.target as Node)) {
        setLoopMenuOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setLoopMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [loopMenuOpen]);

  // Handle drag and drop for images
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const files = Array.from(e.dataTransfer.files);
    const imageFiles = files.filter((file) => isBrowserFileImage(file));
    const otherFiles = files.filter((file) => !isBrowserFileImage(file));

    // Process images
    if (imageFiles.length > 0) {
      const newImages: Array<{ url: string; base64: string; mediaType: string }> = [];

      for (const file of imageFiles) {
        try {
          // Resize if needed to stay under API limit
          const resizedBlob = await resizeImageIfNeeded(file);
          const base64 = await blobToBase64(resizedBlob);
          const url = URL.createObjectURL(resizedBlob);
          newImages.push({
            url,
            base64,
            mediaType: resizedBlob.type || mimeForAttachedFile(file.name, file.type),
          });
        } catch (err) {
          // Notify the user instead of silently dropping the error
          setGlobalNotice({
            id: `image-drop-failed-${Date.now()}`,
            type: 'warning',
            message: t('chat.imageProcessFailed'),
          });
        }
      }

      setPastedImages((prev) => [...prev, ...newImages]);
    }

    // Process other files
    if (otherFiles.length > 0) {
      const newFiles = await Promise.all(
        otherFiles.map(async (file) => {
          const droppedPath = 'path' in file && typeof file.path === 'string' ? file.path : '';
          const inlineDataBase64 = droppedPath ? undefined : await blobToBase64(file);

          return {
            name: file.name,
            path: droppedPath,
            size: file.size,
            type: mimeForAttachedFile(file.name, file.type),
            inlineDataBase64,
          };
        })
      );

      setAttachedFiles((prev) => [...prev, ...newFiles]);
    }
  };

  // Load active MCP connectors
  useEffect(() => {
    if (isElectron && typeof window !== 'undefined' && window.electronAPI) {
      const loadConnectors = async () => {
        try {
          const statuses = await window.electronAPI.mcp.getServerStatus();
          const active =
            (
              statuses as Array<{ id: string; name: string; connected: boolean; toolCount: number }>
            )?.filter((s) => s.connected && s.toolCount > 0) || [];
          setActiveConnectors(active);
        } catch (err) {
          console.error('Failed to load MCP connectors:', err);
        }
      };
      loadConnectors();
      // Refresh every 5 seconds
      const interval = setInterval(loadConnectors, 5000);
      return () => clearInterval(interval);
    }
  }, [isElectron]);

  useEffect(() => {
    const titleEl = titleRef.current;
    const headerEl = headerRef.current;
    const measureEl = connectorMeasureRef.current;
    if (!titleEl || !headerEl || !measureEl) {
      setShowConnectorLabel(true);
      return;
    }
    const updateLabelVisibility = () => {
      const isTruncated = titleEl.scrollWidth > titleEl.clientWidth;
      const headerStyle = window.getComputedStyle(headerEl);
      const paddingLeft = Number.parseFloat(headerStyle.paddingLeft) || 0;
      const paddingRight = Number.parseFloat(headerStyle.paddingRight) || 0;
      const contentWidth = headerEl.clientWidth - paddingLeft - paddingRight;
      const titleWidth = titleEl.getBoundingClientRect().width;
      const rightColumnWidth = Math.max(0, (contentWidth - titleWidth) / 2);
      const connectorFullWidth = measureEl.getBoundingClientRect().width;
      setShowConnectorLabel(!isTruncated && rightColumnWidth >= connectorFullWidth);
    };
    updateLabelVisibility();
    const observer = new ResizeObserver(() => {
      updateLabelVisibility();
    });
    observer.observe(titleEl);
    observer.observe(headerEl);
    return () => observer.disconnect();
  }, [activeSession?.title, activeConnectors.length]);

  const handleSelectSlashSkill = useCallback(
    (skill: Skill) => {
      if (isMeetingSlashSkill(skill)) {
        setPrompt('');
        closeSlashMenu();
        setAttachMenuOpen(false);
        setLoopMenuOpen(false);
        setMeetingPickerOpen(true);
        return;
      }
      if (isLoopStopBuiltinSkill(skill)) {
        setPrompt(skill.name === 'goal stop' ? '/goal stop' : '/loop stop');
        closeSlashMenu();
        return;
      }
      const next = `/${skill.name} `;
      setPrompt(next);
      requestAnimationFrame(() => {
        if (textareaRef.current) {
          textareaRef.current.focus();
          const cursor = next.length;
          textareaRef.current.setSelectionRange(cursor, cursor);
        }
      });
    },
    [closeSlashMenu]
  );

  const refreshLoopStatus = useCallback(
    async (sessionId: string) => {
      if (!isElectron || !window.electronAPI.loop) return;
      try {
        const status = await window.electronAPI.loop.status(sessionId);
        setStoreChatLoopStatus(sessionId, status);
      } catch {
        setStoreChatLoopStatus(sessionId, null);
      }
    },
    [isElectron, setStoreChatLoopStatus]
  );

  useEffect(() => {
    if (!activeSessionId || !isElectron) {
      return;
    }
    void refreshLoopStatus(activeSessionId);
  }, [activeSessionId, isElectron, refreshLoopStatus]);

  // Show notice when a loop stops (via IPC update through the shared useIPC listener).
  const prevLoopStatusRef = useRef<ChatLoopStatus | null>(null);
  useEffect(() => {
    prevLoopStatusRef.current = null;
  }, [activeSessionId]);
  useEffect(() => {
    const prev = prevLoopStatusRef.current;
    prevLoopStatusRef.current = chatLoopStatus;
    if (prev && !chatLoopStatus) {
      setLoopNotice(t('loop.stopped'));
    }
  }, [chatLoopStatus, t]);

  const handleStopChatLoop = useCallback(async () => {
    if (!activeSessionId || !isElectron) return;
    try {
      await window.electronAPI.loop.stop(activeSessionId);
      setStoreChatLoopStatus(activeSessionId, null);
      setLoopNotice(t('loop.stopped'));
      setLoopMenuOpen(false);
    } catch (err) {
      setGlobalNotice({
        id: `loop-stop-${Date.now()}`,
        message: err instanceof Error ? err.message : t('loop.stopFailed'),
        type: 'error',
      });
    }
  }, [activeSessionId, isElectron, setGlobalNotice, setStoreChatLoopStatus, t]);

  const startChatLoop = useCallback(
    async (input: {
      kind: 'interval' | 'goal';
      prompt: string;
      intervalMs: number;
      maxIterations?: number | null;
    }) => {
      if (!activeSessionId || !isElectron) {
        throw new Error(t('loop.startFailed'));
      }
      const status = await window.electronAPI.loop.start({
        sessionId: activeSessionId,
        kind: input.kind,
        prompt: input.prompt,
        intervalMs: input.intervalMs,
        maxIterations:
          input.kind === 'goal' ? (input.maxIterations ?? DEFAULT_GOAL_MAX_ITERATIONS) : null,
        runImmediately: true,
      });
      setStoreChatLoopStatus(activeSessionId, status);
      const intervalLabel = formatInterval(msToLoopInterval(input.intervalMs));
      setLoopNotice(
        input.kind === 'goal'
          ? t('loop.goalStarted', {
              interval: intervalLabel,
              max: input.maxIterations ?? DEFAULT_GOAL_MAX_ITERATIONS,
            })
          : t('loop.started', { interval: intervalLabel })
      );
      return status;
    },
    [activeSessionId, isElectron, setStoreChatLoopStatus, t]
  );

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();

    // Get value from ref to handle both controlled and uncontrolled cases
    const currentPrompt = textareaRef.current?.value || prompt;

    if (
      (!currentPrompt.trim() &&
        pastedImages.length === 0 &&
        attachedFiles.length === 0 &&
        attachedMeetings.length === 0) ||
      !activeSessionId ||
      isSubmitting
    )
      return;

    // Intercept /loop and /goal before normal send
    if (isElectron && isLoopSlashInput(currentPrompt.trim())) {
      setIsSubmitting(true);
      try {
        const parsed = parseLoopCommand(currentPrompt.trim());
        if (parsed.type === 'usage') {
          setLoopNotice(t('loop.usage'));
          return;
        }
        if (parsed.type === 'stop') {
          await handleStopChatLoop();
          setPrompt('');
          if (textareaRef.current) textareaRef.current.value = '';
          return;
        }
        if (parsed.type === 'loop' || parsed.type === 'goal') {
          await startChatLoop({
            kind: parsed.type === 'goal' ? 'goal' : 'interval',
            prompt: parsed.type === 'goal' ? parsed.goal : parsed.prompt,
            intervalMs: parsed.interval.ms,
            maxIterations: parsed.type === 'goal' ? parsed.maxIterations : null,
          });
          setPrompt('');
          if (textareaRef.current) textareaRef.current.value = '';
          return;
        }
      } catch (err) {
        setGlobalNotice({
          id: `loop-start-${Date.now()}`,
          message: err instanceof Error ? err.message : t('loop.startFailed'),
          type: 'error',
        });
        return;
      } finally {
        setIsSubmitting(false);
      }
    }

    setIsSubmitting(true);
    try {
      // Build content blocks
      const contentBlocks: ContentBlock[] = [];

      // Add images first
      pastedImages.forEach((img) => {
        contentBlocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: img.mediaType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
            data: img.base64,
          },
        });
      });

      // Promote image files to ImageContent; keep other files as attachments
      for (const file of attachedFiles) {
        if (isImageExtension(file.name)) {
          if (file.inlineDataBase64) {
            const mediaType = (file.type.startsWith('image/') ? file.type : null) || 'image/jpeg';
            contentBlocks.push({
              type: 'image',
              source: {
                type: 'base64',
                media_type: mediaType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
                data: file.inlineDataBase64,
              },
            });
            continue;
          }

          const image = await loadComposerImageFromPath(
            file.path,
            file.name,
            resizeImageIfNeeded,
            blobToBase64
          );
          if (image) {
            contentBlocks.push({
              type: 'image',
              source: {
                type: 'base64',
                media_type: image.mediaType as
                  | 'image/jpeg'
                  | 'image/png'
                  | 'image/gif'
                  | 'image/webp',
                data: image.base64,
              },
            });
            continue;
          }
        }

        contentBlocks.push({
          type: 'file_attachment',
          filename: file.name,
          relativePath: file.path, // Will be processed by backend to copy to .tmp
          size: file.size,
          mimeType: file.type,
          inlineDataBase64: file.inlineDataBase64,
        });
      }

      // Add meeting attachments (this turn only)
      attachedMeetings.forEach((meeting) => {
        contentBlocks.push({
          type: 'meeting_attachment',
          meetingId: meeting.meetingId,
          title: meeting.title,
          includeTranscript: meeting.includeTranscript,
        });
      });

      // Add text if present
      if (currentPrompt.trim()) {
        contentBlocks.push({
          type: 'text',
          text: currentPrompt.trim(),
        });
      }

      // Send message with content blocks
      await continueSession(activeSessionId, contentBlocks);

      // Clean up
      setPrompt('');
      if (textareaRef.current) {
        textareaRef.current.value = '';
      }
      pastedImages.forEach((img) => URL.revokeObjectURL(img.url));
      setPastedImages([]);
      setAttachedFiles([]);
      setAttachedMeetings([]);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleStop = () => {
    if (activeSessionId) {
      stopSession(activeSessionId);
    }
  };

  // Auto-adjust textarea height based on content
  const adjustTextareaHeight = () => {
    const textarea = textareaRef.current;
    if (textarea) {
      // Reset height to auto to get the correct scrollHeight
      textarea.style.height = 'auto';
      // Set max height to 200px (about 8 lines), then scroll
      const maxHeight = 200;
      const newHeight = Math.min(textarea.scrollHeight, maxHeight);
      textarea.style.height = `${newHeight}px`;
      // Show scrollbar if content exceeds max height
      textarea.style.overflowY = textarea.scrollHeight > maxHeight ? 'auto' : 'hidden';
    }
  };

  // Adjust height when prompt changes (including clear after send)
  useEffect(() => {
    adjustTextareaHeight();
  }, [prompt]);

  if (!activeSession) {
    return (
      <div className="flex-1 flex items-center justify-center text-text-muted">
        <span>{t('chat.loadingConversation')}</span>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-background">
      {/* Header */}
      <div
        ref={headerRef}
        className="relative h-12 border-b border-border-muted grid grid-cols-[1fr_auto_1fr] items-center px-4 lg:px-8 bg-background/88 backdrop-blur-md"
      >
        <div className="text-[11px] font-medium tracking-[0.08em] uppercase text-text-muted">
          York IE VECOS
        </div>
        <h2
          ref={titleRef}
          className="text-[15px] font-medium text-text-primary text-center truncate max-w-[40vw] lg:max-w-[32rem]"
        >
          {activeSession.title}
        </h2>
        <div className="justify-self-end flex items-center gap-2">
          {chatLoopStatus && (
            <button
              type="button"
              onClick={() => void handleStopChatLoop()}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-accent/10 border border-accent/20 text-accent text-xs font-medium"
              title={t('loop.stopButton')}
            >
              <RefreshCw className="w-3.5 h-3.5 animate-spin" style={{ animationDuration: '3s' }} />
              <span>
                {chatLoopStatus.kind === 'goal'
                  ? t('loop.badgeGoal', {
                      interval: formatInterval(msToLoopInterval(chatLoopStatus.intervalMs)),
                      tick: chatLoopStatus.tickCount,
                    })
                  : t('loop.badge', {
                      interval: formatInterval(msToLoopInterval(chatLoopStatus.intervalMs)),
                      tick: chatLoopStatus.tickCount,
                    })}
              </span>
              <X className="w-3 h-3" />
            </button>
          )}
          {activeConnectors.length > 0 && (
            <>
              <div
                ref={connectorMeasureRef}
                aria-hidden="true"
                className="absolute left-0 top-0 -z-10 opacity-0 pointer-events-none"
              >
                <div className="flex items-center gap-2 px-2 py-1 rounded-lg border border-mcp/20">
                  <Plug className="w-3.5 h-3.5" />
                  <span className="text-xs font-medium whitespace-nowrap">
                    {t('chat.connectorCount', { count: activeConnectors.length })}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-mcp/8 border border-mcp/15">
                <Plug className="w-3.5 h-3.5 text-mcp" />
                <span className="text-xs text-mcp font-medium">
                  {showConnectorLabel
                    ? t('chat.connectorCount', { count: activeConnectors.length })
                    : activeConnectors.length}
                </span>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Context Usage Bar */}
      <ContextUsageBar />
      {loopNotice && (
        <div className="px-4 py-2 text-xs text-text-secondary border-b border-border-muted bg-surface/60 flex items-center justify-between gap-2">
          <span>{loopNotice}</span>
          <button
            type="button"
            className="text-text-muted hover:text-text-primary"
            onClick={() => setLoopNotice(null)}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Messages */}
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto">
        <div
          ref={messagesContainerRef}
          className="w-full max-w-[920px] mx-auto py-8 px-5 lg:px-8 space-y-5"
        >
          {displayedMessages.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-28 text-text-muted space-y-3 text-center">
              <p className="text-[11px] uppercase tracking-[0.16em] text-text-muted/80">
                York IE VECOS
              </p>
              <p className="text-base text-text-secondary">{t('chat.startConversation')}</p>
            </div>
          ) : (
            displayedMessages.map((message) => {
              const isStreaming =
                typeof message.id === 'string' && message.id.startsWith('partial-');
              return (
                <div key={message.id}>
                  <MessageCard message={message} isStreaming={isStreaming} />
                </div>
              );
            })
          )}

          {/* Subagent progress indicators */}
          <SubagentTracker sessionId={activeSessionId} />

          {/* Processing indicator - show when we have an active turn but no streaming content yet */}
          {showProcessingIndicator && (
            <div className="flex items-center gap-3 px-4 py-3 rounded-full bg-background/80 border border-border-subtle max-w-fit">
              <Loader2 className="w-4 h-4 text-accent animate-spin" />
              <span className="text-sm text-text-secondary">{t('chat.processing')}</span>
            </div>
          )}

          {/* Real-time execution timer */}
          {liveElapsed > 0 && (
            <div className="flex items-center gap-1.5 text-[11px] text-text-muted mt-1 ml-0.5">
              <Clock className="w-3 h-3" />
              <span>
                {timerActive
                  ? formatExecutionTime(liveElapsed)
                  : t('messageCard.executionTime', { time: formatExecutionTime(liveElapsed) })}
              </span>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Input */}
      <div className="border-t border-border-muted bg-background/92 backdrop-blur-md">
        <div className="max-w-[920px] mx-auto px-5 lg:px-8 py-5">
          <form
            onSubmit={handleSubmit}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className="relative w-full"
          >
            {/* Image previews */}
            {pastedImages.length > 0 && (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2 mb-3">
                {pastedImages.map((img, index) => (
                  <AttachmentImageThumb
                    key={img.url || `pasted-image-${index}`}
                    src={img.url}
                    alt={t('common.pastedImageAlt', { index: index + 1 })}
                    variant="grid"
                    removeButton={
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          removeImage(index);
                        }}
                        className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-error text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    }
                  />
                ))}
              </div>
            )}

            {/* File attachments */}
            {attachedFiles.length > 0 && (
              <div className="space-y-2 mb-3">
                {attachedFiles.map((file, index) => (
                  <FileAttachmentChip
                    key={file.path || `attached-file-${index}`}
                    filename={file.name}
                    className="group"
                    removeButton={
                      <button
                        type="button"
                        onClick={() => removeFile(index)}
                        className="w-6 h-6 rounded-full bg-error/10 hover:bg-error/20 text-error flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    }
                  />
                ))}
              </div>
            )}

            {/* Meeting attachments */}
            {attachedMeetings.length > 0 && (
              <div className="space-y-2 mb-3">
                {attachedMeetings.map((meeting) => (
                  <div
                    key={meeting.meetingId}
                    className="flex items-center gap-2 px-3 py-2 rounded-lg bg-surface-muted border border-border group"
                  >
                    <Mic className="h-4 w-4 flex-shrink-0 text-accent" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-text-primary truncate">{meeting.title}</p>
                      <label className="mt-1 flex items-center gap-1.5 text-[11px] text-text-muted">
                        <input
                          type="checkbox"
                          checked={Boolean(meeting.includeTranscript)}
                          onChange={(e) =>
                            setAttachedMeetings((prev) =>
                              prev.map((item) =>
                                item.meetingId === meeting.meetingId
                                  ? { ...item, includeTranscript: e.target.checked }
                                  : item
                              )
                            )
                          }
                          className="h-3.5 w-3.5 accent-accent"
                        />
                        {t('meetings.includeTranscript')}
                      </label>
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        setAttachedMeetings((prev) =>
                          prev.filter((item) => item.meetingId !== meeting.meetingId)
                        )
                      }
                      className="w-6 h-6 rounded-full bg-error/10 hover:bg-error/20 text-error flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div
              className={`relative flex items-end gap-2 p-3.5 rounded-[1.75rem] bg-background/88 border border-border-muted shadow-soft transition-colors ${
                isDragging ? 'ring-2 ring-accent bg-accent/5' : ''
              }`}
            >
              <SlashCommandMenu
                open={isSlashMenuOpen}
                skills={slashSkills}
                selectedIndex={slashSelectedIndex}
                onSelect={handleSelectSlashSkill}
                onHoverIndex={setSlashSelectedIndex}
                onClose={closeSlashMenu}
              />
              <div className="relative" ref={attachMenuRef}>
                <button
                  type="button"
                  onClick={() => {
                    setLoopMenuOpen(false);
                    if (meetingsReferenceAllowed) {
                      setAttachMenuOpen((open) => !open);
                      return;
                    }
                    void handleFileSelect();
                  }}
                  className="w-9 h-9 rounded-2xl flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-surface-hover transition-colors"
                  title={
                    meetingsReferenceAllowed ? t('meetings.attachMenu') : t('welcome.attachFiles')
                  }
                  aria-expanded={meetingsReferenceAllowed ? attachMenuOpen : undefined}
                  aria-haspopup={meetingsReferenceAllowed ? 'menu' : undefined}
                >
                  <Plus className="w-5 h-5" />
                </button>
                {meetingsReferenceAllowed && attachMenuOpen && (
                  <div
                    role="menu"
                    className="absolute bottom-[calc(100%+8px)] left-0 z-30 min-w-[12.5rem] overflow-hidden rounded-[1.25rem] border border-border-subtle bg-background shadow-elevated"
                  >
                    <div className="space-y-0.5 p-1.5">
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setAttachMenuOpen(false);
                          void handleFileSelect();
                        }}
                        className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-text-primary transition-colors hover:bg-surface-hover"
                      >
                        <Paperclip className="h-4 w-4 text-text-muted" />
                        <span className="text-[13px] font-medium">{t('welcome.attachFiles')}</span>
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setAttachMenuOpen(false);
                          setMeetingPickerOpen(true);
                        }}
                        className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-text-primary transition-colors hover:bg-surface-hover"
                      >
                        <Mic className="h-4 w-4 text-accent" />
                        <span className="text-[13px] font-medium">
                          {t('meetings.attachMeeting')}
                        </span>
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {isElectron && (
                <div className="relative" ref={loopMenuRef}>
                  <button
                    type="button"
                    onClick={() => {
                      setAttachMenuOpen(false);
                      setLoopMenuOpen((open) => !open);
                    }}
                    className={`w-9 h-9 rounded-2xl flex items-center justify-center transition-colors ${
                      chatLoopStatus || loopMenuOpen
                        ? 'text-accent bg-accent/10 hover:bg-accent/15'
                        : 'text-text-muted hover:text-text-primary hover:bg-surface-hover'
                    }`}
                    title={t('loop.menuButton')}
                    aria-expanded={loopMenuOpen}
                    aria-haspopup="dialog"
                  >
                    <RefreshCw className="w-5 h-5" />
                  </button>
                  <ChatLoopPanel
                    open={loopMenuOpen}
                    initialText={prompt.trim()}
                    activeStatus={chatLoopStatus}
                    onClose={() => setLoopMenuOpen(false)}
                    onStart={async ({ kind, prompt: loopPrompt, intervalMs }) => {
                      await startChatLoop({ kind, prompt: loopPrompt, intervalMs });
                      setPrompt('');
                      if (textareaRef.current) textareaRef.current.value = '';
                    }}
                    onStop={async () => {
                      await handleStopChatLoop();
                    }}
                  />
                </div>
              )}

              <textarea
                ref={textareaRef}
                value={prompt}
                onChange={(e) => {
                  setPrompt(e.target.value);
                  adjustTextareaHeight();
                }}
                onCompositionStart={() => {
                  isComposingRef.current = true;
                }}
                onCompositionEnd={() => {
                  isComposingRef.current = false;
                }}
                onPaste={handlePaste}
                onKeyDown={(e) => {
                  if (isSlashMenuOpen) {
                    if (e.key === 'ArrowDown') {
                      e.preventDefault();
                      moveSlashSelection(1);
                      return;
                    }
                    if (e.key === 'ArrowUp') {
                      e.preventDefault();
                      moveSlashSelection(-1);
                      return;
                    }
                    if (
                      (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) &&
                      slashSelectedSkill
                    ) {
                      if (
                        e.nativeEvent.isComposing ||
                        isComposingRef.current ||
                        e.keyCode === 229
                      ) {
                        return;
                      }
                      e.preventDefault();
                      handleSelectSlashSkill(slashSelectedSkill);
                      return;
                    }
                    if (e.key === 'Escape') {
                      e.preventDefault();
                      closeSlashMenu();
                      return;
                    }
                  }
                  // Enter to send, Shift+Enter for new line
                  if (e.key === 'Enter' && !e.shiftKey) {
                    if (e.nativeEvent.isComposing || isComposingRef.current || e.keyCode === 229) {
                      return;
                    }
                    e.preventDefault();
                    handleSubmit();
                  }
                }}
                placeholder={t('chat.typeMessage')}
                disabled={isSubmitting}
                rows={1}
                className="flex-1 resize-none bg-transparent border-none outline-none text-text-primary placeholder:text-text-muted text-[15px] py-2 overflow-hidden"
              />

              <div className="flex items-center gap-2">
                <ModelSelector />

                {canStop && (
                  <button
                    type="button"
                    onClick={handleStop}
                    className="w-9 h-9 rounded-2xl flex items-center justify-center bg-error/10 text-error hover:bg-error/20 transition-colors"
                    title={t('chat.stop')}
                  >
                    <Square className="w-4 h-4" />
                  </button>
                )}
                <button
                  type="submit"
                  disabled={
                    (!prompt.trim() &&
                      !textareaRef.current?.value.trim() &&
                      pastedImages.length === 0 &&
                      attachedFiles.length === 0 &&
                      attachedMeetings.length === 0) ||
                    isSubmitting
                  }
                  className="w-9 h-9 rounded-2xl flex items-center justify-center bg-accent text-background disabled:opacity-50 disabled:cursor-not-allowed hover:bg-accent-hover transition-colors"
                  title={t('chat.sendMessage')}
                >
                  <Send className="w-4 h-4" />
                </button>
              </div>
            </div>

            <p className="text-[11px] text-text-muted/60 text-center mt-2.5">
              {t('chat.disclaimer')}
            </p>
          </form>
        </div>
      </div>
      <MeetingPicker
        open={meetingPickerOpen}
        onClose={() => setMeetingPickerOpen(false)}
        excludeIds={attachedMeetings.map((item) => item.meetingId)}
        onSelect={(meeting) => {
          setAttachedMeetings((prev) =>
            prev.some((item) => item.meetingId === meeting.meetingId) ? prev : [...prev, meeting]
          );
        }}
      />
    </div>
  );
}
