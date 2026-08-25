import { useState, useCallback, useMemo, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../store';
import { useIPC } from '../hooks/useIPC';
import { useAuth } from '../auth/AuthContext';
import {
  ChevronLeft,
  ChevronRight,
  Trash2,
  Pin,
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
} from 'lucide-react';
import type { Session } from '../types';
import { DivisionSwitcher } from './DivisionSwitcher';
import { sessionMatchesActiveDivision } from '../../shared/workspace-division';
import { useUpdaterStatus } from '../hooks/useUpdaterStatus';

import sidebarLogoSrc from '../assets/logo.png';

// Monotonic per-session load tokens so a slow history fetch cannot apply after
// a newer click for the same session (rapid switching).
const sessionMessageLoadIds: Record<string, number> = {};
const sessionTraceLoadIds: Record<string, number> = {};

type SessionGroup = {
  key: string;
  label: string;
  sessions: Session[];
};

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
      className="mt-2 w-full inline-flex items-center justify-center gap-1.5 rounded-xl bg-accent px-3 py-2 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-50 transition-opacity"
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
    getSessionMessages,
    getSessionTraceSteps,
    importSession,
    isElectron,
  } = useIPC();
  const setGlobalNotice = useAppStore((s) => s.setGlobalNotice);
  const [hoveredSession, setHoveredSession] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [isSelectMode, setIsSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [importing, setImporting] = useState(false);
  const [hoveredAction, setHoveredAction] = useState<'new' | 'incognito' | 'import' | null>(null);

  const normalizedQuery = useMemo(() => searchQuery.trim().toLowerCase(), [searchQuery]);
  const divisionSessions = useMemo(
    () => sessions.filter((session) => sessionMatchesActiveDivision(session, activeDivision)),
    [sessions, activeDivision]
  );
  const filteredSessions = useMemo(() => {
    return normalizedQuery
      ? divisionSessions.filter((session) => session.title.toLowerCase().includes(normalizedQuery))
      : divisionSessions;
  }, [divisionSessions, normalizedQuery]);

  const groupedSessions = useMemo(
    () => groupSessionsByDate(filteredSessions, t),
    [filteredSessions, t]
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
        setActiveSession(sessionId);
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
      setActiveSession,
      setIncognitoDraft,
      setMessages,
      setShowMatter,
      setShowSettings,
      setShowWorkflows,
      setTraceSteps,
    ]
  );

  const handleNewSession = () => {
    discardActiveIncognitoIfLeaving(null);
    setIncognitoDraft(false);
    setActiveSession(null);
    setShowSettings(false);
    setShowMatter(false);
    setShowWorkflows(false);
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
        setGlobalNotice({
          id: `notice-import-${Date.now()}`,
          type: 'success',
          message: '',
          messageKey: 'sidebar.importSuccess',
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

  const handleDeleteSession = (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation();
    deleteSession(sessionId);
  };

  const handleTogglePinSession = (e: React.MouseEvent, session: Session) => {
    e.stopPropagation();
    if (session.incognito) return;
    setSessionPinned(session.id, !session.pinned);
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

  if (sidebarCollapsed) {
    return (
      <aside className="relative z-20 flex w-[4.5rem] shrink-0 flex-col overflow-hidden border-r border-border-muted bg-surface/96">
        <div className="px-3 pt-4 pb-3 flex flex-col items-center gap-2 border-b border-border-muted">
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

        <div className="px-3 py-3 border-t border-border-muted flex flex-col items-center gap-2">
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
    );
  }

  return (
    <aside className="relative z-20 flex w-[17.5rem] shrink-0 flex-col overflow-hidden border-r border-border-muted bg-surface/96">
      <div className="px-4 pt-5 pb-4 border-b border-border-muted">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex items-center gap-3">
            <img
              src={sidebarLogoSrc}
              alt={t('common.appLogoAlt')}
              className="w-10 h-10 object-contain flex-shrink-0"
            />
            <div className="min-w-0">
              <h1 className="text-[1.34rem] leading-none font-semibold tracking-[-0.035em] text-text-primary">
                York GrowthOS
              </h1>
            </div>
          </div>
          <button
            onClick={toggleSidebar}
            className="w-8 h-8 rounded-xl flex items-center justify-center hover:bg-surface-hover transition-colors text-text-secondary flex-shrink-0"
            title={t('context.collapsePanel')}
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
        </div>

        <div className="mt-3 space-y-1.5">
          <p className="px-0.5 text-[11px] font-medium tracking-[0.04em] text-text-muted">
            Choose Workspace
          </p>
          <DivisionSwitcher compact />
        </div>

        <div className="mt-3">
          <div
            className="flex h-9 gap-1.5"
            onMouseLeave={() => setHoveredAction(null)}
          >
            <button
              onClick={handleNewSession}
              onMouseEnter={() => setHoveredAction('new')}
              className="flex h-full flex-1 items-center justify-center rounded-xl border border-border-subtle bg-background text-text-primary transition-colors hover:bg-surface-hover"
              aria-label={t('sidebar.newTask')}
            >
              <Plus className="w-4 h-4" />
            </button>
            <button
              onClick={handleIncognitoSession}
              onMouseEnter={() => setHoveredAction('incognito')}
              className="flex h-full flex-1 items-center justify-center rounded-xl border border-dashed border-border-subtle bg-background/60 text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
              aria-label={t('sidebar.incognitoTask')}
            >
              <Ghost className="w-4 h-4" />
            </button>
            <button
              onClick={() => void handleImportChat()}
              onMouseEnter={() => setHoveredAction('import')}
              disabled={!isElectron || importing}
              className="flex h-full flex-1 items-center justify-center rounded-xl border border-border-subtle bg-background/60 text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary disabled:opacity-50"
              aria-label={t('sidebar.importChat')}
            >
              <FileDown className={`w-4 h-4 ${importing ? 'animate-pulse' : ''}`} />
            </button>
          </div>
          <p
            className={`mt-1.5 h-4 text-center text-[11px] font-medium tracking-wide transition-opacity ${
              hoveredAction ? 'text-text-muted opacity-100' : 'opacity-0'
            }`}
            aria-live="polite"
          >
            {hoveredAction === 'new'
              ? t('sidebar.newTask')
              : hoveredAction === 'incognito'
                ? t('sidebar.incognitoTask')
                : hoveredAction === 'import'
                  ? t('sidebar.importChat')
                  : '\u00a0'}
          </p>
        </div>

        {divisionSessions.length > 0 && (
          <div className="mt-2 flex items-center gap-2">
            <div className="relative flex-1 min-w-0">
              <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-muted" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t('sidebar.search')}
                className="w-full rounded-xl border border-transparent bg-background pl-9 pr-3 py-2 text-[13px] text-text-primary placeholder:text-text-muted focus:outline-none focus:border-border transition-colors"
              />
            </div>
            <button
              onClick={() => {
                if (isSelectMode) {
                  exitSelectMode();
                } else {
                  setIsSelectMode(true);
                }
              }}
              className={`w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0 transition-colors ${
                isSelectMode
                  ? 'bg-accent text-white'
                  : 'text-text-secondary hover:text-text-primary hover:bg-surface-hover'
              }`}
              title={t('sidebar.manage')}
            >
              <ListChecks className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-4">
        {groupedSessions.length === 0 ? (
          <div className="px-3 py-6">
            <p className="text-sm text-text-secondary">
              {activeDivision?.kind === 'hub'
                ? 'No chats in Hub yet'
                : activeDivision?.kind === 'project'
                  ? 'No chats in this project yet'
                  : activeDivision?.kind === 'folder'
                    ? 'No chats in this folder yet'
                    : activeDivision?.kind === 'general'
                      ? 'No chats in General yet'
                      : t('sidebar.noTasks')}
            </p>
            <p className="mt-1 text-xs leading-5 text-text-muted">{t('sidebar.noTasksHint')}</p>
          </div>
        ) : (
          <div className="space-y-3">
            {groupedSessions.map((group) => (
              <section key={group.key}>
                <div className="px-3 pb-2 text-[11px] font-medium tracking-[0.04em] text-text-muted">
                  {group.label}
                </div>
                <div className="space-y-0.5">
                  {group.sessions.map((session) => {
                    const isActive = activeSessionId === session.id;
                    const isSelected = selectedIds.has(session.id);
                    const isIncognito = session.incognito === true;
                    const loopStatus = chatLoopBySessionId[session.id];
                    const isActiveLoop = Boolean(loopStatus && !loopStatus.stopReason);
                    return (
                      <div
                        key={session.id}
                        onClick={() => {
                          if (isSelectMode) {
                            toggleSelectSession(session.id);
                          } else {
                            handleSessionClick(session.id);
                          }
                        }}
                        onMouseEnter={() => setHoveredSession(session.id)}
                        onMouseLeave={() => setHoveredSession(null)}
                        className={`group relative cursor-pointer rounded-lg px-2.5 py-1.5 transition-colors ${
                          isSelectMode && isSelected
                            ? 'bg-accent-muted/20'
                            : isActive && !isSelectMode
                              ? 'bg-surface-hover/80'
                              : 'hover:bg-surface-hover/60'
                        } ${isIncognito ? 'border border-dashed border-border-subtle/80' : ''}`}
                      >
                        <div className={`flex items-center gap-2 ${!isSelectMode ? 'pr-14' : ''}`}>
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
                            <div className="text-[13px] font-medium leading-5 text-text-primary truncate">
                              {session.title}
                            </div>
                          </div>
                        </div>

                        {!isSelectMode && (
                          <>
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
              </section>
            ))}
          </div>
        )}
      </div>

      {isSelectMode ? (
        <div className="px-3 py-3 border-t border-border-muted">
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
        <div className="px-3 py-3 border-t border-border-muted space-y-2">
          {matterEnabled ? (
            <button
              type="button"
              onClick={handleOpenMatter}
              className={`w-full rounded-2xl px-3 py-2.5 flex items-center gap-2.5 text-left transition-colors border ${
                showMatter
                  ? 'bg-accent/15 text-accent border-accent/40'
                  : 'bg-background text-text-primary border-border-subtle hover:bg-surface-hover hover:border-accent/30'
              }`}
              title={t('sidebar.matter')}
            >
              <span
                className={`relative flex h-8 w-8 shrink-0 items-center justify-center rounded-xl ${
                  showMatter ? 'bg-accent/20' : 'bg-accent/10'
                }`}
              >
                <Radar className="w-4 h-4 text-accent" />
                {matterBadgeCount > 0 ? (
                  <span className="absolute -top-1 -right-1 min-w-[16px] h-[16px] px-0.5 rounded-full bg-red-500 text-white text-[9px] font-bold flex items-center justify-center">
                    {matterBadgeCount > 9 ? '9+' : matterBadgeCount}
                  </span>
                ) : null}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-semibold leading-tight">
                  {t('sidebar.matter')}
                </span>
                <span className="block text-[11px] text-text-muted leading-tight mt-0.5 truncate">
                  {t('sidebar.matterHint')}
                </span>
              </span>
            </button>
          ) : null}
          <button
            type="button"
            onClick={handleOpenWorkflows}
            className={`w-full rounded-2xl px-3 py-2.5 flex items-center gap-2.5 text-left transition-colors border ${
              showWorkflows
                ? 'bg-accent/15 text-accent border-accent/40'
                : 'bg-background text-text-primary border-border-subtle hover:bg-surface-hover hover:border-accent/30'
            }`}
            title={t('sidebar.workflows')}
          >
            <span
              className={`relative flex h-8 w-8 shrink-0 items-center justify-center rounded-xl ${
                showWorkflows ? 'bg-accent/20' : 'bg-accent/10'
              }`}
            >
              <Workflow className="w-4 h-4 text-accent" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-semibold leading-tight">
                {t('sidebar.workflows')}
              </span>
              <span className="block text-[11px] text-text-muted leading-tight mt-0.5 truncate">
                {t('sidebar.workflowsHint')}
              </span>
            </span>
          </button>
          <div className="flex items-center gap-2 rounded-2xl bg-background/50 px-3 py-2">
            {user ? (
              <>
                <SidebarUserAvatar name={user.name} image={user.image} />
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium text-text-primary truncate">
                    {user.name}
                  </div>
                  <div className="text-[11px] text-text-muted truncate">{user.email}</div>
                </div>
              </>
            ) : (
              <div className="min-w-0 flex-1" />
            )}
            <button
              type="button"
              onClick={handleOpenSettings}
              className="w-8 h-8 rounded-xl flex items-center justify-center text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors flex-shrink-0"
              title={t('sidebar.settings')}
            >
              <Settings className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={toggleTheme}
              className="w-8 h-8 rounded-xl flex items-center justify-center text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors flex-shrink-0"
              title={t('sidebar.themeToggle')}
            >
              {themeIcon}
            </button>
            {user ? (
              <button
                type="button"
                onClick={() => void logout()}
                className="w-8 h-8 rounded-xl flex items-center justify-center text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors flex-shrink-0"
                title={t('sidebar.signOut')}
              >
                <LogOut className="w-4 h-4" />
              </button>
            ) : null}
          </div>
          <SidebarUpdateButton />
        </div>
      )}
    </aside>
  );
}

function groupSessionsByDate(sessions: Session[], t: (key: string) => string): SessionGroup[] {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 86_400_000;
  const startOfPreviousWeek = startOfToday - 7 * 86_400_000;

  const pinnedSessions: Session[] = [];
  const unpinnedSessions: Session[] = [];
  for (const session of sessions) {
    if (session.pinned) {
      pinnedSessions.push(session);
    } else {
      unpinnedSessions.push(session);
    }
  }

  const sortByUpdatedAt = (a: Session, b: Session) =>
    (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt);

  pinnedSessions.sort(sortByUpdatedAt);

  const buckets: SessionGroup[] = [
    { key: 'today', label: t('sidebar.today'), sessions: [] },
    { key: 'yesterday', label: t('sidebar.yesterday'), sessions: [] },
    { key: 'previousWeek', label: t('sidebar.previousWeek'), sessions: [] },
    { key: 'older', label: t('sidebar.older'), sessions: [] },
  ];

  const sortedUnpinned = [...unpinnedSessions].sort(sortByUpdatedAt);
  for (const session of sortedUnpinned) {
    const timestamp = session.updatedAt || session.createdAt;
    if (timestamp >= startOfToday) {
      buckets[0].sessions.push(session);
    } else if (timestamp >= startOfYesterday) {
      buckets[1].sessions.push(session);
    } else if (timestamp >= startOfPreviousWeek) {
      buckets[2].sessions.push(session);
    } else {
      buckets[3].sessions.push(session);
    }
  }

  const groups: SessionGroup[] = [];
  if (pinnedSessions.length > 0) {
    groups.push({ key: 'pinned', label: t('sidebar.pinned'), sessions: pinnedSessions });
  }
  groups.push(...buckets.filter((bucket) => bucket.sessions.length > 0));
  return groups;
}
