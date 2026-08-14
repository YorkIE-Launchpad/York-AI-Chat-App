import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../store';
import { useIPC } from '../hooks/useIPC';
import type { ContentBlock, Skill } from '../types';
import { getInitialSessionTitle } from '../../shared/session-title';
import type { WelcomeActionIcon, WelcomeQuickAction } from '../../shared/welcome-actions';
import { DivisionChooser } from './DivisionChooser';
import {
  FileText,
  BarChart3,
  FolderOpen,
  ArrowRight,
  Mail,
  X,
  Paperclip,
  BookOpen,
  FileSearch,
  Users,
  Briefcase,
  Rocket,
  Calendar,
  ClipboardList,
  Target,
  Presentation,
  Search,
  Shuffle,
  Mic,
  RefreshCw,
  Plus,
  Ghost,
  Package,
  type LucideIcon,
} from 'lucide-react';

type AttachedFile = {
  name: string;
  path: string;
  size: number;
  type: string;
  inlineDataBase64?: string;
};

import welcomeLogoSrc from '../assets/logo.png';
import { ModelSelector } from './ModelSelector';
import { HubBudgetMeter } from './HubBudgetMeter';
import { ThinkingModeToggle } from './ThinkingModeToggle';
import { OpenRouterKeyGateBanner } from './OpenRouterKeyGateBanner';
import { SlashCommandMenu } from './SlashCommandMenu';
import {
  useSlashCommands,
  isMeetingSlashSkill,
  isLoopStopBuiltinSkill,
} from '../hooks/useSlashCommands';
import { applySkillTriggerSelection } from '../../shared/skill-composer-trigger';
import { MeetingPicker, type AttachedMeeting } from './MeetingPicker';
import { ChatLoopPanel } from './ChatLoopPanel';
import { AttachmentImageThumb, FileAttachmentChip } from './attachments';
import { isImageExtension } from '../utils/attachment-preview';
import {
  isBrowserFileImage,
  loadComposerImageFromPath,
  mimeForAttachedFile,
  normalizeSelectedFiles,
} from '../utils/load-composer-image';
import { useDictation } from '../hooks/useDictation';
import { DictationButton } from './DictationButton';
import { ClientOutdatedUpdateActions } from './ClientOutdatedUpdateActions';
import {
  formatInterval,
  isLoopSlashInput,
  msToLoopInterval,
  parseLoopCommand,
} from '../../shared/loop/parse';
import { DEFAULT_GOAL_MAX_ITERATIONS } from '../../shared/loop/types';
import { needsOpenRouterUserKey } from '../../shared/openrouter-user-key';
import { divisionBudgetCheckKey } from '../../shared/fe-budget-gate';

const WELCOME_ICON_MAP: Record<WelcomeActionIcon, LucideIcon> = {
  FileText,
  BarChart3,
  FolderOpen,
  Mail,
  BookOpen,
  FileSearch,
  Users,
  Briefcase,
  Rocket,
  Calendar,
  ClipboardList,
  Target,
  Presentation,
  Search,
};

function buildI18nFallbackChips(t: (key: string) => string): WelcomeQuickAction[] {
  return [
    {
      id: 'draft-ic-memo',
      label: t('welcome.draftIcMemo'),
      prompt: t('welcome.quickPromptDraftIcMemo'),
      icon: 'FileText',
    },
    {
      id: 'prep-diligence',
      label: t('welcome.prepDiligence'),
      prompt: t('welcome.quickPromptPrepDiligence'),
      icon: 'ClipboardList',
    },
    {
      id: 'hub-timesheet',
      label: t('welcome.logHubTimesheet'),
      prompt: t('welcome.quickPromptHubTimesheet'),
      icon: 'Calendar',
      requiresConnectorName: 'York IE HUB',
    },
    {
      id: 'launchpad-release',
      label: t('welcome.checkLaunchpadRelease'),
      prompt: t('welcome.quickPromptLaunchpadRelease'),
      icon: 'Rocket',
      requiresConnectorName: 'R&D Launchpad',
    },
    {
      id: 'gtm-pipeline',
      label: t('welcome.gtmPipelineSnapshot'),
      prompt: t('welcome.quickPromptGtmPipeline'),
      icon: 'Target',
      requiresConnectorName: 'GTM Pulse',
    },
    {
      id: 'client-deck',
      label: t('welcome.buildClientDeck'),
      prompt: t('welcome.quickPromptClientDeck'),
      icon: 'Presentation',
    },
  ];
}

export function WelcomeView() {
  const { t } = useTranslation();
  const [prompt, setPrompt] = useState('');
  const [cursorIndex, setCursorIndex] = useState(0);
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const isComposingRef = useRef(false);
  const [pastedImages, setPastedImages] = useState<
    Array<{ url: string; base64: string; mediaType: string }>
  >([]);
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
  const [attachedMeetings, setAttachedMeetings] = useState<AttachedMeeting[]>([]);
  const [meetingPickerOpen, setMeetingPickerOpen] = useState(false);
  const [actionsMenuOpen, setActionsMenuOpen] = useState(false);
  const [loopMenuOpen, setLoopMenuOpen] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [quickActions, setQuickActions] = useState<WelcomeQuickAction[] | null>(null);
  const [welcomeTagline, setWelcomeTagline] = useState<string | null>(null);
  const [isShufflingActions, setIsShufflingActions] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const actionsMenuRef = useRef<HTMLDivElement>(null);
  const { startSession, changeWorkingDir, isElectron } = useIPC();
  const workingDir = useAppStore((state) => state.workingDir);
  const activeDivision = useAppStore((state) => state.activeDivision);
  const appConfig = useAppStore((state) => state.appConfig);
  const hubUsage = useAppStore((state) => state.hubUsage);
  const incognitoDraft = useAppStore((state) => state.incognitoDraft);
  const setIncognitoDraft = useAppStore((state) => state.setIncognitoDraft);
  const setGlobalNotice = useAppStore((state) => state.setGlobalNotice);
  const openRouterKeyRequired = needsOpenRouterUserKey(
    activeDivision,
    appConfig?.openRouterUserApiKey,
    {
      activeSource: hubUsage?.activeSource,
      budgetReady: hubUsage?.checkedDivisionKey === divisionBudgetCheckKey(activeDivision),
    }
  );
  const canSubmit =
    !openRouterKeyRequired &&
    (prompt.trim().length > 0 ||
      pastedImages.length > 0 ||
      attachedFiles.length > 0 ||
      attachedMeetings.length > 0);
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
  } = useSlashCommands(prompt, cursorIndex);

  const fallbackChips = useMemo(() => buildI18nFallbackChips(t), [t]);
  const displayChips = quickActions ?? fallbackChips;
  const displayTagline = welcomeTagline ?? t('welcome.title');

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const api = window.electronAPI?.welcome;
        if (!api?.getQuickActions) return;
        const result = await api.getQuickActions();
        if (cancelled) return;
        if (result?.chips?.length) {
          setQuickActions(result.chips);
        }
        if (result?.tagline?.trim()) {
          setWelcomeTagline(result.tagline.trim());
        }
      } catch {
        // Keep i18n fallback chips / tagline
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleShuffleQuickActions = useCallback(async () => {
    const api = window.electronAPI?.welcome;
    if (!api?.regenerateQuickActions || isShufflingActions) return;
    setIsShufflingActions(true);
    setSelectedTag(null);
    try {
      const result = await api.regenerateQuickActions();
      if (result?.chips?.length) {
        setQuickActions(result.chips);
      }
      if (result?.tagline?.trim()) {
        setWelcomeTagline(result.tagline.trim());
      }
    } catch {
      setGlobalNotice({
        id: `notice-welcome-shuffle-${Date.now()}`,
        type: 'warning',
        message: t('welcome.shuffleActionsFailed'),
      });
    } finally {
      setIsShufflingActions(false);
    }
  }, [isShufflingActions, setGlobalNotice, t]);

  const handleSelectSlashSkill = useCallback(
    (skill: Skill) => {
      if (isMeetingSlashSkill(skill)) {
        setPrompt('');
        setCursorIndex(0);
        closeSlashMenu();
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
    [closeSlashMenu, cursorIndex, prompt, skillTrigger]
  );

  useEffect(() => {
    if (!actionsMenuOpen && !loopMenuOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!actionsMenuRef.current?.contains(event.target as Node)) {
        setActionsMenuOpen(false);
        setLoopMenuOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setActionsMenuOpen(false);
        setLoopMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [actionsMenuOpen, loopMenuOpen]);

  const clearComposer = useCallback(() => {
    setPastedImages((prev) => {
      prev.forEach((img) => URL.revokeObjectURL(img.url));
      return [];
    });
    setPrompt('');
    if (textareaRef.current) {
      textareaRef.current.value = '';
    }
    setAttachedFiles([]);
    setAttachedMeetings([]);
  }, []);

  const startSessionWithLoop = useCallback(
    async (input: {
      kind: 'interval' | 'goal';
      prompt: string;
      intervalMs: number;
      maxIterations?: number | null;
    }) => {
      if (!isElectron || !window.electronAPI.loop) {
        throw new Error(t('loop.startFailed'));
      }
      const contentBlocks: ContentBlock[] = [{ type: 'text', text: input.prompt }];
      const sessionTitle = getInitialSessionTitle(input.prompt);
      const session = await startSession(sessionTitle, contentBlocks, workingDir || undefined, {
        incognito: incognitoDraft || undefined,
      });
      if (!session?.id) {
        throw new Error(t('loop.startFailed'));
      }
      // First turn already ran via startSession — arm the timer only.
      await window.electronAPI.loop.start({
        sessionId: session.id,
        kind: input.kind,
        prompt: input.prompt,
        intervalMs: input.intervalMs,
        maxIterations:
          input.kind === 'goal' ? (input.maxIterations ?? DEFAULT_GOAL_MAX_ITERATIONS) : null,
        runImmediately: false,
      });
      setGlobalNotice({
        id: `loop-welcome-${Date.now()}`,
        type: 'success',
        message:
          input.kind === 'goal'
            ? t('loop.goalStarted', {
                interval: formatInterval(msToLoopInterval(input.intervalMs)),
                max: input.maxIterations ?? DEFAULT_GOAL_MAX_ITERATIONS,
              })
            : t('loop.started', {
                interval: formatInterval(msToLoopInterval(input.intervalMs)),
              }),
      });
      clearComposer();
      setLoopMenuOpen(false);
    },
    [clearComposer, incognitoDraft, isElectron, setGlobalNotice, startSession, t, workingDir]
  );

  const handleSelectFolder = async () => {
    try {
      const result = await changeWorkingDir(undefined, workingDir || undefined);
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
          mediaType: resizedBlob.type,
        });
      } catch (err) {
        console.error('Failed to process pasted image:', err);
      }
    }

    setPastedImages((prev) => [...prev, ...newImages]);
  };

  const blobToBase64 = (blob: Blob): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const result = reader.result as string;
        // Remove data URL prefix (e.g., "data:image/png;base64,")
        const base64 = result.split(',')[1];
        resolve(base64);
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
      console.log('[WelcomeView] Not in Electron, file selection not available');
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
      console.error('[WelcomeView] Error selecting files:', error);
    }
  };

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
          console.error('Failed to process dropped image:', err);
        }
      }

      setPastedImages((prev) => [...prev, ...newImages]);
    }

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

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();

    // Get value from ref to handle both controlled and uncontrolled cases
    const currentPrompt = textareaRef.current?.value || prompt;

    if (
      (!currentPrompt.trim() &&
        pastedImages.length === 0 &&
        attachedFiles.length === 0 &&
        attachedMeetings.length === 0) ||
      isSubmitting ||
      openRouterKeyRequired
    )
      return;

    // Intercept /loop and /goal on the main welcome composer
    if (isElectron && isLoopSlashInput(currentPrompt.trim())) {
      setIsSubmitting(true);
      try {
        const parsed = parseLoopCommand(currentPrompt.trim());
        if (parsed.type === 'usage') {
          setGlobalNotice({
            id: `loop-usage-${Date.now()}`,
            type: 'info',
            message: t('loop.usage'),
          });
          return;
        }
        if (parsed.type === 'stop') {
          setGlobalNotice({
            id: `loop-stop-welcome-${Date.now()}`,
            type: 'info',
            message: t('loop.stopNeedsSession'),
          });
          return;
        }
        if (parsed.type === 'loop' || parsed.type === 'goal') {
          await startSessionWithLoop({
            kind: parsed.type === 'goal' ? 'goal' : 'interval',
            prompt: parsed.type === 'goal' ? parsed.goal : parsed.prompt,
            intervalMs: parsed.interval.ms,
            maxIterations: parsed.type === 'goal' ? parsed.maxIterations : null,
          });
          return;
        }
      } catch (err) {
        setGlobalNotice({
          id: `loop-start-${Date.now()}`,
          type: 'error',
          message: err instanceof Error ? err.message : t('loop.startFailed'),
        });
        return;
      } finally {
        setIsSubmitting(false);
      }
    }

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
        relativePath: file.path,
        size: file.size,
        mimeType: file.type,
        inlineDataBase64: file.inlineDataBase64,
      });
    }

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

    // Use the global working directory (always available after app startup)
    setIsSubmitting(true);
    try {
      const sessionTitle = getInitialSessionTitle(
        currentPrompt,
        attachedFiles[0]?.name || attachedMeetings[0]?.title
      );
      const session = await startSession(sessionTitle, contentBlocks, workingDir || undefined, {
        incognito: incognitoDraft || undefined,
      });
      if (session) {
        clearComposer();
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleTagClick = (tag: string, tagPrompt: string) => {
    setSelectedTag(tag === selectedTag ? null : tag);
    if (tag !== selectedTag) {
      setPrompt(tagPrompt);
      if (textareaRef.current) {
        textareaRef.current.value = tagPrompt;
        // Trigger height adjustment
        adjustTextareaHeight();
      }
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

  // Adjust height when prompt changes
  useEffect(() => {
    adjustTextareaHeight();
  }, [prompt]);

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

  return (
    <div
      className={`flex-1 min-h-0 flex flex-col items-center px-5 py-10 md:px-8 md:py-14 ${
        !activeDivision ? 'overflow-hidden' : 'overflow-y-auto'
      }`}
    >
      <div
        className={`max-w-[840px] w-full animate-fade-in ${
          !activeDivision ? 'flex min-h-0 flex-1 flex-col space-y-7' : 'my-auto space-y-7'
        }`}
      >
        <div className="shrink-0 space-y-4 text-center">
          <div className="flex items-center justify-center gap-4">
            <img
              src={welcomeLogoSrc}
              alt={t('welcome.logoAlt')}
              className="w-16 h-16 md:w-20 md:h-20 object-contain"
            />
            <div className="text-left">
              <h1 className="text-[2.35rem] md:text-[3.1rem] leading-none font-semibold tracking-[-0.05em] text-text-primary">
                York GrowthOS
              </h1>
            </div>
          </div>
          {!activeDivision ? (
            <p className="heading-serif text-[1.15rem] md:text-[1.45rem] font-medium tracking-[-0.02em] text-text-secondary text-center">
              Pick a workspace to get started
            </p>
          ) : (
            <p className="heading-serif text-[1.15rem] md:text-[1.45rem] font-medium tracking-[-0.02em] text-text-secondary text-center">
              {displayTagline}
            </p>
          )}
          {incognitoDraft && (
            <div className="mt-3 inline-flex items-center gap-2 rounded-full border border-dashed border-border-subtle bg-background/70 px-3 py-1.5 text-xs text-text-secondary">
              <Ghost className="w-3.5 h-3.5 text-text-muted" />
              <span className="font-medium text-text-primary">{t('welcome.incognitoActive')}</span>
              <span className="text-text-muted">·</span>
              <span>{t('welcome.incognitoActiveHint')}</span>
              <button
                type="button"
                onClick={() => setIncognitoDraft(false)}
                className="ml-1 rounded-full p-0.5 text-text-muted hover:text-text-primary hover:bg-surface-hover transition-colors"
                title={t('common.close')}
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          )}
        </div>

        {!activeDivision ? (
          <DivisionChooser />
        ) : (
          <>
            <OpenRouterKeyGateBanner />
            {/* Quick Action Tags */}
            <div className="flex flex-wrap gap-2 justify-center items-center px-3">
              {displayChips.map((tag) => {
                const Icon = WELCOME_ICON_MAP[tag.icon] ?? FileText;
                const connectorBadge = tag.requiresConnectorName?.trim() || null;
                return (
                  <button
                    key={tag.id}
                    type="button"
                    onClick={() => handleTagClick(tag.id, tag.prompt)}
                    disabled={isShufflingActions}
                    className={`inline-flex items-center gap-2 rounded-full border px-3 py-2 text-sm transition-colors ${
                      selectedTag === tag.id
                        ? 'border-accent/30 bg-accent-muted text-accent'
                        : 'border-border-subtle bg-background/65 text-text-secondary hover:bg-surface-hover hover:text-text-primary'
                    } ${connectorBadge ? 'relative' : ''} ${isShufflingActions ? 'opacity-60' : ''}`}
                  >
                    <Icon
                      className={`w-4 h-4 ${selectedTag === tag.id ? 'text-accent' : 'text-text-muted'}`}
                    />
                    <span>{tag.label}</span>
                    {connectorBadge && (
                      <span className="ml-1 px-1.5 py-px text-[9px] rounded bg-surface-active text-text-muted">
                        {connectorBadge}
                      </span>
                    )}
                  </button>
                );
              })}
              <button
                type="button"
                onClick={() => void handleShuffleQuickActions()}
                disabled={isShufflingActions}
                title={t('welcome.shuffleActions')}
                aria-label={t('welcome.shuffleActions')}
                className="inline-flex items-center justify-center w-8 h-8 rounded-full border border-border-subtle bg-background/65 text-text-muted hover:bg-surface-hover hover:text-text-primary transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Shuffle className={`w-3.5 h-3.5 ${isShufflingActions ? 'animate-spin' : ''}`} />
              </button>
            </div>

            {/* Main Input Card - Right aligned */}
            <form
              onSubmit={handleSubmit}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              className={`relative rounded-[1.9rem] border border-border-muted bg-background/85 shadow-soft px-5 py-5 space-y-4 transition-colors ${
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
              {/* Image previews */}
              {pastedImages.length > 0 && (
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2 pb-2 border-b border-border w-full">
                  {pastedImages.map((img, index) => (
                    <AttachmentImageThumb
                      key={img.url || `pasted-image-${index}`}
                      src={img.url}
                      alt={t('welcome.pastedImageAlt', { index: index + 1 })}
                      variant="grid"
                      removeButton={
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            removeImage(index);
                          }}
                          title={t('common.removeImage')}
                          aria-label={t('common.removeImage')}
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
                          title={t('common.removeFile')}
                          aria-label={t('common.removeFile')}
                          className="w-6 h-6 rounded-full bg-error/10 hover:bg-error/20 text-error flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      }
                    />
                  ))}
                </div>
              )}

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
                        title={t('common.removeMeeting')}
                        aria-label={t('common.removeMeeting')}
                        className="w-6 h-6 rounded-full bg-error/10 hover:bg-error/20 text-error flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* Text Input - Auto-resizing */}
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
                placeholder={t('welcome.placeholderSkillHint')}
                rows={1}
                style={{ minHeight: '72px', maxHeight: '200px' }}
                className="w-full resize-none bg-transparent border-none outline-none text-text-primary placeholder:text-text-muted text-base leading-relaxed overflow-hidden"
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
              />

              {/* Bottom Actions */}
              <div className="flex items-center justify-between gap-3 pt-3 border-t border-border-muted">
                <div className="flex min-w-0 items-center gap-2">
                  <div className="relative" ref={actionsMenuRef}>
                    <button
                      type="button"
                      onClick={() => {
                        setLoopMenuOpen(false);
                        setActionsMenuOpen((open) => !open);
                      }}
                      className={`flex h-9 w-9 items-center justify-center rounded-2xl transition-colors ${
                        actionsMenuOpen || loopMenuOpen
                          ? 'bg-accent/10 text-accent'
                          : 'text-text-muted hover:bg-surface-hover hover:text-text-primary'
                      }`}
                      title={t('welcome.actionsMenu')}
                      aria-label={t('welcome.actionsMenu')}
                      aria-expanded={actionsMenuOpen || loopMenuOpen}
                      aria-haspopup="menu"
                    >
                      <Plus className="h-5 w-5" />
                    </button>
                    {actionsMenuOpen && (
                      <div
                        role="menu"
                        className="absolute bottom-[calc(100%+8px)] left-0 z-30 min-w-[14rem] overflow-hidden rounded-[1.25rem] border border-border-subtle bg-background shadow-elevated"
                      >
                        <div className="space-y-0.5 p-1.5">
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setActionsMenuOpen(false);
                              void handleSelectFolder();
                            }}
                            className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-text-primary transition-colors hover:bg-surface-hover"
                          >
                            <FolderOpen
                              className={`h-4 w-4 ${workingDir ? 'text-text-muted' : 'text-accent'}`}
                            />
                            <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                              {workingDir
                                ? workingDir.split(/[/\\]/).pop()
                                : t('welcome.selectWorkingFolder')}
                            </span>
                          </button>
                          {isElectron && (
                            <button
                              type="button"
                              role="menuitem"
                              onClick={() => {
                                setActionsMenuOpen(false);
                                void handleFileSelect();
                              }}
                              className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-text-primary transition-colors hover:bg-surface-hover"
                            >
                              <Paperclip className="h-4 w-4 text-text-muted" />
                              <span className="text-[13px] font-medium">
                                {t('welcome.attachFiles')}
                              </span>
                            </button>
                          )}
                          {isElectron && (
                            <button
                              type="button"
                              role="menuitem"
                              onClick={() => {
                                setActionsMenuOpen(false);
                                openSkillPicker();
                                requestAnimationFrame(() => textareaRef.current?.focus());
                              }}
                              className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-text-primary transition-colors hover:bg-surface-hover"
                            >
                              <Package className="h-4 w-4 text-accent" />
                              <span className="text-[13px] font-medium">
                                {t('skills.mentionFromMenu')}
                              </span>
                            </button>
                          )}
                          {isElectron && meetingsReferenceAllowed && (
                            <button
                              type="button"
                              role="menuitem"
                              onClick={() => {
                                setActionsMenuOpen(false);
                                setMeetingPickerOpen(true);
                              }}
                              className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-text-primary transition-colors hover:bg-surface-hover"
                            >
                              <Mic className="h-4 w-4 text-accent" />
                              <span className="text-[13px] font-medium">
                                {t('meetings.attachMeeting')}
                              </span>
                            </button>
                          )}
                          {isElectron && (
                            <button
                              type="button"
                              role="menuitem"
                              onClick={() => {
                                setActionsMenuOpen(false);
                                setLoopMenuOpen(true);
                              }}
                              className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-text-primary transition-colors hover:bg-surface-hover"
                            >
                              <RefreshCw className="h-4 w-4 text-text-muted" />
                              <span className="text-[13px] font-medium">
                                {t('loop.menuButton')}
                              </span>
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                    <ChatLoopPanel
                      open={loopMenuOpen}
                      align="left"
                      initialText={prompt.trim()}
                      activeStatus={null}
                      onClose={() => setLoopMenuOpen(false)}
                      onStart={async ({
                        kind,
                        prompt: loopPrompt,
                        intervalMs,
                        maxIterations,
                      }) => {
                        setIsSubmitting(true);
                        try {
                          await startSessionWithLoop({
                            kind,
                            prompt: loopPrompt,
                            intervalMs,
                            maxIterations,
                          });
                        } finally {
                          setIsSubmitting(false);
                        }
                      }}
                      onStop={async () => {
                        setLoopMenuOpen(false);
                      }}
                    />
                  </div>
                  {workingDir && (
                    <span
                      className="min-w-0 max-w-[10rem] truncate text-xs text-text-muted"
                      title={workingDir}
                    >
                      {workingDir.split(/[/\\]/).pop()}
                    </span>
                  )}
                </div>

                <div className="flex flex-shrink-0 items-center gap-2">
                  <ThinkingModeToggle />
                  <ModelSelector />
                  <HubBudgetMeter />
                  {dictationAvailable && (
                    <DictationButton
                      status={dictationStatus}
                      errorKind={dictationErrorKind}
                      disabled={isSubmitting}
                      onToggle={toggleDictation}
                    />
                  )}
                  <button
                    type="submit"
                    disabled={!canSubmit || isSubmitting}
                    className="btn btn-primary px-5 py-2.5 rounded-2xl disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <span>{isSubmitting ? t('welcome.starting') : t('welcome.letsGo')}</span>
                    <ArrowRight className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </form>
            {dictationStatus === 'error' && dictationErrorKind === 'client_outdated' ? (
              <ClientOutdatedUpdateActions className="mt-3" />
            ) : null}
          </>
        )}
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
