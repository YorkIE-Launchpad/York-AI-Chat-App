import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  useActiveSessionId,
  useCurrentSession,
  useActiveSessionMessages,
  useActivePartialContent,
  useActiveTurn,
  usePendingTurns,
  useActiveExecutionClock,
  useActiveTraceSteps,
} from '../store/selectors';
import { useAppStore } from '../store';
import { useIPC } from '../hooks/useIPC';
import { useSessionInputDraft } from '../hooks/useSessionInputDraft';
import { MessageCard } from './MessageCard';
import { MESSAGE_POINTERS_GUTTER_CLASS, MessagePointers } from './MessagePointers';
import { MessageQueueList } from './MessageQueueList';
import { ModelSelector } from './ModelSelector';
import { ComposerModeDropdown } from './ComposerModeDropdown';
import { resolveGptImage25ModelId } from '../../shared/image-generation';
import { YorkLlmRoutineTip } from './YorkLlmRoutineTip';
import { HubBudgetMeter } from './HubBudgetMeter';
import { ThinkingModeToggle } from './ThinkingModeToggle';
import { SlashCommandMenu } from './SlashCommandMenu';
import { SubagentTracker } from './SubagentTracker';
import type { Message, ContentBlock, Skill, ChatLoopStatus } from '../types';
import { ArrowUp, Square, FolderOpen, RefreshCw, PackageX } from 'lucide-react';
import {
  useSlashCommands,
  isMeetingSlashSkill,
  isLoopStopBuiltinSkill,
} from '../hooks/useSlashCommands';
import { ToolsHealthNote } from './health/ToolsHealthNote';
import { ChatHeader } from './chat/ChatHeader';
import { ChatBanners } from './chat/ChatBanners';
import { ChatEmptyState } from './chat/ChatEmptyState';
import { ChatActivity } from './chat/ChatActivity';
import { ComposerAttachments } from './chat/ComposerAttachments';
import { ComposerAttachMenu } from './chat/ComposerAttachMenu';
import { useComposerAttachments } from './chat/useComposerAttachments';
import { useChatAutoScroll } from './chat/useChatAutoScroll';
import { useChatCollab } from './chat/useChatCollab';
import { useExecutionTimer } from './chat/useExecutionTimer';
import { useHeaderConnectors } from './chat/useHeaderConnectors';
import { useSharedDocLocks } from './chat/useSharedDocLocks';
import { resizeImageIfNeeded } from '../utils/resize-image';
import { applySkillTriggerSelection } from '../../shared/skill-composer-trigger';
import { MeetingPicker } from './MeetingPicker';
import { ConnectorReferencePicker } from './ConnectorReferencePicker';
import type { ExternalReferenceContent } from '../../shared/external-reference';
import { ChatLoopPanel } from './ChatLoopPanel';
import {
  formatInterval,
  isLoopSlashInput,
  msToLoopInterval,
  parseLoopCommand,
} from '../../shared/loop/parse';
import { DEFAULT_GOAL_MAX_ITERATIONS } from '../../shared/loop/types';
import {
  hasAssistantTextResponseForTurn,
  hasInProgressToolUseForTurn,
  hasStreamingText,
  isPendingStepId,
  resolveActiveTurnStatusLabel,
} from '../utils/active-turn';
import { isImageExtension } from '../utils/attachment-preview';
import { loadComposerImageFromPath } from '../utils/load-composer-image';
import { handleComposerTextKeyDown } from '../utils/composer-text-editing';
import { useDictation } from '../hooks/useDictation';
import { DictationButton } from './DictationButton';
import { ClientOutdatedUpdateActions } from './ClientOutdatedUpdateActions';
import { divisionLabel } from '../../shared/workspace-division';

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
  const traceSteps = useActiveTraceSteps();
  const setGlobalNotice = useAppStore((s) => s.setGlobalNotice);
  const setStoreChatLoopStatus = useAppStore((s) => s.setChatLoopStatus);
  const yorkLlmQueue = useAppStore((s) =>
    activeSessionId ? (s.yorkLlmQueueBySessionId[activeSessionId] ?? null) : null
  );
  const activeDivision = useAppStore((s) => s.activeDivision);
  const chatLoopStatus = useAppStore((s) =>
    activeSessionId ? (s.chatLoopBySessionId[activeSessionId] ?? null) : null
  );
  const matterChatDraft = useAppStore((s) =>
    activeSessionId ? (s.matterChatDraftBySessionId[activeSessionId] ?? null) : null
  );
  const clearMatterChatDraft = useAppStore((s) => s.clearMatterChatDraft);
  const composerMode = useAppStore((s) => s.composerMode);
  const backendModelsCatalog = useAppStore((s) => s.backendModelsCatalog);
  const {
    continueSession,
    sendImageTurn,
    stopSession,
    removeQueuedMessage,
    setSessionSkillsDisabled,
    changeWorkingDir,
    isElectron,
  } = useIPC();
  const skillsDisabled = activeSession?.skillsDisabled === true;
  const [prompt, setPrompt] = useSessionInputDraft(activeSessionId);
  const [cursorIndex, setCursorIndex] = useState(0);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const matterPrefillAppliedForSessionRef = useRef<string | null>(null);
  const {
    isOpen: isSlashMenuOpen,
    filteredSkills: slashSkills,
    selectedIndex: slashSelectedIndex,
    selectedSkill: slashSelectedSkill,
    setSelectedIndex: setSlashSelectedIndex,
    moveSelection: moveSlashSelection,
    close: closeSlashMenu,
    openSkillPicker,
    meetingsReferenceAllowed,
    trigger: skillTrigger,
  } = useSlashCommands(prompt, cursorIndex, { catalogSkillsDisabled: skillsDisabled });
  const {
    pastedImages,
    setPastedImages,
    attachedFiles,
    setAttachedFiles,
    attachedMeetings,
    setAttachedMeetings,
    attachedReferences,
    setAttachedReferences,
    isDragging,
    blobToBase64,
    handlePaste,
    handleFileSelect,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    removeImage,
    removeFile,
  } = useComposerAttachments(isElectron);
  const [referencePickerSource, setReferencePickerSource] = useState<
    ExternalReferenceContent['source'] | null
  >(null);
  const [meetingPickerOpen, setMeetingPickerOpen] = useState(false);
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const [loopMenuOpen, setLoopMenuOpen] = useState(false);
  const [loopNotice, setLoopNotice] = useState<string | null>(null);
  const attachMenuRef = useRef<HTMLDivElement>(null);
  const loopMenuRef = useRef<HTMLDivElement>(null);
  const isComposingRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const {
    activeConnectors,
    showConnectorLabel,
    headerRef,
    rightActionsRef,
    connectorMeasureRef,
    connectorBadgeRef,
  } = useHeaderConnectors(isElectron, chatLoopStatus);
  const {
    collabState,
    isSharedChat,
    collabBlocksComposer,
    showCollabWaitingPeer,
    collabPeerNames,
    collabRoomIdLabel,
    collabPresenceLabel,
    handleExportChat,
    handleShareChat,
    handleTakeTurn,
  } = useChatCollab(activeSessionId, activeSession, messages.length);
  const { sharedDocBlocksComposer, sharedDocViewOnlyOpen, sharedDocBlockName } = useSharedDocLocks(
    activeSessionId,
    isElectron
  );
  const { liveElapsed, timerActive, formatExecutionTime } = useExecutionTimer(executionClock);

  const hasActiveTurn = Boolean(activeTurn);
  const pendingCount = pendingTurns.length;
  const queuedMessages = useMemo(
    () => messages.filter((m) => m.localStatus === 'queued'),
    [messages]
  );
  const queuedCount = queuedMessages.length;
  const hasTextResponseForTurn = hasAssistantTextResponseForTurn(
    messages,
    activeTurn?.userMessageId
  );
  const showProcessingIndicator =
    hasActiveTurn &&
    !hasTextResponseForTurn &&
    !hasStreamingText(partialMessage, partialThinking) &&
    !hasInProgressToolUseForTurn(messages, activeTurn?.userMessageId);
  const activeTurnStartedAt = activeTurn?.userMessageId
    ? messages.find((message) => message.id === activeTurn.userMessageId)?.timestamp
    : undefined;
  const processingStatusLabel =
    resolveActiveTurnStatusLabel(traceSteps, activeTurnStartedAt) ??
    (activeTurn && isPendingStepId(activeTurn.stepId) ? t('chat.starting') : t('chat.processing'));
  const isSessionRunning = activeSession?.status === 'running';
  const canStop = isSessionRunning || hasActiveTurn || pendingCount > 0;

  const displayedMessages = useMemo(() => {
    // Queued follow-ups live in the bottom queue list, not the transcript.
    const transcriptMessages = messages.filter((message) => message.localStatus !== 'queued');
    if (!activeSessionId) return transcriptMessages;
    // Show streaming message if we have partial text OR partial thinking
    const hasStreamingContent = partialMessage || partialThinking;
    if (!hasStreamingContent || !activeTurn?.userMessageId) {
      const remotePartial = collabState?.awarenessPartial;
      if (remotePartial?.text && !collabState?.canPrompt) {
        return [
          ...transcriptMessages,
          {
            id: 'collab-awareness-partial',
            sessionId: activeSessionId,
            role: 'assistant' as const,
            content: [
              {
                type: 'text' as const,
                text: `${remotePartial.fromName}: ${remotePartial.text}`,
              },
            ],
            timestamp: Date.now(),
          },
        ];
      }
      return transcriptMessages;
    }
    const anchorIndex = transcriptMessages.findIndex(
      (message) => message.id === activeTurn.userMessageId
    );
    if (anchorIndex === -1) return transcriptMessages;

    let insertIndex = anchorIndex + 1;
    while (insertIndex < transcriptMessages.length) {
      if (transcriptMessages[insertIndex].role === 'user') break;
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

    return [
      ...transcriptMessages.slice(0, insertIndex),
      streamingMessage,
      ...transcriptMessages.slice(insertIndex),
    ];
  }, [
    activeSessionId,
    activeTurn?.userMessageId,
    collabState?.awarenessPartial,
    collabState?.canPrompt,
    messages,
    partialMessage,
    partialThinking,
  ]);

  const showMessagePointers = useMemo(
    () => displayedMessages.filter((message) => message.role === 'user').length >= 2,
    [displayedMessages]
  );

  const { messagesEndRef, scrollContainerRef, messagesContainerRef, isUserAtBottomRef } =
    useChatAutoScroll(
      activeSessionId,
      messages.length,
      partialMessage.length + partialThinking.length
    );

  useEffect(() => {
    textareaRef.current?.focus();
    // Drop Matter composer prefill when leaving that idle session
    if (
      matterPrefillAppliedForSessionRef.current &&
      matterPrefillAppliedForSessionRef.current !== activeSessionId
    ) {
      const leftSessionId = matterPrefillAppliedForSessionRef.current;
      matterPrefillAppliedForSessionRef.current = null;
      useAppStore.getState().setSessionInputDraft(leftSessionId, '');
    }
  }, [activeSessionId]);

  // Seed Matter Chat composer once per idle session (editable; not auto-sent).
  useEffect(() => {
    if (!activeSessionId || !matterChatDraft) {
      return;
    }
    if (messages.length > 0) return;
    if (matterPrefillAppliedForSessionRef.current === activeSessionId) return;
    matterPrefillAppliedForSessionRef.current = activeSessionId;
    const prefill = matterChatDraft.composerPrefill;
    setPrompt(prefill);
    if (textareaRef.current) {
      textareaRef.current.value = prefill;
      textareaRef.current.focus();
      const len = prefill.length;
      textareaRef.current.setSelectionRange(len, len);
    }
    setCursorIndex(prefill.length);
  }, [activeSessionId, matterChatDraft, messages.length, setPrompt]);

  const handleChangeWorkingDir = async () => {
    if (!activeSessionId) return;
    try {
      const result = await changeWorkingDir(activeSessionId, activeSession?.cwd || undefined);
      if (!result.success && result.error && result.error !== 'User cancelled') {
        setGlobalNotice({
          id: `notice-workdir-select-${Date.now()}`,
          type: 'warning',
          message: `${t('welcome.selectWorkingFolderFailed')}: ${result.error}`,
        });
      }
    } catch (error) {
      setGlobalNotice({
        id: `notice-workdir-select-${Date.now()}`,
        type: 'error',
        message:
          error instanceof Error && error.message
            ? `${t('welcome.selectWorkingFolderFailed')}: ${error.message}`
            : t('welcome.selectWorkingFolderFailed'),
      });
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

  const handleSelectSlashSkill = useCallback(
    (skill: Skill) => {
      if (isMeetingSlashSkill(skill)) {
        setPrompt('');
        setCursorIndex(0);
        closeSlashMenu();
        setAttachMenuOpen(false);
        setLoopMenuOpen(false);
        setMeetingPickerOpen(true);
        return;
      }
      if (isLoopStopBuiltinSkill(skill)) {
        const next = skill.name === 'goal stop' ? '/goal stop' : '/loop stop';
        setPrompt(next);
        setCursorIndex(next.length);
        closeSlashMenu();
        return;
      }

      // Slash trigger keeps /name; @ or + menu insert @name mention
      const insertText = skillTrigger?.mode === 'slash' ? `/${skill.name} ` : `@${skill.name} `;

      const { next, cursor } = applySkillTriggerSelection(
        prompt,
        skillTrigger,
        insertText,
        cursorIndex
      );
      setPrompt(next);
      setCursorIndex(cursor);
      closeSlashMenu();
      requestAnimationFrame(() => {
        if (textareaRef.current) {
          textareaRef.current.focus();
          textareaRef.current.setSelectionRange(cursor, cursor);
        }
      });
    },
    [closeSlashMenu, cursorIndex, prompt, setPrompt, skillTrigger]
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

    const imageComposer = composerMode === 'image';
    if (
      (imageComposer
        ? !currentPrompt.trim()
        : !currentPrompt.trim() &&
          pastedImages.length === 0 &&
          attachedFiles.length === 0 &&
          attachedMeetings.length === 0 &&
          attachedReferences.length === 0) ||
      !activeSessionId ||
      isSubmitting
    )
      return;

    if (imageComposer && isElectron) {
      const modelId = resolveGptImage25ModelId(backendModelsCatalog);
      if (!modelId) {
        setGlobalNotice({
          id: `image-access-${Date.now()}`,
          type: 'error',
          message: t('composer.imageAccessRequired'),
          messageKey: 'composer.imageAccessRequired',
        });
        return;
      }
      setIsSubmitting(true);
      try {
        const contentBlocks: ContentBlock[] = [];
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
        for (const file of attachedFiles) {
          if (!isImageExtension(file.name)) continue;
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
          }
        }
        contentBlocks.push({ type: 'text', text: currentPrompt.trim() });
        const imagesToRevoke = [...pastedImages];
        setPrompt('');
        if (textareaRef.current) textareaRef.current.value = '';
        imagesToRevoke.forEach((img) => URL.revokeObjectURL(img.url));
        setPastedImages([]);
        setAttachedFiles([]);
        void sendImageTurn(modelId, currentPrompt.trim(), contentBlocks, {
          sessionId: activeSessionId,
        });
      } finally {
        setIsSubmitting(false);
      }
      return;
    }

    if (sharedDocBlocksComposer) {
      setGlobalNotice({
        id: `notice-shared-doc-${Date.now()}`,
        type: 'warning',
        message: sharedDocViewOnlyOpen
          ? t('chat.sharedDocViewOnlyComposerLocked')
          : t('chat.sharedDocComposerLocked', { name: sharedDocBlockName }),
      });
      return;
    }

    if (isSharedChat) {
      if (collabBlocksComposer) {
        setGlobalNotice({
          id: `notice-collab-${Date.now()}`,
          type: 'warning',
          message: '',
          messageKey: 'chat.collabComposerLocked',
        });
        return;
      }
      // Lease free or ours — acquireTurn is handled in main assertCanPrompt on send
    }

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

      attachedReferences.forEach((reference) => {
        contentBlocks.push(reference);
      });

      // Add text if present — Matter drafts attach signal context only on first send
      let textToSend = currentPrompt.trim();
      const pendingMatterDraft = matterChatDraft;
      if (textToSend && pendingMatterDraft && window.electronAPI?.matter) {
        try {
          const built = await window.electronAPI.matter.buildChatPrompt(
            textToSend,
            pendingMatterDraft.itemIds
          );
          textToSend = built.prompt;
        } catch (err) {
          console.warn('[ChatView] Failed to attach Matter context:', err);
        }
      }
      if (textToSend) {
        contentBlocks.push({
          type: 'text',
          text: textToSend,
        });
      }

      // Send message with content blocks
      await continueSession(activeSessionId, contentBlocks);

      if (pendingMatterDraft) {
        clearMatterChatDraft(activeSessionId);
      }

      // Clean up
      setPrompt('');
      if (textareaRef.current) {
        textareaRef.current.value = '';
      }
      pastedImages.forEach((img) => URL.revokeObjectURL(img.url));
      setPastedImages([]);
      setAttachedFiles([]);
      setAttachedMeetings([]);
      setAttachedReferences([]);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleStop = () => {
    if (activeSessionId) {
      stopSession(activeSessionId);
    }
  };

  const handleRemoveQueuedMessage = useCallback(
    (messageId: string) => {
      if (!activeSessionId) return;
      removeQueuedMessage(activeSessionId, messageId);
    },
    [activeSessionId, removeQueuedMessage]
  );

  const handleClearQueuedMessages = useCallback(() => {
    if (!activeSessionId) return;
    // Remove each so backend queue indices stay correct (front-to-back).
    const ids = [...queuedMessages].map((m) => m.id);
    for (const id of ids) {
      removeQueuedMessage(activeSessionId, id);
    }
  }, [activeSessionId, queuedMessages, removeQueuedMessage]);

  // Auto-adjust textarea height based on content / available width
  const adjustTextareaHeight = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    // Reset height to auto to get the correct scrollHeight for current width
    textarea.style.height = 'auto';
    // Cap at ~8 lines; empty/single-line stays compact
    const maxHeight = 200;
    const newHeight = Math.min(textarea.scrollHeight, maxHeight);
    textarea.style.height = `${newHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, []);

  // Adjust height when prompt changes (including clear after send)
  useEffect(() => {
    adjustTextareaHeight();
  }, [prompt, adjustTextareaHeight]);

  // Preview / resize can change composer width — remeasure so wrap doesn't leave a tall empty box
  useEffect(() => {
    if (!activeSessionId) return;
    const textarea = textareaRef.current;
    if (!textarea || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      adjustTextareaHeight();
    });
    observer.observe(textarea);
    return () => observer.disconnect();
  }, [activeSessionId, adjustTextareaHeight]);

  const {
    status: dictationStatus,
    errorKind: dictationErrorKind,
    isAvailable: dictationAvailable,
    toggle: toggleDictation,
  } = useDictation({
    enabled: isElectron,
    getPrompt: () => prompt,
    onTranscript: (next) => {
      setPrompt(next);
    },
  });

  if (!activeSession) {
    return (
      <div className="flex-1 flex items-center justify-center text-text-muted">
        <span>{t('chat.loadingConversation')}</span>
      </div>
    );
  }

  const loopIntervalLabel = chatLoopStatus
    ? formatInterval(msToLoopInterval(chatLoopStatus.intervalMs))
    : '';
  const loopLabel = chatLoopStatus
    ? t(chatLoopStatus.kind === 'goal' ? 'loop.badgeGoal' : 'loop.badge', {
        interval: loopIntervalLabel,
        tick: chatLoopStatus.tickCount,
      })
    : null;
  const queueLabel =
    yorkLlmQueue?.status === 'waiting'
      ? t('yorkLlm.queue.waiting', {
          position: yorkLlmQueue.position,
          activeCount: yorkLlmQueue.activeCount,
          maxConcurrent: yorkLlmQueue.maxConcurrent,
          defaultValue:
            'Waiting for York LLM ({{position}} in queue, {{activeCount}}/{{maxConcurrent}} slots in use)',
        })
      : null;
  const sharedDocLockLabel = sharedDocBlocksComposer
    ? sharedDocViewOnlyOpen
      ? t('chat.sharedDocViewOnlyComposerLocked')
      : t('chat.sharedDocComposerLocked', { name: sharedDocBlockName })
    : null;
  const collabRoomSuffix = collabRoomIdLabel ? ` · ID ${collabRoomIdLabel}` : '';
  const collabStatusLine =
    !collabBlocksComposer && collabState?.connection === 'connected'
      ? `${t('chat.collabSharedBadge')} · ${collabPresenceLabel}${collabRoomSuffix}`
      : collabState && collabState.connection !== 'connected'
        ? `${t(collabState.connection === 'connecting' ? 'chat.collabConnecting' : 'chat.collabOffline')}${collabRoomSuffix}`
        : null;
  const collabWatchingName =
    collabBlocksComposer && collabState?.lease ? collabState.lease.holderName || 'Teammate' : null;
  const collabBanner =
    isSharedChat && (showCollabWaitingPeer || collabWatchingName || collabStatusLine)
      ? {
          waitingForPeer: showCollabWaitingPeer,
          watchingName: collabWatchingName,
          onTakeTurn: () => void handleTakeTurn(),
          statusLine: collabStatusLine,
        }
      : null;
  const textOnly = composerMode === 'image';
  const hasDraftContent =
    Boolean(prompt.trim() || textareaRef.current?.value.trim()) ||
    pastedImages.length > 0 ||
    attachedFiles.length > 0 ||
    attachedMeetings.length > 0 ||
    attachedReferences.length > 0;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
      <ChatHeader
        title={activeSession.title}
        workspaceLabel={activeDivision ? divisionLabel(activeDivision) : 'York GrowthOS'}
        shared={
          isSharedChat
            ? {
                peerCount: collabState?.connection === 'connected' ? collabPeerNames.length : 0,
              }
            : null
        }
        canShare={isElectron && !activeSession.incognito}
        onShare={() => void handleShareChat()}
        onExport={() => void handleExportChat()}
        loopLabel={loopLabel}
        onStopLoop={() => void handleStopChatLoop()}
        connectorCount={activeConnectors.length}
        showConnectorLabel={showConnectorLabel}
        headerRef={headerRef}
        rightActionsRef={rightActionsRef}
        connectorMeasureRef={connectorMeasureRef}
        connectorBadgeRef={connectorBadgeRef}
      />

      <ChatBanners
        incognito={Boolean(activeSession.incognito)}
        loopNotice={loopNotice}
        onDismissLoopNotice={() => setLoopNotice(null)}
        queueLabel={queueLabel}
        sharedDocLockLabel={sharedDocLockLabel}
        collab={collabBanner}
      />

      {/* Messages */}
      <div className="relative min-w-0 flex-1 overflow-hidden">
        <div ref={scrollContainerRef} className="h-full min-w-0 overflow-x-hidden overflow-y-auto">
          <div
            ref={messagesContainerRef}
            className={`mx-auto w-full min-w-0 max-w-[820px] space-y-6 pb-10 pt-8 ${
              showMessagePointers ? MESSAGE_POINTERS_GUTTER_CLASS : 'px-5 lg:px-8'
            }`}
          >
            {displayedMessages.length === 0 ? (
              <ChatEmptyState matterContext={matterChatDraft?.contextSummary} />
            ) : (
              displayedMessages.map((message, index) => {
                const isStreaming =
                  typeof message.id === 'string' && message.id.startsWith('partial-');
                const isLastAssistant =
                  message.role === 'assistant' &&
                  !isStreaming &&
                  !displayedMessages.slice(index + 1).some((item) => item.role === 'assistant');
                return (
                  <div
                    key={message.id}
                    data-message-id={message.id}
                    data-role={message.role}
                    className="min-w-0 max-w-full"
                  >
                    <MessageCard
                      message={message}
                      isStreaming={isStreaming}
                      allMessages={displayedMessages}
                      onRegenerate={
                        isLastAssistant && !canStop
                          ? () => {
                              void continueSession(message.sessionId, '');
                            }
                          : undefined
                      }
                    />
                  </div>
                );
              })
            )}

            <SubagentTracker sessionId={activeSessionId} />

            <ChatActivity
              processingLabel={showProcessingIndicator ? processingStatusLabel : null}
              elapsedLabel={liveElapsed > 0 ? formatExecutionTime(liveElapsed) : null}
              running={timerActive}
            />

            <div ref={messagesEndRef} />
          </div>
        </div>
        <MessagePointers
          messages={displayedMessages}
          scrollContainerRef={scrollContainerRef}
          onNavigate={() => {
            isUserAtBottomRef.current = false;
          }}
        />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-gradient-to-t from-background to-transparent" />
      </div>

      {/* Composer */}
      <div className="min-w-0 shrink-0 bg-background">
        <div className="mx-auto w-full min-w-0 max-w-[820px] space-y-2 px-3 pb-3 pt-1 sm:px-5 lg:px-8">
          {queuedCount > 0 && (
            <MessageQueueList
              messages={queuedMessages}
              onRemove={handleRemoveQueuedMessage}
              onClearAll={handleClearQueuedMessages}
            />
          )}
          <form
            onSubmit={handleSubmit}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className="relative w-full"
          >
            <ComposerAttachments
              images={pastedImages}
              files={attachedFiles}
              meetings={attachedMeetings}
              references={attachedReferences}
              onRemoveImage={removeImage}
              onRemoveFile={removeFile}
              onRemoveMeeting={(meetingId) =>
                setAttachedMeetings((prev) => prev.filter((item) => item.meetingId !== meetingId))
              }
              onToggleMeetingTranscript={(meetingId, include) =>
                setAttachedMeetings((prev) =>
                  prev.map((item) =>
                    item.meetingId === meetingId ? { ...item, includeTranscript: include } : item
                  )
                )
              }
              onRemoveReference={(reference) =>
                setAttachedReferences((prev) =>
                  prev.filter(
                    (item) =>
                      !(
                        item.source === reference.source && item.externalId === reference.externalId
                      )
                  )
                )
              }
            />

            <ToolsHealthNote variant="chat" />

            <div
              className={`composer-shell relative flex min-w-0 flex-col gap-2 rounded-[14px] border border-border bg-surface px-3 pb-2 pt-3 shadow-soft transition-[border-color,box-shadow] focus-within:border-accent focus-within:ring-[3px] focus-within:ring-accent/15 ${
                isDragging ? 'border-accent bg-accent/5 ring-[3px] ring-accent/15' : ''
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

              <textarea
                ref={textareaRef}
                value={prompt}
                spellCheck={true}
                onChange={(e) => {
                  setPrompt(e.target.value);
                  setCursorIndex(e.target.selectionStart ?? e.target.value.length);
                  adjustTextareaHeight();
                }}
                onSelect={(e) => {
                  const target = e.target as HTMLTextAreaElement;
                  setCursorIndex(target.selectionStart ?? target.value.length);
                }}
                onKeyUp={(e) => {
                  const target = e.target as HTMLTextAreaElement;
                  setCursorIndex(target.selectionStart ?? target.value.length);
                }}
                onClick={(e) => {
                  const target = e.target as HTMLTextAreaElement;
                  setCursorIndex(target.selectionStart ?? target.value.length);
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
                  if (
                    !e.nativeEvent.isComposing &&
                    !isComposingRef.current &&
                    handleComposerTextKeyDown(e, e.currentTarget)
                  ) {
                    return;
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
                placeholder={
                  composerMode === 'image'
                    ? t('composer.imagePromptPlaceholder')
                    : t('chat.typeMessageSkillHint')
                }
                disabled={isSubmitting || collabBlocksComposer || sharedDocBlocksComposer}
                rows={1}
                className="w-full min-w-0 resize-none overflow-hidden border-none bg-transparent px-0.5 py-0.5 text-[14.5px] leading-6 text-text-primary outline-none placeholder:text-text-muted"
              />

              <div className="composer-toolbar">
                <div className="flex min-w-0 items-center gap-1">
                  <ComposerAttachMenu
                    menuRef={attachMenuRef}
                    open={attachMenuOpen}
                    onToggle={() => {
                      setLoopMenuOpen(false);
                      setAttachMenuOpen((open) => !open);
                    }}
                    onClose={() => setAttachMenuOpen(false)}
                    filesOnly={textOnly}
                    workingDir={
                      isElectron && activeSessionId
                        ? {
                            label: activeSession.cwd
                              ? activeSession.cwd.split(/[/\\]/).pop() || activeSession.cwd
                              : t('welcome.changeWorkingFolder'),
                            title: isSessionRunning
                              ? t('welcome.changeWorkingFolderWhileRunning')
                              : activeSession.cwd || undefined,
                            disabled: isSessionRunning,
                            onChange: () => void handleChangeWorkingDir(),
                          }
                        : null
                    }
                    onAttachFiles={() => void handleFileSelect()}
                    onMentionSkill={
                      skillsDisabled
                        ? null
                        : () => {
                            openSkillPicker();
                            requestAnimationFrame(() => textareaRef.current?.focus());
                          }
                    }
                    onAttachMeeting={
                      meetingsReferenceAllowed ? () => setMeetingPickerOpen(true) : null
                    }
                    onPickReference={isElectron ? setReferencePickerSource : null}
                    skillsToggle={
                      activeSessionId
                        ? {
                            disabled: skillsDisabled,
                            onToggle: () =>
                              setSessionSkillsDisabled(activeSessionId, !skillsDisabled),
                          }
                        : null
                    }
                  />

                  <ComposerModeDropdown disabled={isSubmitting} />

                  {!textOnly && skillsDisabled && activeSessionId && (
                    <button
                      type="button"
                      onClick={() => setSessionSkillsDisabled(activeSessionId, false)}
                      className="flex h-8 shrink-0 items-center gap-1 rounded-lg px-2 text-[12px] font-medium text-text-muted transition-colors hover:bg-surface-hover hover:text-text-primary"
                      title={t('skills.enableForChat')}
                    >
                      <PackageX className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">{t('skills.disabledForChatBadge')}</span>
                    </button>
                  )}

                  {!textOnly && isElectron && activeSession.cwd && (
                    <button
                      type="button"
                      onClick={() => void handleChangeWorkingDir()}
                      disabled={isSessionRunning}
                      className="composer-working-dir flex h-8 min-w-0 max-w-[10rem] shrink items-center gap-1 rounded-lg px-2 text-xs text-text-muted transition-colors hover:bg-surface-hover hover:text-text-primary disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-text-muted"
                      title={
                        isSessionRunning
                          ? t('welcome.changeWorkingFolderWhileRunning')
                          : `${t('welcome.changeWorkingFolder')}: ${activeSession.cwd}`
                      }
                    >
                      <FolderOpen className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">{activeSession.cwd.split(/[/\\]/).pop()}</span>
                    </button>
                  )}

                  {!textOnly && isElectron && (
                    <div className="relative" ref={loopMenuRef}>
                      <button
                        type="button"
                        onClick={() => {
                          setAttachMenuOpen(false);
                          setLoopMenuOpen((open) => !open);
                        }}
                        className={`flex h-8 w-8 items-center justify-center rounded-lg transition-colors ${
                          chatLoopStatus || loopMenuOpen
                            ? 'bg-accent/10 text-accent hover:bg-accent/15'
                            : 'text-text-muted hover:bg-surface-hover hover:text-text-primary'
                        }`}
                        title={t('loop.menuButton')}
                        aria-label={t('loop.menuButton')}
                        aria-expanded={loopMenuOpen}
                        aria-haspopup="dialog"
                      >
                        <RefreshCw className="h-4 w-4" />
                      </button>
                      <ChatLoopPanel
                        open={loopMenuOpen}
                        initialText={prompt.trim()}
                        activeStatus={chatLoopStatus}
                        onClose={() => setLoopMenuOpen(false)}
                        onStart={async ({
                          kind,
                          prompt: loopPrompt,
                          intervalMs,
                          maxIterations,
                        }) => {
                          await startChatLoop({
                            kind,
                            prompt: loopPrompt,
                            intervalMs,
                            maxIterations,
                          });
                          setPrompt('');
                          if (textareaRef.current) textareaRef.current.value = '';
                        }}
                        onStop={async () => {
                          await handleStopChatLoop();
                        }}
                      />
                    </div>
                  )}
                </div>

                <div className="composer-toolbar-end">
                  {!textOnly && <ThinkingModeToggle />}
                  {!textOnly && <ModelSelector />}
                  <HubBudgetMeter />

                  {dictationAvailable && (
                    <DictationButton
                      status={dictationStatus}
                      errorKind={dictationErrorKind}
                      disabled={isSubmitting}
                      onToggle={toggleDictation}
                    />
                  )}

                  {canStop && (
                    <button
                      type="button"
                      onClick={handleStop}
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border bg-background text-text-primary transition-colors hover:border-error/40 hover:bg-error/10 hover:text-error"
                      title={t('chat.stop')}
                      aria-label={t('chat.stop')}
                    >
                      <Square className="h-3 w-3 fill-current" />
                    </button>
                  )}
                  <button
                    type="submit"
                    disabled={!hasDraftContent || isSubmitting}
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
                    title={t('chat.sendMessage')}
                    aria-label={t('chat.sendMessage')}
                  >
                    <ArrowUp className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </div>

            {dictationStatus === 'error' && dictationErrorKind === 'client_outdated' ? (
              <ClientOutdatedUpdateActions className="mt-2" />
            ) : null}

            <YorkLlmRoutineTip prompt={prompt} />

            <p className="mt-2 text-center text-[11px] text-text-muted/70">
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
      <ConnectorReferencePicker
        open={referencePickerSource !== null}
        source={referencePickerSource}
        onClose={() => setReferencePickerSource(null)}
        excludeIds={attachedReferences.map((item) => item.externalId)}
        onSelect={(item) => {
          setAttachedReferences((prev) =>
            prev.some((ref) => ref.source === item.source && ref.externalId === item.externalId)
              ? prev
              : [
                  ...prev,
                  {
                    type: 'external_reference',
                    source: item.source,
                    externalId: item.externalId,
                    title: item.title,
                    url: item.url,
                    subtitle: item.subtitle,
                    meta: item.meta,
                  },
                ]
          );
        }}
      />
    </div>
  );
}
