import { create } from 'zustand';
import type {
  Session,
  Message,
  TraceStep,
  PermissionRequest,
  SudoPasswordRequest,
  UserQuestionRequest,
  Settings,
  AppConfig,
  SandboxSetupProgress,
  SandboxSyncStatus,
  SkillsStorageChangeEvent,
  ChatLoopStatus,
} from '../types';
import { applySessionUpdate } from '../utils/session-update';
import type { ActiveDivision } from '../../shared/workspace-division';
import type { MatterChatDraft } from '../../shared/matter-chat';
import type { HubUsageMeterSnapshot } from '../../shared/fe-budget-gate';
import {
  loadActiveDivisionFromStorage,
  saveActiveDivisionToStorage,
  sessionMatchesActiveDivision,
} from '../../shared/workspace-division';

export type GlobalNoticeType = 'info' | 'warning' | 'error' | 'success';

export interface GlobalNotice {
  id: string;
  message: string;
  messageKey?: string;
  messageValues?: Record<string, string | number>;
  type: GlobalNoticeType;
  actionLabel?: string;
  /** Prefer this over actionLabel so the toast translates at render time. */
  actionLabelKey?: string;
  action?: string;
  /** Auto-dismiss delay in ms (default 6000). */
  durationMs?: number;
}

export interface SessionExecutionClock {
  startAt: number | null;
  endAt: number | null;
}

export interface CompactionEvent {
  id: string;
  timestamp: number;
  tokensBefore: number;
  tokensAfter: number | null;
  summary: string;
  readFiles: string[];
  modifiedFiles: string[];
  type: 'auto' | 'manual';
}

// Unified per-session state that replaces 8 parallel xxxBySession Maps
export interface SessionState {
  messages: Message[];
  partialMessage: string;
  partialThinking: string;
  pendingTurns: string[];
  activeTurn: { stepId: string; userMessageId: string } | null;
  executionClock: SessionExecutionClock;
  traceSteps: TraceStep[];
  contextWindow: number;
  compactionHistory: CompactionEvent[];
}

const DEFAULT_SESSION_STATE: SessionState = {
  messages: [],
  partialMessage: '',
  partialThinking: '',
  pendingTurns: [],
  activeTurn: null,
  executionClock: { startAt: null, endAt: null },
  traceSteps: [],
  contextWindow: 0,
  compactionHistory: [],
};

// Helper to immutably update a single session's state within the record
function patchSession(
  states: Record<string, SessionState>,
  sessionId: string,
  updates: Partial<SessionState>
): Record<string, SessionState> {
  const current = states[sessionId] ?? DEFAULT_SESSION_STATE;
  return {
    ...states,
    [sessionId]: { ...current, ...updates },
  };
}

// Helper to get a session's state with safe defaults
function getSession(states: Record<string, SessionState>, sessionId: string): SessionState {
  return states[sessionId] ?? DEFAULT_SESSION_STATE;
}

interface AppState {
  // Sessions
  sessions: Session[];
  activeSessionId: string | null;

  // Per-session state (messages, partials, turns, traces, etc.)
  sessionStates: Record<string, SessionState>;

  // Ephemeral viewport state, kept separate so scrolling does not rerender message consumers.
  sessionScrollPositions: Record<string, number>;

  // UI state
  isLoading: boolean;
  sidebarCollapsed: boolean;
  contextPanelCollapsed: boolean;
  /** Live HTML artifact preview in the right rail (Claude Desktop–style). */
  activeHtmlPreview: {
    path: string;
    title?: string;
    revision: number;
  } | null;
  showSettings: boolean;
  showMatter: boolean;
  showWorkflows: boolean;
  settingsTab: string | null;
  matterBadgeCount: number;
  /** Global “Ask Growth OS” overlay open state. */
  askGrowthOSOpen: boolean;
  /** Session id bound to the Ask Growth OS popup (multi-turn while open). */
  askGrowthOSSessionId: string | null;

  // Permission
  pendingPermission: PermissionRequest | null;

  // AskUserQuestion — keyed by sessionId so concurrent sessions cannot clobber each other
  pendingQuestionsBySessionId: Record<string, UserQuestionRequest>;

  // Sudo password
  pendingSudoPassword: SudoPasswordRequest | null;

  // Settings
  settings: Settings;

  // App Config (API settings)
  appConfig: AppConfig | null;
  isConfigured: boolean;
  hasSeenInitialConfigStatus: boolean;
  globalNotice: GlobalNotice | null;

  // Working directory (pending path for new chats / WelcomeView)
  workingDir: string | null;
  /**
   * App default workspace folder (userData/default_working_dir).
   * Captured on first workdir.changed from main; used to reset after project switches.
   */
  defaultWorkingDir: string | null;

  /** Active workspace division (General / Hub / Project). Null = show chooser. */
  activeDivision: ActiveDivision | null;

  // Sandbox setup
  sandboxSetupProgress: SandboxSetupProgress | null;
  isSandboxSetupComplete: boolean;

  // Sandbox sync (per-session)
  sandboxSyncStatus: SandboxSyncStatus | null;
  skillsStorageChangedAt: number;
  skillsStorageChangeEvent: SkillsStorageChangeEvent | null;

  /** Active /loop|/goal status keyed by sessionId (null/missing = no loop). */
  chatLoopBySessionId: Record<string, ChatLoopStatus>;

  /**
   * Pending Matter chat draft keyed by session id — context card + composer prefill
   * until the user sends their first message (no auto-run).
   */
  matterChatDraftBySessionId: Record<string, MatterChatDraft>;

  // System theme (from OS native theme)
  systemDarkMode: boolean;

  /** Welcome composer is primed for an incognito (ephemeral) chat. */
  incognitoDraft: boolean;

  /** Hub AI budget meter (seeded from GET ai-budget, updated after usage ingest). */
  hubUsage: HubUsageMeterSnapshot | null;

  // Actions
  setSessions: (sessions: Session[]) => void;
  addSession: (session: Session) => void;
  updateSession: (sessionId: string, updates: Partial<Session>) => void;
  removeSession: (sessionId: string) => void;
  removeSessions: (sessionIds: string[]) => void;
  setActiveSession: (sessionId: string | null) => void;
  setIncognitoDraft: (enabled: boolean) => void;
  setSessionScrollPosition: (sessionId: string, scrollTop: number) => void;

  addMessage: (sessionId: string, message: Message) => void;
  updateMessage: (sessionId: string, messageId: string, updates: Partial<Message>) => void;
  startExecutionClock: (sessionId: string, startAt: number) => void;
  finishExecutionClock: (sessionId: string, endAt?: number) => void;
  clearExecutionClock: (sessionId: string) => void;
  setMessages: (sessionId: string, messages: Message[]) => void;
  setPartialMessage: (sessionId: string, partial: string) => void;
  clearPartialMessage: (sessionId: string) => void;
  setPartialThinking: (sessionId: string, delta: string) => void;
  clearPartialThinking: (sessionId: string) => void;
  activateNextTurn: (sessionId: string, stepId: string) => void;
  beginActiveTurn: (sessionId: string, stepId: string, userMessageId: string) => void;
  updateActiveTurnStep: (sessionId: string, stepId: string) => void;
  clearActiveTurn: (sessionId: string, stepId?: string) => void;
  clearPendingTurns: (sessionId: string) => void;
  clearQueuedMessages: (sessionId: string) => void;
  cancelQueuedMessages: (sessionId: string) => void;
  /** Remove a single queued message from the transcript queue and pending turns. */
  removeQueuedMessage: (sessionId: string, messageId: string) => number | null;

  addTraceStep: (sessionId: string, step: TraceStep) => void;
  updateTraceStep: (sessionId: string, stepId: string, updates: Partial<TraceStep>) => void;
  setTraceSteps: (sessionId: string, steps: TraceStep[]) => void;

  setLoading: (loading: boolean) => void;
  toggleSidebar: () => void;
  toggleContextPanel: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setContextPanelCollapsed: (collapsed: boolean) => void;
  openHtmlPreview: (path: string, title?: string) => void;
  closeHtmlPreview: () => void;
  setShowSettings: (show: boolean) => void;
  setShowMatter: (show: boolean) => void;
  setShowWorkflows: (show: boolean) => void;
  setSettingsTab: (tab: string | null) => void;
  setMatterBadgeCount: (count: number) => void;
  setAskGrowthOSOpen: (open: boolean) => void;
  toggleAskGrowthOS: () => void;
  setAskGrowthOSSessionId: (sessionId: string | null) => void;

  setPendingPermission: (permission: PermissionRequest | null) => void;

  setPendingQuestion: (question: UserQuestionRequest) => void;
  clearPendingQuestion: (sessionId: string, questionId?: string) => void;

  setPendingSudoPassword: (request: SudoPasswordRequest | null) => void;

  setSettings: (updates: Partial<Settings>) => void;
  updateSettings: (updates: Partial<Settings>) => void;

  // Config actions
  setAppConfig: (config: AppConfig | null) => void;
  setIsConfigured: (configured: boolean) => void;
  markInitialConfigStatusSeen: () => void;
  setGlobalNotice: (notice: GlobalNotice | null) => void;
  clearGlobalNotice: () => void;

  // Working directory actions
  setWorkingDir: (path: string | null) => void;
  setDefaultWorkingDir: (path: string | null) => void;

  // Workspace division
  setActiveDivision: (division: ActiveDivision | null) => void;

  // Sandbox setup actions
  setSandboxSetupProgress: (progress: SandboxSetupProgress | null) => void;
  setSandboxSetupComplete: (complete: boolean) => void;

  // Sandbox sync actions
  setSandboxSyncStatus: (status: SandboxSyncStatus | null) => void;
  setSkillsStorageChangedAt: (timestamp: number) => void;
  setSkillsStorageChangeEvent: (event: SkillsStorageChangeEvent | null) => void;

  setChatLoopStatus: (sessionId: string, status: ChatLoopStatus | null) => void;

  setHubUsage: (snapshot: HubUsageMeterSnapshot | null) => void;

  setMatterChatDraft: (sessionId: string, draft: MatterChatDraft) => void;
  clearMatterChatDraft: (sessionId: string) => void;

  // Context window actions
  setSessionContextWindow: (sessionId: string, contextWindow: number) => void;

  // Compaction history actions
  addCompactionEvent: (sessionId: string, event: CompactionEvent) => void;

  // System theme actions
  setSystemDarkMode: (dark: boolean) => void;
}

const defaultSettings: Settings = {
  theme: 'light',
  defaultTools: [
    'askuserquestion',
    'todowrite',
    'todoread',
    'webfetch',
    'websearch',
    'read',
    'write',
    'edit',
    'list_directory',
    'glob',
    'grep',
  ],
  permissionRules: [
    { tool: 'read', action: 'allow' },
    { tool: 'glob', action: 'allow' },
    { tool: 'grep', action: 'allow' },
    { tool: 'wiki_search', action: 'allow' },
    { tool: 'wiki_read', action: 'allow' },
    { tool: 'wiki_list', action: 'allow' },
    { tool: 'write', action: 'ask' },
    { tool: 'edit', action: 'ask' },
    { tool: 'bash', action: 'ask' },
  ],
  globalSkillsPath: '',
  memoryStrategy: 'auto',
  maxContextTokens: 180000,
};

export const useAppStore = create<AppState>((set, get) => ({
  // Initial state
  sessions: [],
  activeSessionId: null,
  sessionStates: {},
  sessionScrollPositions: {},
  isLoading: false,
  sidebarCollapsed: false,
  contextPanelCollapsed: false,
  activeHtmlPreview: null,
  showSettings: false,
  showMatter: false,
  showWorkflows: false,
  settingsTab: null,
  matterBadgeCount: 0,
  askGrowthOSOpen: false,
  askGrowthOSSessionId: null,
  pendingPermission: null,
  pendingQuestionsBySessionId: {},
  pendingSudoPassword: null,
  settings: defaultSettings,
  appConfig: null,
  isConfigured: false,
  hasSeenInitialConfigStatus: false,
  globalNotice: null,
  workingDir: null,
  defaultWorkingDir: null,
  activeDivision: loadActiveDivisionFromStorage(),
  sandboxSetupProgress: null,
  isSandboxSetupComplete: false,
  sandboxSyncStatus: null,
  skillsStorageChangedAt: 0,
  skillsStorageChangeEvent: null,
  chatLoopBySessionId: {},
  matterChatDraftBySessionId: {},
  systemDarkMode: false,
  incognitoDraft: false,
  hubUsage: null,

  // Session actions
  setSessions: (sessions) =>
    set((state) => {
      // Keep live incognito chats if a list refresh races before main merges them.
      const missingEphemeral = state.sessions.filter(
        (session) =>
          session.incognito === true && !sessions.some((incoming) => incoming.id === session.id)
      );
      if (missingEphemeral.length === 0) {
        return { sessions };
      }
      return { sessions: [...missingEphemeral, ...sessions] };
    }),

  addSession: (session) =>
    set((state) => ({
      sessions: [session, ...state.sessions],
      sessionStates: {
        ...state.sessionStates,
        [session.id]: { ...DEFAULT_SESSION_STATE },
      },
      incognitoDraft: false,
    })),

  updateSession: (sessionId, updates) =>
    set((state) => ({
      sessions: applySessionUpdate(state.sessions, sessionId, updates),
    })),

  removeSession: (sessionId) =>
    set((state) => {
      const restSessionStates = { ...state.sessionStates };
      delete restSessionStates[sessionId];
      const restScrollPositions = Object.fromEntries(
        Object.entries(state.sessionScrollPositions).filter(([id]) => id !== sessionId)
      );
      const restMatterDrafts = { ...state.matterChatDraftBySessionId };
      delete restMatterDrafts[sessionId];
      return {
        sessions: state.sessions.filter((s) => s.id !== sessionId),
        sessionStates: restSessionStates,
        sessionScrollPositions: restScrollPositions,
        matterChatDraftBySessionId: restMatterDrafts,
        activeSessionId: state.activeSessionId === sessionId ? null : state.activeSessionId,
      };
    }),

  removeSessions: (sessionIds) =>
    set((state) => {
      const idSet = new Set(sessionIds);
      const newSessionStates: Record<string, SessionState> = {};
      const newScrollPositions: Record<string, number> = {};
      const newMatterDrafts: Record<string, MatterChatDraft> = {};
      for (const key of Object.keys(state.sessionStates)) {
        if (!idSet.has(key)) newSessionStates[key] = state.sessionStates[key];
      }
      for (const key of Object.keys(state.sessionScrollPositions)) {
        if (!idSet.has(key)) newScrollPositions[key] = state.sessionScrollPositions[key];
      }
      for (const key of Object.keys(state.matterChatDraftBySessionId)) {
        if (!idSet.has(key)) newMatterDrafts[key] = state.matterChatDraftBySessionId[key];
      }

      return {
        sessions: state.sessions.filter((s) => !idSet.has(s.id)),
        sessionStates: newSessionStates,
        sessionScrollPositions: newScrollPositions,
        matterChatDraftBySessionId: newMatterDrafts,
        activeSessionId:
          state.activeSessionId && idSet.has(state.activeSessionId) ? null : state.activeSessionId,
      };
    }),

  setActiveSession: (sessionId) =>
    set((state) => {
      const switching = sessionId !== state.activeSessionId;
      // When opening a chat, inherit its workspace path for next "new chat" in this workspace.
      const sessionCwd = sessionId
        ? state.sessions.find((s) => s.id === sessionId)?.cwd
        : undefined;
      const base = sessionId
        ? {
            activeSessionId: sessionId,
            showMatter: false,
            showSettings: false,
            showWorkflows: false,
            ...(switching ? { activeHtmlPreview: null } : {}),
            ...(sessionCwd ? { workingDir: sessionCwd } : {}),
          }
        : {
            activeSessionId: sessionId as string | null,
            activeHtmlPreview: null,
          };
      if (!sessionId || state.sessionStates[sessionId]) {
        return base;
      }
      return {
        ...base,
        sessionStates: {
          ...state.sessionStates,
          [sessionId]: { ...DEFAULT_SESSION_STATE },
        },
      };
    }),

  setIncognitoDraft: (enabled) => set({ incognitoDraft: enabled }),

  setSessionScrollPosition: (sessionId, scrollTop) =>
    set((state) => ({
      sessionScrollPositions: {
        ...state.sessionScrollPositions,
        [sessionId]: scrollTop,
      },
    })),

  // Message actions
  addMessage: (sessionId, message) =>
    set((state) => {
      const ss = getSession(state.sessionStates, sessionId);
      const messages = ss.messages;
      let updatedMessages = messages;
      let updatedPendingTurns = ss.pendingTurns;

      if (message.role === 'user') {
        updatedMessages = [...messages, message];
        updatedPendingTurns = [...ss.pendingTurns, message.id];
      } else {
        const activeTurn = ss.activeTurn;
        if (activeTurn?.userMessageId) {
          const anchorIndex = messages.findIndex((item) => item.id === activeTurn.userMessageId);
          if (anchorIndex >= 0) {
            let insertIndex = anchorIndex + 1;
            while (insertIndex < messages.length) {
              if (messages[insertIndex].role === 'user') break;
              insertIndex += 1;
            }
            updatedMessages = [
              ...messages.slice(0, insertIndex),
              message,
              ...messages.slice(insertIndex),
            ];
          } else {
            updatedMessages = [...messages, message];
          }
        } else {
          updatedMessages = [...messages, message];
        }
      }

      const shouldClearPartial = message.role === 'assistant';
      return {
        sessionStates: patchSession(state.sessionStates, sessionId, {
          messages: updatedMessages,
          pendingTurns: updatedPendingTurns,
          ...(shouldClearPartial ? { partialMessage: '', partialThinking: '' } : {}),
        }),
      };
    }),

  updateMessage: (sessionId, messageId, updates) =>
    set((state) => {
      const ss = getSession(state.sessionStates, sessionId);
      const idx = ss.messages.findIndex((m) => m.id === messageId);
      if (idx === -1) return {};
      const updatedMessages = ss.messages.map((m) =>
        m.id === messageId ? { ...m, ...updates } : m
      );
      return {
        sessionStates: patchSession(state.sessionStates, sessionId, { messages: updatedMessages }),
      };
    }),

  startExecutionClock: (sessionId, startAt) =>
    set((state) => ({
      sessionStates: patchSession(state.sessionStates, sessionId, {
        executionClock: { startAt, endAt: null },
      }),
    })),

  finishExecutionClock: (sessionId, endAt) =>
    set((state) => {
      const ss = getSession(state.sessionStates, sessionId);
      if (ss.executionClock.startAt === null) return {};
      return {
        sessionStates: patchSession(state.sessionStates, sessionId, {
          executionClock: {
            startAt: ss.executionClock.startAt,
            endAt: endAt ?? Date.now(),
          },
        }),
      };
    }),

  clearExecutionClock: (sessionId) =>
    set((state) => ({
      sessionStates: patchSession(state.sessionStates, sessionId, {
        executionClock: { startAt: null, endAt: null },
      }),
    })),

  setMessages: (sessionId, messages) =>
    set((state) => ({
      sessionStates: patchSession(state.sessionStates, sessionId, { messages }),
    })),

  setPartialMessage: (sessionId, partial) =>
    set((state) => {
      const ss = getSession(state.sessionStates, sessionId);
      return {
        sessionStates: patchSession(state.sessionStates, sessionId, {
          partialMessage: ss.partialMessage + partial,
        }),
      };
    }),

  clearPartialMessage: (sessionId) =>
    set((state) => ({
      sessionStates: patchSession(state.sessionStates, sessionId, { partialMessage: '' }),
    })),

  setPartialThinking: (sessionId, delta) =>
    set((state) => {
      const ss = getSession(state.sessionStates, sessionId);
      return {
        sessionStates: patchSession(state.sessionStates, sessionId, {
          partialThinking: ss.partialThinking + delta,
        }),
      };
    }),

  clearPartialThinking: (sessionId) =>
    set((state) => ({
      sessionStates: patchSession(state.sessionStates, sessionId, { partialThinking: '' }),
    })),

  activateNextTurn: (sessionId, stepId) =>
    set((state) => {
      const ss = getSession(state.sessionStates, sessionId);
      if (ss.pendingTurns.length === 0) {
        return {
          sessionStates: patchSession(state.sessionStates, sessionId, {
            activeTurn: null,
          }),
        };
      }

      const [nextMessageId, ...rest] = ss.pendingTurns;
      const updatedMessages = ss.messages.map((message) =>
        message.id === nextMessageId ? { ...message, localStatus: undefined } : message
      );

      return {
        sessionStates: patchSession(state.sessionStates, sessionId, {
          messages: updatedMessages,
          pendingTurns: rest,
          activeTurn: { stepId, userMessageId: nextMessageId },
        }),
      };
    }),

  beginActiveTurn: (sessionId, stepId, userMessageId) =>
    set((state) => {
      const ss = getSession(state.sessionStates, sessionId);
      const updatedMessages = ss.messages.map((message) =>
        message.id === userMessageId ? { ...message, localStatus: undefined } : message
      );
      const updatedPendingTurns = ss.pendingTurns.filter((id) => id !== userMessageId);

      return {
        sessionStates: patchSession(state.sessionStates, sessionId, {
          messages: updatedMessages,
          pendingTurns: updatedPendingTurns,
          activeTurn: { stepId, userMessageId },
        }),
      };
    }),

  updateActiveTurnStep: (sessionId, stepId) =>
    set((state) => {
      const ss = getSession(state.sessionStates, sessionId);
      if (!ss.activeTurn || ss.activeTurn.stepId === stepId) return {};
      return {
        sessionStates: patchSession(state.sessionStates, sessionId, {
          activeTurn: { ...ss.activeTurn, stepId },
        }),
      };
    }),

  clearActiveTurn: (sessionId, stepId) =>
    set((state) => {
      const ss = getSession(state.sessionStates, sessionId);
      if (!ss.activeTurn) return {};
      // Optimistic pending-step-* may never rebind; allow clear from the real
      // thinking step id so Processing cannot stick after a race.
      if (
        stepId &&
        ss.activeTurn.stepId !== stepId &&
        !ss.activeTurn.stepId.startsWith('pending-step-')
      ) {
        return {};
      }
      return {
        sessionStates: patchSession(state.sessionStates, sessionId, {
          activeTurn: null,
        }),
      };
    }),

  clearPendingTurns: (sessionId) =>
    set((state) => ({
      sessionStates: patchSession(state.sessionStates, sessionId, { pendingTurns: [] }),
    })),

  clearQueuedMessages: (sessionId) =>
    set((state) => {
      const ss = getSession(state.sessionStates, sessionId);
      let hasQueued = false;
      const updatedMessages = ss.messages.map((message) => {
        if (message.localStatus === 'queued') {
          hasQueued = true;
          return { ...message, localStatus: undefined };
        }
        return message;
      });
      // Also remove any queued message IDs from pendingTurns
      const queuedIds = new Set(
        ss.messages.filter((m) => m.localStatus === 'queued').map((m) => m.id)
      );
      const updatedPendingTurns = ss.pendingTurns.filter((id) => !queuedIds.has(id));
      if (!hasQueued) return {};
      return {
        sessionStates: patchSession(state.sessionStates, sessionId, {
          messages: updatedMessages,
          pendingTurns: updatedPendingTurns,
        }),
      };
    }),

  cancelQueuedMessages: (sessionId) =>
    set((state) => {
      const ss = getSession(state.sessionStates, sessionId);
      let hasQueued = false;
      const updatedMessages = ss.messages.map((message) => {
        if (message.localStatus === 'queued') {
          hasQueued = true;
          return { ...message, localStatus: 'cancelled' as const };
        }
        return message;
      });
      if (!hasQueued) return {};
      return {
        sessionStates: patchSession(state.sessionStates, sessionId, {
          messages: updatedMessages,
        }),
      };
    }),

  removeQueuedMessage: (sessionId, messageId) => {
    const ss = getSession(get().sessionStates, sessionId);
    const target = ss.messages.find(
      (message) => message.id === messageId && message.localStatus === 'queued'
    );
    if (!target) return null;

    const queueIndex = ss.messages
      .filter((message) => message.localStatus === 'queued')
      .findIndex((message) => message.id === messageId);
    if (queueIndex < 0) return null;

    set((state) => {
      const current = getSession(state.sessionStates, sessionId);
      return {
        sessionStates: patchSession(state.sessionStates, sessionId, {
          messages: current.messages.filter((message) => message.id !== messageId),
          pendingTurns: current.pendingTurns.filter((id) => id !== messageId),
        }),
      };
    });
    return queueIndex;
  },

  // Trace actions
  addTraceStep: (sessionId, step) =>
    set((state) => {
      const ss = getSession(state.sessionStates, sessionId);
      return {
        sessionStates: patchSession(state.sessionStates, sessionId, {
          traceSteps: [...ss.traceSteps, step],
        }),
      };
    }),

  updateTraceStep: (sessionId, stepId, updates) =>
    set((state) => {
      const ss = getSession(state.sessionStates, sessionId);
      return {
        sessionStates: patchSession(state.sessionStates, sessionId, {
          traceSteps: ss.traceSteps.map((step) =>
            step.id === stepId ? { ...step, ...updates } : step
          ),
        }),
      };
    }),

  setTraceSteps: (sessionId, steps) =>
    set((state) => ({
      sessionStates: patchSession(state.sessionStates, sessionId, { traceSteps: steps }),
    })),

  // UI actions
  setLoading: (loading) => set({ isLoading: loading }),
  toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
  toggleContextPanel: () =>
    set((state) => ({ contextPanelCollapsed: !state.contextPanelCollapsed })),
  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
  setContextPanelCollapsed: (collapsed) => set({ contextPanelCollapsed: collapsed }),
  openHtmlPreview: (path, title) =>
    set((state) => {
      const trimmed = path.trim();
      if (!trimmed) {
        return state;
      }
      const prev = state.activeHtmlPreview;
      const samePath = prev?.path === trimmed;
      return {
        activeHtmlPreview: {
          path: trimmed,
          title: title?.trim() || (samePath ? prev?.title : undefined) || undefined,
          revision: samePath ? (prev?.revision ?? 0) + 1 : 1,
        },
        contextPanelCollapsed: false,
      };
    }),
  closeHtmlPreview: () => set({ activeHtmlPreview: null }),
  setShowSettings: (show) =>
    set(
      show
        ? { showSettings: true, showMatter: false, showWorkflows: false }
        : { showSettings: false }
    ),
  setShowMatter: (show) =>
    set(
      show
        ? {
            showMatter: true,
            showSettings: false,
            showWorkflows: false,
            activeSessionId: null,
          }
        : { showMatter: false }
    ),
  setShowWorkflows: (show) =>
    set(
      show
        ? {
            showWorkflows: true,
            showSettings: false,
            showMatter: false,
            activeSessionId: null,
          }
        : { showWorkflows: false }
    ),
  setSettingsTab: (tab) => set({ settingsTab: tab }),
  setMatterBadgeCount: (count) => set({ matterBadgeCount: Math.max(0, count) }),
  setHubUsage: (snapshot) => set({ hubUsage: snapshot }),
  setAskGrowthOSOpen: (open) =>
    set((state) =>
      open
        ? { askGrowthOSOpen: true }
        : { askGrowthOSOpen: false, askGrowthOSSessionId: state.askGrowthOSSessionId }
    ),
  toggleAskGrowthOS: () =>
    set((state) =>
      state.askGrowthOSOpen ? { askGrowthOSOpen: false } : { askGrowthOSOpen: true }
    ),
  setAskGrowthOSSessionId: (sessionId) => set({ askGrowthOSSessionId: sessionId }),

  // Permission actions
  setPendingPermission: (permission) => set({ pendingPermission: permission }),

  // AskUserQuestion actions
  setPendingQuestion: (question) =>
    set((state) => ({
      pendingQuestionsBySessionId: {
        ...state.pendingQuestionsBySessionId,
        [question.sessionId]: question,
      },
    })),
  clearPendingQuestion: (sessionId, questionId) =>
    set((state) => {
      const current = state.pendingQuestionsBySessionId[sessionId];
      if (!current) {
        return state;
      }
      if (questionId && current.questionId !== questionId) {
        return state;
      }
      const next = { ...state.pendingQuestionsBySessionId };
      delete next[sessionId];
      return { pendingQuestionsBySessionId: next };
    }),

  // Sudo password actions
  setPendingSudoPassword: (request) => set({ pendingSudoPassword: request }),

  // Settings actions
  setSettings: (updates) =>
    set((state) => ({
      settings: { ...state.settings, ...updates },
    })),
  updateSettings: (updates) => {
    if (typeof window !== 'undefined' && window.electronAPI) {
      window.electronAPI.send({
        type: 'settings.update',
        payload: updates as Record<string, unknown>,
      });
    }
    set((state) => ({
      settings: { ...state.settings, ...updates },
    }));
  },

  // Config actions
  setAppConfig: (config) => set({ appConfig: config }),
  setIsConfigured: (configured) => set({ isConfigured: configured }),
  markInitialConfigStatusSeen: () => set({ hasSeenInitialConfigStatus: true }),
  setGlobalNotice: (notice) => set({ globalNotice: notice }),
  clearGlobalNotice: () => set({ globalNotice: null }),

  // Working directory actions
  setWorkingDir: (path) => set({ workingDir: path }),
  setDefaultWorkingDir: (path) => set({ defaultWorkingDir: path }),

  setActiveDivision: (division) =>
    set((state) => {
      saveActiveDivisionToStorage(division);
      const activeSession =
        state.activeSessionId != null
          ? state.sessions.find((s) => s.id === state.activeSessionId)
          : null;
      const keepActive =
        activeSession && sessionMatchesActiveDivision(activeSession, division)
          ? state.activeSessionId
          : null;
      const divisionChanged = JSON.stringify(state.activeDivision) !== JSON.stringify(division);
      // Drop cross-project pending workdir so WelcomeView / new chats don't keep the old path.
      const shouldResetWorkdir = divisionChanged && !keepActive && Boolean(state.defaultWorkingDir);
      return {
        activeDivision: division,
        activeSessionId: keepActive,
        ...(shouldResetWorkdir ? { workingDir: state.defaultWorkingDir } : {}),
      };
    }),

  // Sandbox setup actions
  setSandboxSetupProgress: (progress) => set({ sandboxSetupProgress: progress }),
  setSandboxSetupComplete: (complete) => set({ isSandboxSetupComplete: complete }),

  // Sandbox sync actions
  setSandboxSyncStatus: (status) => set({ sandboxSyncStatus: status }),
  setSkillsStorageChangedAt: (timestamp) => set({ skillsStorageChangedAt: timestamp }),
  setSkillsStorageChangeEvent: (event) => set({ skillsStorageChangeEvent: event }),

  setChatLoopStatus: (sessionId, status) =>
    set((state) => {
      if (!status) {
        if (!(sessionId in state.chatLoopBySessionId)) return {};
        const next = { ...state.chatLoopBySessionId };
        delete next[sessionId];
        return { chatLoopBySessionId: next };
      }
      return {
        chatLoopBySessionId: {
          ...state.chatLoopBySessionId,
          [sessionId]: status,
        },
      };
    }),

  setMatterChatDraft: (sessionId, draft) =>
    set((state) => ({
      matterChatDraftBySessionId: {
        ...state.matterChatDraftBySessionId,
        [sessionId]: draft,
      },
    })),

  clearMatterChatDraft: (sessionId) =>
    set((state) => {
      if (!(sessionId in state.matterChatDraftBySessionId)) return {};
      const next = { ...state.matterChatDraftBySessionId };
      delete next[sessionId];
      return { matterChatDraftBySessionId: next };
    }),

  // Context window actions
  setSessionContextWindow: (sessionId, contextWindow) =>
    set((state) => ({
      sessionStates: patchSession(state.sessionStates, sessionId, { contextWindow }),
    })),

  // Compaction history actions
  addCompactionEvent: (sessionId, event) =>
    set((state) => {
      const current = state.sessionStates[sessionId] ?? DEFAULT_SESSION_STATE;
      return {
        sessionStates: {
          ...state.sessionStates,
          [sessionId]: {
            ...current,
            compactionHistory: [...current.compactionHistory, event],
          },
        },
      };
    }),

  // System theme actions
  setSystemDarkMode: (dark) => set({ systemDarkMode: dark }),
}));

// Expose helpers for nav-server (CLI-driven UI navigation via executeJavaScript)
if (typeof window !== 'undefined') {
  const w = window as unknown as Record<string, unknown>;

  w.__getNavStatus = () => {
    const s = useAppStore.getState();
    return {
      showSettings: !!s.showSettings,
      showMatter: !!s.showMatter,
      showWorkflows: !!s.showWorkflows,
      askGrowthOSOpen: !!s.askGrowthOSOpen,
      activeSessionId: s.activeSessionId || null,
      sessionCount: (s.sessions || []).length,
    };
  };

  w.__navigate = (page: string, tab?: string, sessionId?: string) => {
    const store = useAppStore.getState();
    if (page === 'welcome') {
      store.setShowSettings(false);
      store.setShowMatter(false);
      store.setShowWorkflows(false);
      store.setAskGrowthOSOpen(false);
      store.setActiveSession(null);
    } else if (page === 'matter') {
      const enabled =
        store.appConfig?.matterEnabled ?? store.appConfig?.matterRuntime?.enabled ?? true;
      if (!enabled) return false;
      store.setShowMatter(true);
    } else if (page === 'workflows') {
      store.setShowWorkflows(true);
    } else if (page === 'settings') {
      if (tab === 'workflows') {
        store.setShowWorkflows(true);
        return true;
      }
      store.setSettingsTab(tab || 'connectors');
      store.setShowSettings(true);
    } else if (page === 'ask') {
      store.setAskGrowthOSOpen(true);
    } else if (page === 'session') {
      if (!sessionId || typeof sessionId !== 'string') return false;
      const exists = store.sessions.some((s) => s.id === sessionId);
      if (!exists) return false;
      store.setShowSettings(false);
      store.setShowMatter(false);
      store.setShowWorkflows(false);
      store.setAskGrowthOSOpen(false);
      store.setActiveSession(sessionId);
    }
    return true;
  };
}
