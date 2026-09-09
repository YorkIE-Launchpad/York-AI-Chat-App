import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../store';
import { useIPC } from '../hooks/useIPC';
import { useAuth } from '../auth/AuthContext';
import {
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Trash2,
  Pin,
  Pencil,
  Moon,
  Sun,
  Monitor,
  Settings,
  Search as SearchIcon,
  Plus,
  ListChecks,
  Check,
  LogOut,
  RefreshCw,
  Ghost,
  FileDown,
  Radar,
  Target,
  Workflow,
  Briefcase,
  Building2,
  Folder,
  FolderPlus,
  Layers,
  Users,
  Link2,
} from 'lucide-react';
import type { Session } from '../types';
import { DivisionSwitcher } from './DivisionSwitcher';
import { NextUpMeeting } from './matter/NextUpMeeting';
import {
  activeDivisionFromSession,
  divisionLabel,
  sessionMatchesActiveDivision,
  type ActiveDivision,
  type PersonalFolder,
} from '../../shared/workspace-division';
import type { ChatSearchHit } from '../../shared/chat-search';
import { useUpdaterStatus } from '../hooks/useUpdaterStatus';

import sidebarLogoSrc from '../assets/logo.png';

const FOLDER_TREE_COLLAPSE_KEY = 'yorkie.sidebar.collapsedFolders';

function readCollapsedFolderIds(): Set<string> {
  try {
    const raw = localStorage.getItem(FOLDER_TREE_COLLAPSE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id): id is string => typeof id === 'string'));
  } catch {
    return new Set();
  }
}

function writeCollapsedFolderIds(ids: Set<string>) {
  try {
    localStorage.setItem(FOLDER_TREE_COLLAPSE_KEY, JSON.stringify([...ids]));
  } catch {
    // ignore quota / private mode
  }
}

function workspaceKindIcon(active: ActiveDivision | null | undefined) {
  if (active?.kind === 'hub') return Building2;
  if (active?.kind === 'client') return Users;
  if (active?.kind === 'project') return Briefcase;
  if (active?.kind === 'folder') return Folder;
  return Layers;
}

// Monotonic per-session load tokens so a slow history fetch cannot apply after
// a newer click for the same session (rapid switching).
const sessionMessageLoadIds: Record<string, number> = {};
const sessionTraceLoadIds: Record<string, number> = {};

function sortSessionsLatestFirst(sessions: Session[]): Session[] {
  const sortByUpdatedAt = (a: Session, b: Session) =>
    (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt);

  const pinned: Session[] = [];
  const unpinned: Session[] = [];
  for (const session of sessions) {
    if (session.pinned) pinned.push(session);
    else unpinned.push(session);
  }
  pinned.sort(sortByUpdatedAt);
  unpinned.sort(sortByUpdatedAt);
  return [...pinned, ...unpinned];
}

function userInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function SidebarUserAvatar({
  name,
  image,
  className = 'w-8 h-8 text-[11px]',
}: {
  name: string;
  image?: string | null;
  className?: string;
}) {
  const [resolvedSrc, setResolvedSrc] = useState<string | null>(null);
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setImageFailed(false);
    setResolvedSrc(null);

    if (!image?.trim()) return;

    const trimmed = image.trim();
    if (trimmed.startsWith('data:') || trimmed.startsWith('blob:')) {
      setResolvedSrc(trimmed);
      return;
    }

    const loadViaProxy = async () => {
      const authApi = window.electronAPI?.auth;
      if (authApi?.getAvatarDataUrl) {
        const result = await authApi.getAvatarDataUrl(trimmed);
        if (!cancelled && result.success && result.dataUrl) {
          setResolvedSrc(result.dataUrl);
          return;
        }
        // Hub document keys need the main-process proxy; do not fall back to raw src.
        return;
      }
      // Browser / no IPC: only try direct https URLs (not S3 keys).
      if (!cancelled && /^https?:\/\//i.test(trimmed)) {
        setResolvedSrc(trimmed);
      }
    };

    void loadViaProxy();
    return () => {
      cancelled = true;
    };
  }, [image]);

  const showImage = Boolean(resolvedSrc) && !imageFailed;

  if (showImage && resolvedSrc) {
    return (
      <img
        src={resolvedSrc}
        alt=""
        className={`rounded-full object-cover flex-shrink-0 ${className}`}
        onError={() => setImageFailed(true)}
        referrerPolicy="no-referrer"
      />
    );
  }
  return (
    <div
      className={`rounded-full flex items-center justify-center font-medium bg-accent/15 text-accent flex-shrink-0 ${className}`}
      aria-hidden
    >
      {userInitials(name)}
    </div>
  );
}

function SidebarUpdateButton({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation();
  const {
    status: updaterStatus,
    installing: updaterInstalling,
    quitAndInstall,
  } = useUpdaterStatus();

  if (updaterStatus.status !== 'ready') return null;

  if (compact) {
    return (
      <button
        type="button"
        onClick={() => void quitAndInstall()}
        disabled={updaterInstalling}
        className="w-9 h-9 rounded-2xl flex items-center justify-center bg-accent text-white hover:opacity-90 disabled:opacity-50 transition-opacity"
        title={t('sidebar.restartToUpdate')}
      >
        <RefreshCw className={`w-4 h-4 ${updaterInstalling ? 'animate-spin' : ''}`} />
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={() => void quitAndInstall()}
      disabled={updaterInstalling}
      className="mt-1 w-full inline-flex items-center justify-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-50 transition-opacity"
    >
      <RefreshCw className={`w-3.5 h-3.5 ${updaterInstalling ? 'animate-spin' : ''}`} />
      {t('sidebar.restartToUpdate')}
    </button>
  );
}

export function Sidebar() {
  const { t } = useTranslation();
  const { user, logout } = useAuth();
  const sessions = useAppStore((s) => s.sessions);
  const activeDivision = useAppStore((s) => s.activeDivision);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const settings = useAppStore((s) => s.settings);
  const setActiveSession = useAppStore((s) => s.setActiveSession);
  const openSessionWithDivision = useAppStore((s) => s.openSessionWithDivision);
  const setActiveDivision = useAppStore((s) => s.setActiveDivision);
  const setIncognitoDraft = useAppStore((s) => s.setIncognitoDraft);
  const setMessages = useAppStore((s) => s.setMessages);
  const setTraceSteps = useAppStore((s) => s.setTraceSteps);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const setShowSettings = useAppStore((s) => s.setShowSettings);
  const setShowMatter = useAppStore((s) => s.setShowMatter);
  const setShowWorkflows = useAppStore((s) => s.setShowWorkflows);
  const showMatter = useAppStore((s) => s.showMatter);
  const showWorkflows = useAppStore((s) => s.showWorkflows);
  const matterBadgeCount = useAppStore((s) => s.matterBadgeCount);
  const matterEnabled =
    useAppStore((s) => s.appConfig?.matterEnabled ?? s.appConfig?.matterRuntime?.enabled) !== false;
  const chatLoopBySessionId = useAppStore((s) => s.chatLoopBySessionId);
  const {
    deleteSession,
    batchDeleteSessions,
    setSessionPinned,
    setSessionTitle,
    getSessionMessages,
    getSessionTraceSteps,
    importSession,
    joinCollabSession,
    isElectron,
  } = useIPC();
  const setGlobalNotice = useAppStore((s) => s.setGlobalNotice);
  const [hoveredSession, setHoveredSession] = useState<string | null>(null);
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const skipRenameCommitRef = useRef(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [isSelectMode, setIsSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [importing, setImporting] = useState(false);
  const [joinModalOpen, setJoinModalOpen] = useState(false);
  const [joinInviteDraft, setJoinInviteDraft] = useState('');
  const [joiningShared, setJoiningShared] = useState(false);
  const joinInputRef = useRef<HTMLInputElement>(null);
  const [searchHits, setSearchHits] = useState<ChatSearchHit[]>([]);
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchAllWorkspaces, setSearchAllWorkspaces] = useState(false);
  const [personalFolders, setPersonalFolders] = useState<PersonalFolder[]>([]);
  const [collapsedFolderIds, setCollapsedFolderIds] = useState<Set<string>>(readCollapsedFolderIds);
  const [newFolderName, setNewFolderName] = useState('');
  const [creatingFolder, setCreatingFolder] = useState(false);
  const foldersSeededRef = useRef(false);

  const isFoldersWorkspace = activeDivision?.kind === 'folder';
  const normalizedQuery = useMemo(() => searchQuery.trim().toLowerCase(), [searchQuery]);
  const isSearching = normalizedQuery.length > 0;
  const divisionSessions = useMemo(
    () => sessions.filter((session) => sessionMatchesActiveDivision(session, activeDivision)),
    [sessions, activeDivision]
  );

  useEffect(() => {
    if (!isFoldersWorkspace) {
      foldersSeededRef.current = false;
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const api = window.electronAPI?.folders;
        if (!api?.list) {
          if (!cancelled) setPersonalFolders([]);
          return;
        }
        const result = await api.list();
        if (cancelled) return;
        const list = result.folders || [];
        setPersonalFolders(list);
        if (!foldersSeededRef.current && list.length > 0) {
          foldersSeededRef.current = true;
          const activeId = activeDivision?.kind === 'folder' ? activeDivision.folderId : null;
          setCollapsedFolderIds((prev) => {
            // First visit: collapse every folder except the active one.
            if (prev.size === 0) {
              const next = new Set(
                list.map((folder) => folder.id).filter((id) => id !== activeId)
              );
              writeCollapsedFolderIds(next);
              return next;
            }
            if (activeId) {
              const next = new Set(prev);
              next.delete(activeId);
              writeCollapsedFolderIds(next);
              return next;
            }
            return prev;
          });
        }
      } catch {
        if (!cancelled) setPersonalFolders([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isFoldersWorkspace, activeDivision]);

  useEffect(() => {
    if (activeDivision?.kind !== 'folder') return;
    const activeId = activeDivision.folderId;
    setCollapsedFolderIds((prev) => {
      if (!prev.has(activeId)) return prev;
      const next = new Set(prev);
      next.delete(activeId);
      writeCollapsedFolderIds(next);
      return next;
    });
  }, [activeDivision]);

  const sessionsByFolderId = useMemo(() => {
    const map = new Map<string, Session[]>();
    for (const session of sessions) {
      if (session.division !== 'folder' || !session.folderId) continue;
      const list = map.get(session.folderId);
      if (list) list.push(session);
      else map.set(session.folderId, [session]);
    }
    for (const [folderId, list] of map) {
      map.set(folderId, sortSessionsLatestFirst(list));
    }
    return map;
  }, [sessions]);

  const displayFolders = useMemo(() => {
    const byId = new Map<string, PersonalFolder>();
    for (const folder of personalFolders) {
      byId.set(folder.id, folder);
    }
    for (const session of sessions) {
      if (session.division !== 'folder' || !session.folderId || byId.has(session.folderId)) {
        continue;
      }
      byId.set(session.folderId, {
        id: session.folderId,
        name: session.folderName || 'Folder',
        createdAt: 0,
        updatedAt: 0,
      });
    }
    return [...byId.values()].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    );
  }, [personalFolders, sessions]);
  const toggleFolderCollapsed = useCallback((folderId: string) => {
    setCollapsedFolderIds((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      writeCollapsedFolderIds(next);
      return next;
    });
  }, []);

  const selectPersonalFolder = useCallback(
    (folder: PersonalFolder) => {
      setActiveDivision({
        kind: 'folder',
        folderId: folder.id,
        folderName: folder.name,
      });
      setCollapsedFolderIds((prev) => {
        if (!prev.has(folder.id)) return prev;
        const next = new Set(prev);
        next.delete(folder.id);
        writeCollapsedFolderIds(next);
        return next;
      });
    },
    [setActiveDivision]
  );

  const refreshPersonalFolders = useCallback(async () => {
    try {
      const api = window.electronAPI?.folders;
      if (!api?.list) {
        setPersonalFolders([]);
        return [];
      }
      const result = await api.list();
      const list = result.folders || [];
      setPersonalFolders(list);
      return list;
    } catch {
      setPersonalFolders([]);
      return [];
    }
  }, []);

  const createPersonalFolder = useCallback(async () => {
    const name = newFolderName.trim();
    if (!name || creatingFolder) return;
    const api = window.electronAPI?.folders;
    if (!api?.create) return;
    setCreatingFolder(true);
    try {
      const result = await api.create(name);
      if (result.success && result.folder) {
        setNewFolderName('');
        await refreshPersonalFolders();
        selectPersonalFolder(result.folder);
      } else {
        setGlobalNotice({
          id: `notice-folder-create-${Date.now()}`,
          type: 'error',
          message: result.error || 'Failed to create folder',
        });
      }
    } catch (error) {
      setGlobalNotice({
        id: `notice-folder-create-${Date.now()}`,
        type: 'error',
        message: error instanceof Error ? error.message : 'Failed to create folder',
      });
    } finally {
      setCreatingFolder(false);
    }
  }, [creatingFolder, newFolderName, refreshPersonalFolders, selectPersonalFolder, setGlobalNotice]);

  useEffect(() => {
    const q = searchQuery.trim();
    if (!q) {
      setSearchHits([]);
      setSearchBusy(false);
      return;
    }
    if (typeof window === 'undefined' || !window.electronAPI?.session?.searchChats) {
      setSearchHits([]);
      return;
    }
    let cancelled = false;
    setSearchBusy(true);
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const hits = await window.electronAPI.session.searchChats(q, 40, {
            scope: searchAllWorkspaces ? 'all' : 'workspace',
            activeDivision,
          });
          if (!cancelled) setSearchHits(hits);
        } catch {
          if (!cancelled) setSearchHits([]);
        } finally {
          if (!cancelled) setSearchBusy(false);
        }
      })();
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [searchQuery, searchAllWorkspaces, activeDivision]);

  const snippetBySessionId = useMemo(() => {
    const map = new Map<string, ChatSearchHit>();
    for (const hit of searchHits) map.set(hit.sessionId, hit);
    return map;
  }, [searchHits]);

  const filteredSessions = useMemo(() => {
    if (!isSearching) return divisionSessions;
    const found: Session[] = [];
    for (const hit of searchHits) {
      const session = sessions.find((item) => item.id === hit.sessionId);
      if (session) found.push(session);
    }
    return found;
  }, [divisionSessions, isSearching, searchHits, sessions]);

  const orderedSessions = useMemo(
    () => (isSearching ? filteredSessions : sortSessionsLatestFirst(filteredSessions)),
    [filteredSessions, isSearching]
  );

  // Exit select mode when sidebar collapses
  useEffect(() => {
    if (sidebarCollapsed && isSelectMode) {
      setIsSelectMode(false);
      setSelectedIds(new Set());
      setShowDeleteConfirm(false);
    }
  }, [sidebarCollapsed, isSelectMode]);

  // Escape key exits select mode
  useEffect(() => {
    if (!isSelectMode) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsSelectMode(false);
        setSelectedIds(new Set());
        setShowDeleteConfirm(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isSelectMode]);

  // Reset selection when search query changes to avoid deleting hidden sessions
  useEffect(() => {
    if (isSelectMode) {
      setSelectedIds(new Set());
    }
  }, [searchQuery]); // eslint-disable-line react-hooks/exhaustive-deps

  const exitSelectMode = useCallback(() => {
    setIsSelectMode(false);
    setSelectedIds(new Set());
    setShowDeleteConfirm(false);
  }, []);

  const toggleSelectSession = useCallback((sessionId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else {
        next.add(sessionId);
      }
      return next;
    });
  }, []);

  const visibleSessionIds = useMemo(() => filteredSessions.map((s) => s.id), [filteredSessions]);

  const allVisibleSelected =
    visibleSessionIds.length > 0 && visibleSessionIds.every((id) => selectedIds.has(id));

  const toggleSelectAll = useCallback(() => {
    if (allVisibleSelected) {
      // Deselect all visible, keep others
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const id of visibleSessionIds) {
          next.delete(id);
        }
        return next;
      });
    } else {
      // Select all visible, keep existing selections
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const id of visibleSessionIds) {
          next.add(id);
        }
        return next;
      });
    }
  }, [allVisibleSelected, visibleSessionIds]);

  const handleBatchDelete = useCallback(() => {
    const visibleSet = new Set(visibleSessionIds);
    const ids = Array.from(selectedIds).filter((id) => visibleSet.has(id));
    if (ids.length === 0) return;
    batchDeleteSessions(ids);
    exitSelectMode();
  }, [selectedIds, visibleSessionIds, batchDeleteSessions, exitSelectMode]);

  const discardActiveIncognitoIfLeaving = useCallback(
    (nextSessionId: string | null) => {
      const state = useAppStore.getState();
      const currentId = state.activeSessionId;
      if (!currentId || currentId === nextSessionId) return;
      const current = state.sessions.find((s) => s.id === currentId);
      if (current?.incognito) {
        deleteSession(currentId);
      }
    },
    [deleteSession]
  );

  const handleSessionClick = useCallback(
    async (sessionId: string) => {
      setShowSettings(false);
      setShowMatter(false);
      setShowWorkflows(false);

      // Read at call-time — do not close over activeSessionId / sessionStates.
      // sessionStates gets a new object ref on every patchSession, and including
      // it in deps caused React #185 when switching sessions (issue #217).
      const state = useAppStore.getState();
      const alreadyActive = state.activeSessionId === sessionId;
      const existingMessages = state.sessionStates[sessionId]?.messages ?? [];
      const existingSteps = state.sessionStates[sessionId]?.traceSteps ?? [];

      // Already viewing this chat with messages loaded — nothing to do.
      // If messages are empty (failed/racy prior load), fall through and retry.
      if (alreadyActive && existingMessages.length > 0) return;

      if (!alreadyActive) {
        discardActiveIncognitoIfLeaving(sessionId);
        setIncognitoDraft(false);
        openSessionWithDivision(sessionId);
      }

      if (!isElectron) return;

      const messageLoadId = (sessionMessageLoadIds[sessionId] ?? 0) + 1;
      sessionMessageLoadIds[sessionId] = messageLoadId;

      try {
        const messages = await getSessionMessages(sessionId);
        if (sessionMessageLoadIds[sessionId] !== messageLoadId) return;

        const latestExisting = useAppStore.getState().sessionStates[sessionId]?.messages ?? [];
        // Apply when empty, or when disk has more than memory (heals truncated
        // loads from a previously incomplete message cache).
        if (
          messages.length > 0 &&
          (latestExisting.length === 0 || messages.length > latestExisting.length)
        ) {
          setMessages(sessionId, messages);
        }
      } catch (error) {
        console.error('[Sidebar] Failed to load messages:', error);
      }

      if (existingSteps.length > 0) return;

      const traceLoadId = (sessionTraceLoadIds[sessionId] ?? 0) + 1;
      sessionTraceLoadIds[sessionId] = traceLoadId;

      try {
        const steps = await getSessionTraceSteps(sessionId);
        if (sessionTraceLoadIds[sessionId] !== traceLoadId) return;
        setTraceSteps(sessionId, steps || []);
      } catch (error) {
        console.error('[Sidebar] Failed to load trace steps:', error);
      }
    },
    [
      discardActiveIncognitoIfLeaving,
      getSessionMessages,
      getSessionTraceSteps,
      isElectron,
      openSessionWithDivision,
      setIncognitoDraft,
      setMessages,
      setShowMatter,
      setShowSettings,
      setShowWorkflows,
      setTraceSteps,
    ]
  );

  const handleGoHome = () => {
    discardActiveIncognitoIfLeaving(null);
    setIncognitoDraft(false);
    setActiveSession(null);
    setShowSettings(false);
    setShowMatter(false);
    setShowWorkflows(false);
  };

  const handleNewSession = () => {
    handleGoHome();
  };

  const handleIncognitoSession = () => {
    discardActiveIncognitoIfLeaving(null);
    setIncognitoDraft(true);
    setActiveSession(null);
    setShowSettings(false);
    setShowMatter(false);
    setShowWorkflows(false);
  };

  const handleOpenMatter = () => {
    discardActiveIncognitoIfLeaving(null);
    setIncognitoDraft(false);
    setShowMatter(true);
  };

  const handleOpenWorkflows = () => {
    discardActiveIncognitoIfLeaving(null);
    setIncognitoDraft(false);
    setShowWorkflows(true);
  };

  const handleOpenSettings = () => {
    setShowWorkflows(false);
    setShowSettings(true);
  };

  const handleImportChat = async () => {
    if (!isElectron || importing) return;
    setImporting(true);
    try {
      const result = await importSession();
      if (result.cancelled) return;
      if (result.success && result.session) {
        const count = result.importedCount || result.sessions?.length || 1;
        setGlobalNotice({
          id: `notice-import-${Date.now()}`,
          type: 'success',
          message: '',
          messageKey: count > 1 ? 'sidebar.importSuccessCount' : 'sidebar.importSuccess',
          messageValues: count > 1 ? { count } : undefined,
        });
      } else {
        setGlobalNotice({
          id: `notice-import-${Date.now()}`,
          type: 'error',
          message: result.error || t('sidebar.importFailed'),
        });
      }
    } catch (error) {
      setGlobalNotice({
        id: `notice-import-${Date.now()}`,
        type: 'error',
        message: error instanceof Error ? error.message : t('sidebar.importFailed'),
      });
    } finally {
      setImporting(false);
    }
  };

  const handleJoinSharedChat = () => {
    if (!isElectron) return;
    setJoinInviteDraft('');
    setJoinModalOpen(true);
    requestAnimationFrame(() => joinInputRef.current?.focus());
  };

  const handleCloseJoinModal = () => {
    if (joiningShared) return;
    setJoinModalOpen(false);
    setJoinInviteDraft('');
  };

  const handleSubmitJoinShared = async () => {
    const inviteToken = joinInviteDraft.trim();
    if (!inviteToken || joiningShared) return;
    setJoiningShared(true);
    try {
      const result = await joinCollabSession(inviteToken);
      if (result.success) {
        setJoinModalOpen(false);
        setJoinInviteDraft('');
        setGlobalNotice({
          id: `notice-join-${Date.now()}`,
          type: 'success',
          message: '',
          messageKey: 'sidebar.joinSharedSuccess',
        });
      } else {
        setGlobalNotice({
          id: `notice-join-${Date.now()}`,
          type: 'error',
          message: result.error || t('sidebar.joinSharedFailed'),
        });
      }
    } catch (error) {
      setGlobalNotice({
        id: `notice-join-${Date.now()}`,
        type: 'error',
        message: error instanceof Error ? error.message : t('sidebar.joinSharedFailed'),
      });
    } finally {
      setJoiningShared(false);
    }
  };

  const handleDeleteSession = (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation();
    deleteSession(sessionId);
  };

  const handleTogglePinSession = (e: React.MouseEvent, session: Session) => {
    e.stopPropagation();
    if (session.incognito) return;
    setSessionPinned(session.id, !session.pinned);
  };

  const handleStartRename = (e: React.MouseEvent, session: Session) => {
    e.stopPropagation();
    skipRenameCommitRef.current = false;
    setRenamingSessionId(session.id);
    setRenameDraft(session.title);
  };

  const handleCancelRename = () => {
    skipRenameCommitRef.current = true;
    setRenamingSessionId(null);
    setRenameDraft('');
  };

  const handleCommitRename = (session: Session) => {
    if (skipRenameCommitRef.current) {
      skipRenameCommitRef.current = false;
      return;
    }
    const trimmed = renameDraft.trim();
    if (!trimmed || trimmed === session.title) {
      setRenamingSessionId(null);
      setRenameDraft('');
      return;
    }
    setSessionTitle(session.id, trimmed);
    setRenamingSessionId(null);
    setRenameDraft('');
  };

  const toggleTheme = () => {
    const next =
      settings.theme === 'dark' ? 'light' : settings.theme === 'light' ? 'system' : 'dark';
    updateSettings({ theme: next });
  };

  const themeIcon =
    settings.theme === 'dark' ? (
      <Sun className="w-4 h-4" />
    ) : settings.theme === 'light' ? (
      <Moon className="w-4 h-4" />
    ) : (
      <Monitor className="w-4 h-4" />
    );

  const WorkspaceIcon = workspaceKindIcon(activeDivision);
  const workspaceName = divisionLabel(activeDivision);

  const joinSharedModal =
    joinModalOpen && typeof document !== 'undefined'
      ? createPortal(
          <div
            className="fixed inset-0 z-[90] flex items-center justify-center bg-black/20 p-4 backdrop-blur-sm animate-fade-in"
            onClick={handleCloseJoinModal}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="join-shared-chat-title"
              className="w-full max-w-md rounded-2xl border border-border-subtle bg-background p-4 shadow-xl"
              onClick={(e) => e.stopPropagation()}
            >
              <h3 id="join-shared-chat-title" className="text-sm font-medium text-text-primary">
                {t('sidebar.joinSharedChat')}
              </h3>
              <p className="mt-1 text-xs text-text-muted">{t('sidebar.joinSharedPrompt')}</p>
              <input
                ref={joinInputRef}
                type="text"
                value={joinInviteDraft}
                onChange={(e) => setJoinInviteDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void handleSubmitJoinShared();
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    handleCloseJoinModal();
                  }
                }}
                placeholder={t('sidebar.joinSharedPrompt')}
                disabled={joiningShared}
                className="mt-3 w-full rounded-xl border border-border-subtle bg-surface px-3 py-2 text-sm text-text-primary outline-none placeholder:text-text-muted focus:border-accent"
              />
              <div className="mt-3 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={handleCloseJoinModal}
                  disabled={joiningShared}
                  className="rounded-xl px-3 py-1.5 text-sm text-text-secondary hover:bg-surface-hover disabled:opacity-50"
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="button"
                  onClick={() => void handleSubmitJoinShared()}
                  disabled={joiningShared || !joinInviteDraft.trim()}
                  className="rounded-xl bg-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
                >
                  {joiningShared
                    ? t('common.loading', { defaultValue: 'Joining…' })
                    : t('sidebar.joinSharedChat')}
                </button>
              </div>
            </div>
          </div>,
          document.body
        )
      : null;

  if (sidebarCollapsed) {
    return (
      <>
      <aside className="relative z-20 flex w-[4.5rem] shrink-0 flex-col overflow-hidden border-r border-border-muted bg-surface/96">
        <div className="px-3 pt-3 pb-2 flex flex-col items-center gap-1.5 border-b border-border-muted">
          <button
            type="button"
            onClick={handleGoHome}
            className="w-9 h-9 rounded-2xl flex items-center justify-center hover:bg-surface-hover transition-colors overflow-hidden"
            title={t('sidebar.home')}
            aria-label={t('sidebar.home')}
          >
            <img
              src={sidebarLogoSrc}
              alt=""
              className="w-7 h-7 object-contain"
            />
          </button>
          <button
            onClick={toggleSidebar}
            className="w-9 h-9 rounded-2xl flex items-center justify-center hover:bg-surface-hover transition-colors text-text-secondary"
            title={t('context.expandPanel')}
          >
            <ChevronRight className="w-4 h-4" />
          </button>
          <button
            onClick={handleNewSession}
            className="w-9 h-9 rounded-2xl flex items-center justify-center bg-background hover:bg-surface-hover transition-colors text-text-primary border border-border-subtle"
            title={t('sidebar.newTask')}
          >
            <Plus className="w-4 h-4" />
          </button>
          <button
            onClick={handleIncognitoSession}
            className="w-9 h-9 rounded-2xl flex items-center justify-center bg-background hover:bg-surface-hover transition-colors text-text-secondary border border-border-subtle border-dashed"
            title={t('sidebar.incognitoTask')}
          >
            <Ghost className="w-4 h-4" />
          </button>
          <button
            onClick={() => void handleImportChat()}
            disabled={!isElectron || importing}
            className="w-9 h-9 rounded-2xl flex items-center justify-center bg-background hover:bg-surface-hover transition-colors text-text-secondary border border-border-subtle disabled:opacity-50"
            title={t('sidebar.importChat')}
          >
            <FileDown className={`w-4 h-4 ${importing ? 'animate-pulse' : ''}`} />
          </button>
          <button
            onClick={handleJoinSharedChat}
            disabled={!isElectron}
            className="w-9 h-9 rounded-2xl flex items-center justify-center bg-background hover:bg-surface-hover transition-colors text-text-secondary border border-border-subtle disabled:opacity-50"
            title={t('sidebar.joinSharedChat')}
          >
            <Link2 className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={toggleSidebar}
            className={`w-9 h-9 rounded-2xl flex items-center justify-center border transition-colors ${
              activeDivision
                ? 'bg-accent/10 text-accent border-accent/30 hover:bg-accent/15'
                : 'bg-background text-text-muted border-border-subtle border-dashed hover:bg-surface-hover'
            }`}
            title={activeDivision ? workspaceName : 'Select workspace'}
            aria-label={activeDivision ? `Workspace: ${workspaceName}` : 'Select workspace'}
          >
            <WorkspaceIcon className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 flex flex-col items-center justify-center px-3 py-4">
          <button
            onClick={toggleSidebar}
            className="rounded-2xl px-2 py-3 text-[11px] leading-4 text-center text-text-muted hover:bg-surface-hover transition-colors"
            title={t('sidebar.expandToView')}
          >
            {t('sidebar.expandToView')}
          </button>
        </div>

        <div className="px-3 py-2 border-t border-border-muted flex flex-col items-center gap-1.5">
          {matterEnabled ? (
            <button
              type="button"
              onClick={handleOpenMatter}
              className={`relative w-9 h-9 rounded-2xl flex items-center justify-center transition-colors border ${
                showMatter
                  ? 'bg-accent/20 text-accent border-accent/50'
                  : 'bg-background text-accent border-accent/30 hover:bg-accent/10'
              }`}
              title={t('sidebar.matter')}
            >
              <Radar className="w-4 h-4" />
              {matterBadgeCount > 0 ? (
                <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] px-0.5 rounded-full bg-red-500 text-white text-[9px] font-bold flex items-center justify-center">
                  {matterBadgeCount > 9 ? '9+' : matterBadgeCount}
                </span>
              ) : null}
            </button>
          ) : null}
          <button
            type="button"
            onClick={handleOpenWorkflows}
            className={`relative w-9 h-9 rounded-2xl flex items-center justify-center transition-colors border ${
              showWorkflows
                ? 'bg-accent/20 text-accent border-accent/50'
                : 'bg-background text-accent border-accent/30 hover:bg-accent/10'
            }`}
            title={t('sidebar.workflows')}
          >
            <Workflow className="w-4 h-4" />
          </button>
          {user ? (
            <div className="w-9 h-9 flex items-center justify-center" title={user.name}>
              <SidebarUserAvatar
                name={user.name}
                image={user.image}
                className="w-9 h-9 text-[12px]"
              />
            </div>
          ) : null}
          <button
            type="button"
            onClick={handleOpenSettings}
            className="w-9 h-9 rounded-2xl flex items-center justify-center hover:bg-surface-hover transition-colors text-text-secondary"
            title={t('sidebar.settings')}
          >
            <Settings className="w-4 h-4" />
          </button>
          <SidebarUpdateButton compact />
          <button
            type="button"
            onClick={toggleTheme}
            className="w-9 h-9 rounded-2xl flex items-center justify-center hover:bg-surface-hover transition-colors text-text-secondary"
            title={t('sidebar.themeToggle')}
          >
            {themeIcon}
          </button>
          {user ? (
            <button
              type="button"
              onClick={() => void logout()}
              className="w-9 h-9 rounded-2xl flex items-center justify-center hover:bg-surface-hover transition-colors text-text-secondary"
              title={t('sidebar.signOut')}
            >
              <LogOut className="w-4 h-4" />
            </button>
          ) : null}
        </div>
      </aside>
      {joinSharedModal}
      </>
    );
  }

  return (
    <>
    <aside className="relative z-20 flex w-[17.5rem] shrink-0 flex-col overflow-hidden border-r border-border-muted bg-surface/96">
      <div className="px-3 pt-3 pb-2 border-b border-border-muted">
        <div className="flex items-start justify-between gap-2">
          <button
            type="button"
            onClick={handleGoHome}
            className="min-w-0 flex items-center gap-2 rounded-lg text-left hover:opacity-90 transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            title={t('sidebar.home')}
            aria-label={t('sidebar.home')}
          >
            <img
              src={sidebarLogoSrc}
              alt={t('common.appLogoAlt')}
              className="w-8 h-8 object-contain flex-shrink-0"
            />
            <div className="min-w-0">
              <h1 className="text-[1.125rem] leading-tight font-semibold tracking-[-0.03em] text-text-primary">
                York GrowthOS
              </h1>
            </div>
          </button>
          <button
            onClick={toggleSidebar}
            className="w-7 h-7 rounded-lg flex items-center justify-center hover:bg-surface-hover transition-colors text-text-secondary flex-shrink-0"
            title={t('context.collapsePanel')}
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
        </div>

        <div className="mt-2 space-y-2">
          <NextUpMeeting />
        </div>

        <div className="mt-2 px-0.5">
          <DivisionSwitcher variant="header" />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-2 pt-2">
        <div className="mb-1.5 space-y-1.5">
          <div className="flex h-8 gap-1">
            <button
              onClick={handleNewSession}
              className="flex h-full flex-1 items-center justify-center rounded-lg border border-border-subtle bg-background text-text-primary transition-colors hover:bg-surface-hover"
              aria-label={t('sidebar.newTask')}
              title={t('sidebar.newTask')}
            >
              <Plus className="w-4 h-4" />
            </button>
            <button
              onClick={handleIncognitoSession}
              className="flex h-full flex-1 items-center justify-center rounded-lg border border-dashed border-border-subtle bg-background/60 text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
              aria-label={t('sidebar.incognitoTask')}
              title={t('sidebar.incognitoTask')}
            >
              <Ghost className="w-4 h-4" />
            </button>
            <button
              onClick={() => void handleImportChat()}
              disabled={!isElectron || importing}
              className="flex h-full flex-1 items-center justify-center rounded-lg border border-border-subtle bg-background/60 text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary disabled:opacity-50"
              aria-label={t('sidebar.importChat')}
              title={t('sidebar.importChat')}
            >
              <FileDown className={`w-4 h-4 ${importing ? 'animate-pulse' : ''}`} />
            </button>
            <button
              onClick={handleJoinSharedChat}
              disabled={!isElectron}
              className="flex h-full flex-1 items-center justify-center rounded-lg border border-border-subtle bg-background/60 text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary disabled:opacity-50"
              aria-label={t('sidebar.joinSharedChat')}
              title={t('sidebar.joinSharedChat')}
            >
              <Link2 className="w-4 h-4" />
            </button>
          </div>

          <div className="flex items-center gap-1.5">
            <div className="relative flex-1 min-w-0">
              <SearchIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-muted" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t('sidebar.search')}
                className="w-full h-8 rounded-lg border border-transparent bg-background pl-8 pr-2.5 text-[12px] text-text-primary placeholder:text-text-muted focus:outline-none focus:border-border transition-colors"
              />
            </div>
            <button
              onClick={() => setSearchAllWorkspaces((prev) => !prev)}
              className={`h-8 shrink-0 rounded-lg border px-2 text-[10px] font-medium transition-colors ${
                searchAllWorkspaces
                  ? 'border-accent/40 bg-accent/10 text-accent'
                  : 'border-border-subtle text-text-muted hover:bg-surface-hover hover:text-text-secondary'
              }`}
              title={searchAllWorkspaces ? 'Searching all workspaces' : 'Searching this workspace only'}
              type="button"
            >
              {searchAllWorkspaces ? 'All' : 'Here'}
            </button>
            <button
              onClick={() => {
                if (isSelectMode) {
                  exitSelectMode();
                } else {
                  setIsSelectMode(true);
                }
              }}
              className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 transition-colors ${
                isSelectMode
                  ? 'bg-accent text-white'
                  : 'text-text-secondary hover:text-text-primary hover:bg-surface-hover'
              }`}
              title={t('sidebar.manage')}
            >
              <ListChecks className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {isSearching && orderedSessions.length === 0 ? (
          <div className="relative ml-0 border-l border-border-muted pl-2">
            <div className="px-1 py-4">
              <p className="text-sm text-text-secondary">
                {searchBusy ? t('common.loading') : t('sidebar.searchNoResults')}
              </p>
              <p className="mt-1 text-xs leading-5 text-text-muted">{t('sidebar.searchAllHint')}</p>
            </div>
          </div>
        ) : isFoldersWorkspace && !isSearching ? (
          <div className="relative ml-0 border-l border-border-muted pl-2">
            <div className="mb-1.5 flex gap-1 px-0.5">
              <input
                type="text"
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void createPersonalFolder();
                }}
                placeholder="New folder name"
                disabled={creatingFolder}
                className="min-w-0 flex-1 rounded-lg border border-border-subtle bg-background px-2 py-1.5 text-[12px] text-text-primary placeholder:text-text-muted focus:outline-none focus:border-border"
              />
              <button
                type="button"
                onClick={() => void createPersonalFolder()}
                disabled={creatingFolder || !newFolderName.trim()}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border-subtle bg-background text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary disabled:opacity-40"
                title="Create folder"
                aria-label="Create folder"
              >
                <FolderPlus className={`h-3.5 w-3.5 ${creatingFolder ? 'animate-pulse' : ''}`} />
              </button>
            </div>
            {displayFolders.length === 0 ? (
              <div className="px-1 py-3">
                <p className="text-sm text-text-secondary">No folders yet</p>
                <p className="mt-1 text-xs leading-5 text-text-muted">
                  Create a personal folder above to get started.
                </p>
              </div>
            ) : (
              <div className="space-y-1">
                {displayFolders.map((folder) => {
                  const isActiveFolder = activeDivision?.kind === 'folder' && activeDivision.folderId === folder.id;
                  const isCollapsed = collapsedFolderIds.has(folder.id);
                  const folderChats = sessionsByFolderId.get(folder.id) || [];
                  return (
                    <div key={folder.id} className="relative">
                      <span
                        aria-hidden
                        className="pointer-events-none absolute -left-[calc(0.5rem+1px)] top-[14px] h-px w-2 bg-border-muted"
                      />
                      <button
                        type="button"
                        onClick={() => selectPersonalFolder(folder)}
                        className={`flex w-full items-center gap-1.5 rounded-lg px-1.5 py-1.5 text-left transition-colors ${
                          isActiveFolder
                            ? 'bg-accent/10 text-accent'
                            : 'text-text-primary hover:bg-surface-hover/60'
                        }`}
                        title={folder.name}
                        aria-expanded={!isCollapsed}
                      >
                        <span
                          role="presentation"
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleFolderCollapsed(folder.id);
                          }}
                          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-text-muted hover:bg-surface-hover hover:text-text-primary"
                        >
                          {isCollapsed ? (
                            <ChevronRight className="h-3.5 w-3.5" />
                          ) : (
                            <ChevronDown className="h-3.5 w-3.5" />
                          )}
                        </span>
                        <Folder className="h-3.5 w-3.5 shrink-0" />
                        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold tracking-[-0.01em]">
                          {folder.name}
                        </span>
                        <span className="shrink-0 text-[10px] font-medium text-text-muted">
                          {folderChats.length}
                        </span>
                      </button>
                      {!isCollapsed ? (
                        <div className="relative ml-2 mt-0.5 border-l border-border-muted/80 pl-2">
                          {folderChats.length === 0 ? (
                            <p className="px-2 py-2 text-[11px] text-text-muted">No chats in this folder yet</p>
                          ) : (
                            <div className="space-y-0.5">
                              {folderChats.map((session) => {
                                const isActive = activeSessionId === session.id;
                                const isSelected = selectedIds.has(session.id);
                                const isIncognito = session.incognito === true;
                                const isRenaming = renamingSessionId === session.id;
                                const loopStatus = chatLoopBySessionId[session.id];
                                const isActiveLoop = Boolean(loopStatus && !loopStatus.stopReason);
                                return (
                                  <div
                                    key={session.id}
                                    onClick={() => {
                                      if (isRenaming) return;
                                      if (isSelectMode) {
                                        toggleSelectSession(session.id);
                                      } else {
                                        handleSessionClick(session.id);
                                      }
                                    }}
                                    onMouseEnter={() => setHoveredSession(session.id)}
                                    onMouseLeave={() => setHoveredSession(null)}
                                    className={`group relative cursor-pointer rounded-lg px-2 py-1.5 transition-colors ${
                                      isSelectMode && isSelected
                                        ? 'bg-accent-muted/20'
                                        : isActive && !isSelectMode
                                          ? 'bg-surface-hover/80'
                                          : 'hover:bg-surface-hover/60'
                                    } ${isIncognito ? 'border border-dashed border-border-subtle/80' : ''}`}
                                  >
                                    <span
                                      aria-hidden
                                      className="pointer-events-none absolute -left-[calc(0.5rem+1px)] top-1/2 h-px w-2 -translate-y-1/2 bg-border-muted/80"
                                    />
                                    <div
                                      className={`flex items-center gap-2 ${
                                        !isSelectMode && !isRenaming ? 'pr-20' : ''
                                      }`}
                                    >
                                      {isSelectMode && (
                                        <div
                                          className={`w-4 h-4 rounded flex items-center justify-center flex-shrink-0 transition-colors ${
                                            isSelected
                                              ? 'bg-accent text-white'
                                              : 'border border-border-muted bg-background'
                                          }`}
                                        >
                                          {isSelected && <Check className="w-2.5 h-2.5" />}
                                        </div>
                                      )}
                                      {isIncognito && !isSelectMode && (
                                        <Ghost className="w-3.5 h-3.5 text-text-muted flex-shrink-0" />
                                      )}
                                      {Boolean(session.collabRoomId) && !isSelectMode && (
                                        <span title={t('chat.collabSharedBadge')} className="flex-shrink-0">
                                          <Users
                                            className="w-3.5 h-3.5 text-text-muted"
                                            aria-hidden
                                          />
                                        </span>
                                      )}
                                      {isActiveLoop && !isSelectMode && (
                                        <span className="flex-shrink-0 text-accent">
                                          {loopStatus?.kind === 'goal' ? (
                                            <Target className="w-3.5 h-3.5" />
                                          ) : (
                                            <RefreshCw
                                              className="w-3.5 h-3.5 animate-spin"
                                              style={{ animationDuration: '3s' }}
                                            />
                                          )}
                                        </span>
                                      )}
                                      <div className="min-w-0 flex-1">
                                        {isRenaming ? (
                                          <input
                                            autoFocus
                                            value={renameDraft}
                                            onChange={(e) => setRenameDraft(e.target.value)}
                                            onClick={(e) => e.stopPropagation()}
                                            onBlur={() => handleCommitRename(session)}
                                            onKeyDown={(e) => {
                                              if (e.key === 'Enter') {
                                                e.preventDefault();
                                                handleCommitRename(session);
                                              } else if (e.key === 'Escape') {
                                                e.preventDefault();
                                                handleCancelRename();
                                              }
                                            }}
                                            className="w-full min-w-0 rounded-md border border-border-muted bg-background px-1.5 py-0.5 text-[13px] font-medium leading-5 text-text-primary outline-none focus:border-accent"
                                            aria-label={t('sidebar.rename')}
                                          />
                                        ) : (
                                          <div
                                            className="truncate text-[13px] font-medium leading-5 text-text-primary"
                                            onDoubleClick={(e) => {
                                              if (!isSelectMode) handleStartRename(e, session);
                                            }}
                                          >
                                            {session.title}
                                          </div>
                                        )}
                                      </div>
                                    </div>
                                    {!isSelectMode && !isRenaming && (
                                      <>
                                        {hoveredSession === session.id && (
                                          <button
                                            onClick={(e) => handleStartRename(e, session)}
                                            className="absolute right-[3.625rem] top-1/2 -translate-y-1/2 w-6 h-6 rounded-lg flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-surface-active transition-colors"
                                            title={t('sidebar.rename')}
                                          >
                                            <Pencil className="w-3 h-3" />
                                          </button>
                                        )}
                                        {hoveredSession === session.id && (
                                          <button
                                            onClick={(e) => handleDeleteSession(e, session.id)}
                                            className="absolute right-8 top-1/2 -translate-y-1/2 w-6 h-6 rounded-lg flex items-center justify-center text-text-muted hover:text-error hover:bg-surface-active transition-colors"
                                            title={t('common.delete')}
                                          >
                                            <Trash2 className="w-3 h-3" />
                                          </button>
                                        )}
                                        {!isIncognito &&
                                          (session.pinned || hoveredSession === session.id) && (
                                            <button
                                              onClick={(e) => handleTogglePinSession(e, session)}
                                              className={`absolute right-1.5 top-1/2 -translate-y-1/2 w-6 h-6 rounded-lg flex items-center justify-center transition-colors ${
                                                session.pinned
                                                  ? 'text-accent hover:bg-surface-active'
                                                  : 'text-text-muted hover:text-text-primary hover:bg-surface-active'
                                              }`}
                                              title={
                                                session.pinned ? t('sidebar.unpin') : t('sidebar.pin')
                                              }
                                            >
                                              <Pin
                                                className={`w-3 h-3 ${session.pinned ? 'fill-current' : ''}`}
                                              />
                                            </button>
                                          )}
                                      </>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ) : orderedSessions.length === 0 && !isSearching ? (
          <div className="relative ml-0 border-l border-border-muted pl-2">
            <div className="px-1 py-4">
              <p className="text-sm text-text-secondary">
                {activeDivision?.kind === 'hub'
                  ? 'No chats in Hub yet'
                  : activeDivision?.kind === 'project'
                    ? 'No chats in this project yet'
                    : activeDivision?.kind === 'client'
                      ? 'No chats in this client yet'
                      : activeDivision?.kind === 'general'
                        ? 'No chats in General yet'
                        : t('sidebar.noTasks')}
              </p>
              <p className="mt-1 text-xs leading-5 text-text-muted">{t('sidebar.noTasksHint')}</p>
            </div>
          </div>
        ) : (
          <div className="relative ml-0 border-l border-border-muted pl-2">
            {isSearching ? (
              <div className="mb-1 px-1.5 text-[10px] font-medium tracking-[0.04em] text-text-muted">
                {t('sidebar.searchResults')}
              </div>
            ) : null}
            <div className="space-y-0.5">
              {orderedSessions.map((session) => {
                const isActive = activeSessionId === session.id;
                const isSelected = selectedIds.has(session.id);
                const isIncognito = session.incognito === true;
                const isRenaming = renamingSessionId === session.id;
                const loopStatus = chatLoopBySessionId[session.id];
                const isActiveLoop = Boolean(loopStatus && !loopStatus.stopReason);
                return (
                  <div
                    key={session.id}
                    onClick={() => {
                      if (isRenaming) return;
                      if (isSelectMode) {
                        toggleSelectSession(session.id);
                      } else {
                        handleSessionClick(session.id);
                      }
                    }}
                    onMouseEnter={() => setHoveredSession(session.id)}
                    onMouseLeave={() => setHoveredSession(null)}
                    className={`group relative cursor-pointer rounded-lg px-2 py-1.5 transition-colors ${
                      isSelectMode && isSelected
                        ? 'bg-accent-muted/20'
                        : isActive && !isSelectMode
                          ? 'bg-surface-hover/80'
                          : 'hover:bg-surface-hover/60'
                    } ${isIncognito ? 'border border-dashed border-border-subtle/80' : ''}`}
                  >
                    {/* Little tab connector into the vertical workspace rail */}
                    <span
                      aria-hidden
                      className="pointer-events-none absolute -left-[calc(0.5rem+1px)] top-1/2 h-px w-2 -translate-y-1/2 bg-border-muted"
                    />
                    <div
                      className={`flex items-center gap-2 ${
                        !isSelectMode && !isRenaming ? 'pr-20' : ''
                      }`}
                    >
                      {isSelectMode && (
                        <div
                          className={`w-4 h-4 rounded flex items-center justify-center flex-shrink-0 transition-colors ${
                            isSelected
                              ? 'bg-accent text-white'
                              : 'border border-border-muted bg-background'
                          }`}
                        >
                          {isSelected && <Check className="w-2.5 h-2.5" />}
                        </div>
                      )}
                      {isIncognito && !isSelectMode && (
                        <Ghost className="w-3.5 h-3.5 text-text-muted flex-shrink-0" />
                      )}
                      {Boolean(session.collabRoomId) && !isSelectMode && (
                        <span title={t('chat.collabSharedBadge')} className="flex-shrink-0">
                          <Users className="w-3.5 h-3.5 text-text-muted" aria-hidden />
                        </span>
                      )}
                      {isActiveLoop && !isSelectMode && (
                        <span
                          className="flex-shrink-0 text-accent"
                          title={
                            loopStatus?.kind === 'goal'
                              ? t('loop.modeGoal')
                              : t('loop.modeLoop')
                          }
                        >
                          {loopStatus?.kind === 'goal' ? (
                            <Target className="w-3.5 h-3.5" />
                          ) : (
                            <RefreshCw
                              className="w-3.5 h-3.5 animate-spin"
                              style={{ animationDuration: '3s' }}
                            />
                          )}
                        </span>
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          {isRenaming ? (
                            <input
                              autoFocus
                              value={renameDraft}
                              onChange={(e) => setRenameDraft(e.target.value)}
                              onClick={(e) => e.stopPropagation()}
                              onBlur={() => handleCommitRename(session)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  e.preventDefault();
                                  handleCommitRename(session);
                                } else if (e.key === 'Escape') {
                                  e.preventDefault();
                                  handleCancelRename();
                                }
                              }}
                              className="w-full min-w-0 rounded-md border border-border-muted bg-background px-1.5 py-0.5 text-[13px] font-medium leading-5 text-text-primary outline-none focus:border-accent"
                              aria-label={t('sidebar.rename')}
                            />
                          ) : (
                            <div
                              className="truncate text-[13px] font-medium leading-5 text-text-primary"
                              onDoubleClick={(e) => {
                                if (!isSelectMode) handleStartRename(e, session);
                              }}
                            >
                              {session.title}
                            </div>
                          )}
                          {isSearching && !isRenaming && (
                            <span className="flex-shrink-0 rounded-md bg-background px-1.5 py-0.5 text-[10px] font-medium text-text-muted">
                              {divisionLabel(activeDivisionFromSession(session))}
                            </span>
                          )}
                        </div>
                        {isSearching &&
                          !isRenaming &&
                          snippetBySessionId.get(session.id)?.snippet &&
                          snippetBySessionId.get(session.id)?.snippet !== session.title && (
                            <div className="mt-0.5 line-clamp-2 text-[11px] leading-4 text-text-muted">
                              {snippetBySessionId.get(session.id)?.snippet}
                            </div>
                          )}
                      </div>
                    </div>

                    {!isSelectMode && !isRenaming && (
                      <>
                        {hoveredSession === session.id && (
                          <button
                            onClick={(e) => handleStartRename(e, session)}
                            className="absolute right-[3.625rem] top-1/2 -translate-y-1/2 w-6 h-6 rounded-lg flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-surface-active transition-colors"
                            title={t('sidebar.rename')}
                          >
                            <Pencil className="w-3 h-3" />
                          </button>
                        )}
                        {hoveredSession === session.id && (
                          <button
                            onClick={(e) => handleDeleteSession(e, session.id)}
                            className="absolute right-8 top-1/2 -translate-y-1/2 w-6 h-6 rounded-lg flex items-center justify-center text-text-muted hover:text-error hover:bg-surface-active transition-colors"
                            title={t('common.delete')}
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        )}
                        {!isIncognito && (session.pinned || hoveredSession === session.id) && (
                          <button
                            onClick={(e) => handleTogglePinSession(e, session)}
                            className={`absolute right-1.5 top-1/2 -translate-y-1/2 w-6 h-6 rounded-lg flex items-center justify-center transition-colors ${
                              session.pinned
                                ? 'text-accent hover:bg-surface-active'
                                : 'text-text-muted hover:text-text-primary hover:bg-surface-active'
                            }`}
                            title={session.pinned ? t('sidebar.unpin') : t('sidebar.pin')}
                          >
                            <Pin
                              className={`w-3 h-3 ${session.pinned ? 'fill-current' : ''}`}
                            />
                          </button>
                        )}
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {isSelectMode ? (
        <div className="px-2 py-2 border-t border-border-muted">
          {showDeleteConfirm ? (
            <div className="border border-error/30 bg-error/10 rounded-lg px-3 py-3">
              <p className="text-[13px] text-text-primary mb-3">
                {t('sidebar.batchDeleteConfirm', { count: selectedIds.size })}
              </p>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowDeleteConfirm(false)}
                  className="flex-1 px-3 py-1.5 rounded-lg text-[13px] font-medium text-text-secondary hover:bg-surface-hover transition-colors"
                >
                  {t('sidebar.cancel')}
                </button>
                <button
                  onClick={handleBatchDelete}
                  className="flex-1 px-3 py-1.5 rounded-lg text-[13px] font-medium bg-error text-white hover:bg-error/90 transition-colors"
                >
                  {t('sidebar.confirmDelete')}
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center justify-between px-1">
                <button
                  onClick={toggleSelectAll}
                  className="text-[12px] font-medium text-accent hover:text-accent/80 transition-colors"
                >
                  {allVisibleSelected ? t('sidebar.deselectAll') : t('sidebar.selectAll')}
                </button>
                <span className="text-[12px] text-text-muted">
                  {t('sidebar.nSelected', { count: selectedIds.size })}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={exitSelectMode}
                  className="flex-1 px-3 py-2 rounded-xl text-[13px] font-medium text-text-secondary hover:bg-surface-hover transition-colors"
                >
                  {t('sidebar.cancel')}
                </button>
                <button
                  onClick={() => setShowDeleteConfirm(true)}
                  disabled={selectedIds.size === 0}
                  className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-[13px] font-medium bg-error text-white hover:bg-error/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  {t('common.delete')}
                </button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="px-2 py-2 border-t border-border-muted space-y-1.5">
          <div className="flex items-center gap-1.5">
            {matterEnabled ? (
              <button
                type="button"
                onClick={handleOpenMatter}
                className={`min-w-0 flex-1 rounded-xl px-2 py-1.5 flex items-center gap-1.5 text-left transition-colors border ${
                  showMatter
                    ? 'bg-accent/15 text-accent border-accent/40'
                    : 'bg-background text-text-primary border-border-subtle hover:bg-surface-hover hover:border-accent/30'
                }`}
                title={t('sidebar.matterHint')}
              >
                <span
                  className={`relative flex h-6 w-6 shrink-0 items-center justify-center rounded-md ${
                    showMatter ? 'bg-accent/20' : 'bg-accent/10'
                  }`}
                >
                  <Radar className="w-3.5 h-3.5 text-accent" />
                  {matterBadgeCount > 0 ? (
                    <span className="absolute -top-1 -right-1 min-w-[14px] h-[14px] px-0.5 rounded-full bg-red-500 text-white text-[9px] font-bold flex items-center justify-center">
                      {matterBadgeCount > 9 ? '9+' : matterBadgeCount}
                    </span>
                  ) : null}
                </span>
                <span className="min-w-0 flex-1 text-[11px] font-semibold leading-tight truncate">
                  {t('sidebar.matter')}
                </span>
              </button>
            ) : null}
            <button
              type="button"
              onClick={handleOpenWorkflows}
              className={`min-w-0 flex-1 rounded-xl px-2 py-1.5 flex items-center gap-1.5 text-left transition-colors border ${
                showWorkflows
                  ? 'bg-accent/15 text-accent border-accent/40'
                  : 'bg-background text-text-primary border-border-subtle hover:bg-surface-hover hover:border-accent/30'
              }`}
              title={t('sidebar.workflowsHint')}
            >
              <span
                className={`relative flex h-6 w-6 shrink-0 items-center justify-center rounded-md ${
                  showWorkflows ? 'bg-accent/20' : 'bg-accent/10'
                }`}
              >
                <Workflow className="w-3.5 h-3.5 text-accent" />
              </span>
              <span className="min-w-0 flex-1 text-[11px] font-semibold leading-tight truncate">
                {t('sidebar.workflows')}
              </span>
            </button>
          </div>
          <div className="flex items-center gap-1.5 rounded-xl bg-background/50 px-2 py-1.5">
            {user ? (
              <>
                <SidebarUserAvatar name={user.name} image={user.image} className="w-7 h-7 text-[10px]" />
                <div className="min-w-0 flex-1">
                  <div className="text-[12px] font-medium text-text-primary truncate leading-tight">
                    {user.name}
                  </div>
                  <div className="text-[10px] text-text-muted truncate leading-tight">{user.email}</div>
                </div>
              </>
            ) : (
              <div className="min-w-0 flex-1" />
            )}
            <button
              type="button"
              onClick={handleOpenSettings}
              className="w-7 h-7 rounded-lg flex items-center justify-center text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors flex-shrink-0"
              title={t('sidebar.settings')}
            >
              <Settings className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={toggleTheme}
              className="w-7 h-7 rounded-lg flex items-center justify-center text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors flex-shrink-0"
              title={t('sidebar.themeToggle')}
            >
              {themeIcon}
            </button>
            {user ? (
              <button
                type="button"
                onClick={() => void logout()}
                className="w-7 h-7 rounded-lg flex items-center justify-center text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors flex-shrink-0"
                title={t('sidebar.signOut')}
              >
                <LogOut className="w-3.5 h-3.5" />
              </button>
            ) : null}
          </div>
          <SidebarUpdateButton />
        </div>
      )}
    </aside>
    {joinSharedModal}
    </>
  );
}
