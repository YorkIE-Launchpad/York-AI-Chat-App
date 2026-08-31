/**
 * @module main/session/session-manager
 *
 * Session lifecycle manager (957 lines).
 *
 * Responsibilities:
 * - Session CRUD: create, continue, stop, delete, list
 * - Chat history persistence to SQLite via DatabaseInstance
 * - Workspace-scoped sessions with sandbox integration
 * - Delegates AI execution to CoworkAgentRunner
 *
 * Dependencies: database, agent-runner, config-store, mcp-manager, sandbox-adapter
 */
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';
import type {
  Session,
  Message,
  ServerEvent,
  PermissionResult,
  ContentBlock,
  TextContent,
  TraceStep,
  FileAttachmentContent,
  MeetingAttachmentContent,
  ExternalReferenceContent,
  LiveAssistActivityPhase,
} from '../../renderer/types';
import type { DatabaseInstance, TraceStepRow } from '../db/database';
import type { MeetingService } from '../meetings/meeting-service';
import { PathResolver } from '../sandbox/path-resolver';
import {
  SandboxAdapter,
  getSandboxAdapter,
  initializeSandbox,
  reinitializeSandbox,
} from '../sandbox/sandbox-adapter';
import { SandboxSync } from '../sandbox/sandbox-sync';
import { CoworkAgentRunner } from '../agent/agent-runner';
import { configStore } from '../config/config-store';
import { MCPManager } from '../mcp/mcp-manager';
import { mcpConfigStore } from '../mcp/mcp-config-store';
import { PluginRuntimeService } from '../skills/plugin-runtime-service';
import { AgentRuntimeExtensionManager } from '../extensions/agent-runtime-extension-manager';
import type { AskUserQuestionExtension } from '../tools/ask-user-question-extension';
import { forgetSessionPermissions } from '../config/permission-rules-store';
import {
  log,
  logError,
  logWarn,
  logCtx,
  logCtxError,
  runWithLogContext,
  generateTraceId,
} from '../utils/logger';
import { maybeGenerateSessionTitle } from './session-title-flow';
import {
  buildTitlePrompt,
  getDefaultTitleFromPrompt,
  normalizeGeneratedTitle,
} from './session-title-utils';
import { generateTitleWithSdk } from '../agent/sdk-one-shot';
import { buildScheduledTaskTitle } from '../../shared/schedule/task-title';
import {
  normalizeSessionDivision,
  parseDivisionKind,
  type SessionDivisionFields,
} from '../../shared/workspace-division';
import type { ChatExportPayload } from './session-transfer';
import {
  isUnusableSessionCwd,
  resolveWritableSessionCwd,
} from './resolve-session-cwd';
import type { ChatSearchHit } from '../../shared/chat-search';
import { resolveExternalReference } from '../references/reference-service';

interface AgentRunner {
  run(session: Session, prompt: string, existingMessages: Message[]): Promise<void>;
  cancel(sessionId: string): void;
  clearSdkSession?(sessionId: string): void;
  clearAllSdkSessions?(): void;
  compact?(
    sessionId: string,
    customInstructions?: string
  ): Promise<{
    summary: string;
    firstKeptEntryId: string;
    tokensBefore: number;
    details?: unknown;
  } | null>;
  getContextUsage?(
    sessionId: string
  ): { tokens: number | null; contextWindow: number; percent: number | null } | null;
}

const WORKSPACE_MOUNT_VIRTUAL_PATH = '/mnt/workspace';
/** Claude Cowork skills often target this root; alias it to the same workspace folder. */
const COWORK_USER_DATA_VIRTUAL_PATH = '/mnt/user-data';
const TITLE_GENERATION_TIMEOUT_MS = 20000;

export class SessionManager {
  private db: DatabaseInstance;
  private sendToRenderer: (event: ServerEvent) => void;
  private pathResolver: PathResolver;
  private sandboxAdapter: SandboxAdapter;
  private agentRunner!: AgentRunner;
  private mcpManager: MCPManager;
  private pluginRuntimeService?: PluginRuntimeService;
  private extensionManager?: AgentRuntimeExtensionManager;
  private askUserQuestionExtension?: AskUserQuestionExtension;
  private activeSessions: Map<string, AbortController> = new Map();
  private promptQueues: Map<
    string,
    Array<{ prompt: string; content?: ContentBlock[]; broadcastUserMessage?: boolean }>
  > = new Map();
  private pendingPermissions: Map<string, (result: PermissionResult) => void> = new Map();
  /** Serialize permission UI prompts so a second ask cannot orphan the first in the renderer. */
  private permissionAskChain: Promise<void> = Promise.resolve();
  private pendingSudoPasswords: Map<
    string,
    { sessionId: string; resolve: (password: string | null) => void }
  > = new Map();
  private sandboxInitPromises: Map<string, Promise<void>> = new Map();
  private sessionTitleAttempts: Set<string> = new Set();
  private titleGenerationTokens: Map<string, symbol> = new Map();
  private messageCache: Map<string, Message[]> = new Map();
  private static readonly MAX_CACHE_SIZE = 100;
  private meetingService: MeetingService | null = null;
  /** In-memory-only sessions (incognito). Never written to SQLite. */
  private ephemeralSessions: Map<string, Session> = new Map();

  constructor(
    db: DatabaseInstance,
    sendToRenderer: (event: ServerEvent) => void,
    pluginRuntimeService?: PluginRuntimeService,
    extensionManager?: AgentRuntimeExtensionManager,
    askUserQuestionExtension?: AskUserQuestionExtension
  ) {
    this.db = db;
    this.sendToRenderer = (event) => {
      if (event.type === 'trace.step') {
        this.saveTraceStep(event.payload.sessionId, event.payload.step);
      }
      if (event.type === 'trace.update') {
        this.updateTraceStep(event.payload.stepId, event.payload.updates);
      }
      sendToRenderer(event);
    };
    this.pathResolver = new PathResolver();
    this.sandboxAdapter = getSandboxAdapter();
    this.pluginRuntimeService = pluginRuntimeService;
    this.extensionManager = extensionManager;
    this.askUserQuestionExtension = askUserQuestionExtension;

    // Initialize MCP Manager
    this.mcpManager = new MCPManager();
    this.initializeMCP();

    // Create agent runner based on current config
    this.createAgentRunner();

    log('[SessionManager] Initialized with persistent database and MCP support');
  }

  setMeetingService(service: MeetingService | null): void {
    this.meetingService = service;
  }

  /**
   * Prefer session cwd, then config/env/app default. Never use `/` (Electron
   * Finder launches often have process.cwd() === '/') — that yields `/.tmp`.
   */
  private resolveSessionCwd(cwd?: string | null): string {
    let userDataDefault: string | undefined;
    try {
      // Lazy require keeps unit tests that don't boot Electron happier.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { app } = require('electron') as typeof import('electron');
      if (app?.getPath) {
        userDataDefault = path.join(app.getPath('userData'), 'default_working_dir');
      }
    } catch {
      // non-electron / test harness
    }
    return resolveWritableSessionCwd([
      cwd,
      configStore.get('defaultWorkdir'),
      process.env.YORK_IE_WORKDIR,
      process.env.WORKDIR,
      process.env.DEFAULT_CWD,
      userDataDefault,
      process.cwd(),
    ]);
  }

  /** Stage attachments under `<writable-cwd>/.tmp`, healing unusable session.cwd. */
  private ensureSessionTmpDir(session: Session): string {
    const base = this.resolveSessionCwd(session.cwd);
    if (!session.cwd || isUnusableSessionCwd(session.cwd) || path.resolve(session.cwd) !== base) {
      session.cwd = base;
      session.mountedPaths = this.buildMountedPaths(base);
      if (!session.incognito) {
        try {
          this.db.sessions.update(session.id, {
            cwd: base,
            mounted_paths: JSON.stringify(session.mountedPaths),
            updated_at: Date.now(),
          });
        } catch (error) {
          logWarn('[SessionManager] Failed to persist healed session cwd:', error);
        }
      }
    }
    if (!fs.existsSync(base)) {
      fs.mkdirSync(base, { recursive: true });
    }
    const tmpDir = path.join(base, '.tmp');
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
      log('[SessionManager] Created .tmp directory:', tmpDir);
    }
    return tmpDir;
  }

  /**
   * Create agent runner based on current config
   * Can be called to recreate runner when config changes
   */
  private createAgentRunner(): void {
    this.agentRunner = this.createCoworkAgentRunner();
    log('[SessionManager] Using York IE agent runner');
  }

  private createCoworkAgentRunner(): CoworkAgentRunner {
    return new CoworkAgentRunner(
      {
        sendToRenderer: this.sendToRenderer,
        saveMessage: (message: Message) => this.saveMessage(message),
        requestSudoPassword: (sessionId: string, toolUseId: string, command: string) =>
          this.requestSudoPassword(sessionId, toolUseId, command),
        requestPermission: (
          sessionId: string,
          toolUseId: string,
          toolName: string,
          input: Record<string, unknown>
        ) => this.requestPermission(sessionId, toolUseId, toolName, input),
      },
      this.pathResolver,
      this.mcpManager,
      this.pluginRuntimeService,
      undefined,
      this.extensionManager
    );
  }

  /**
   * Notify that API config changed.
   * Model/apiKey/baseUrl changes are picked up per-query via configStore.getAll()
   * and hot-swapped via piSession.setModel(). No need to recreate the runner.
   */
  reloadConfig(): void {
    log('[SessionManager] API config changed — will apply on next query');
  }

  /**
   * Reinitialize MCP servers (call only when MCP config actually changes)
   */
  async reloadMCP(): Promise<void> {
    log('[SessionManager] Reloading MCP servers');
    await this.initializeMCP();
  }

  /**
   * Invalidate cached MCP servers config so the next query rebuilds tools.
   * Call after MCP server add/update/delete.
   */
  invalidateMcpServersCache(): void {
    if (this.agentRunner && 'invalidateMcpServersCache' in this.agentRunner) {
      (this.agentRunner as CoworkAgentRunner).invalidateMcpServersCache();
    }
  }

  /**
   * Invalidate skills setup so the next query re-links skills.
   * Call after skill install/uninstall/toggle.
   */
  invalidateSkillsSetup(): void {
    if (this.agentRunner && 'invalidateSkillsSetup' in this.agentRunner) {
      (this.agentRunner as CoworkAgentRunner).invalidateSkillsSetup();
    }
  }

  /**
   * Reinitialize sandbox adapter (call only when sandbox config changes)
   */
  async reloadSandbox(): Promise<void> {
    await this.reinitializeSandboxAsync();
  }

  /**
   * Reinitialize sandbox adapter asynchronously
   */
  private async reinitializeSandboxAsync(): Promise<void> {
    try {
      log('[SessionManager] Reinitializing sandbox adapter...');
      await reinitializeSandbox();
      this.sandboxAdapter = getSandboxAdapter();
      log('[SessionManager] Sandbox adapter reinitialized, mode:', this.sandboxAdapter.mode);
    } catch (error) {
      logError('[SessionManager] Failed to reinitialize sandbox:', error);
    }
  }

  /**
   * Initialize MCP servers from configuration
   */
  private async initializeMCP(): Promise<void> {
    try {
      mcpConfigStore.ensureDefaultChromeServer();
      mcpConfigStore.ensureDefaultLaunchpadServer();
      mcpConfigStore.ensureDefaultRndPulseServer();
      mcpConfigStore.ensureDefaultHubServer();
      mcpConfigStore.ensureDefaultGtmPulseServer();
      mcpConfigStore.ensureDefaultSlackServer();
      mcpConfigStore.ensureDefaultGmailServer();
      mcpConfigStore.ensureDefaultGoogleDriveServer();
      mcpConfigStore.ensureDefaultJiraServer();
      mcpConfigStore.ensureDefaultConfluenceServer();
      mcpConfigStore.ensureDefaultGoogleCalendarServer();
      const servers = mcpConfigStore.getEnabledServers();
      await this.mcpManager.initializeServers(servers);
      log(`[SessionManager] Initialized ${servers.length} MCP servers`);
    } catch (error) {
      logError('[SessionManager] Failed to initialize MCP servers:', error);
      this.sendToRenderer({
        type: 'error',
        payload: {
          message: `Failed to initialize MCP servers: ${error instanceof Error ? error.message : String(error)}`,
        },
      });
    }
  }

  /**
   * Get MCP manager instance
   */
  getMCPManager(): MCPManager {
    return this.mcpManager;
  }

  /**
   * Get sandbox adapter instance
   */
  getSandboxAdapter(): SandboxAdapter {
    return this.sandboxAdapter;
  }

  // Create and start a new session
  async startSession(
    title: string,
    prompt: string,
    cwd?: string,
    allowedTools?: string[],
    content?: ContentBlock[],
    memoryEnabled?: boolean,
    options?: {
      model?: string;
      provider?: string;
      lockModel?: boolean;
      division?: SessionDivisionFields['division'];
      hubProjectId?: string | null;
      hubProjectName?: string | null;
      launchpadProjectId?: number | null;
      launchpadProjectName?: string | null;
      folderId?: string | null;
      folderName?: string | null;
      canonicalKey?: string | null;
      incognito?: boolean;
    }
  ): Promise<Session> {
    const isIncognito = options?.incognito === true;
    log('[SessionManager] Starting new session:', title, isIncognito ? '(incognito)' : '');

    const session = this.createSession(
      isIncognito ? title || 'Incognito' : title,
      cwd,
      allowedTools,
      isIncognito ? false : memoryEnabled,
      options
    );

    if (session.incognito) {
      this.ephemeralSessions.set(session.id, session);
      this.messageCache.set(session.id, []);
    } else {
      this.saveSession(session);
    }

    // Start processing the prompt with content blocks
    this.enqueuePrompt(session, prompt, content);

    return session;
  }

  /**
   * Create a persisted (or ephemeral) idle session without enqueueing a prompt.
   * Used when the UI should wait for the user's first message (e.g. Matter Chat).
   */
  async createIdleSession(
    title: string,
    cwd?: string,
    allowedTools?: string[],
    memoryEnabled?: boolean,
    options?: {
      model?: string;
      provider?: string;
      lockModel?: boolean;
      division?: SessionDivisionFields['division'];
      hubProjectId?: string | null;
      hubProjectName?: string | null;
      launchpadProjectId?: number | null;
      launchpadProjectName?: string | null;
      folderId?: string | null;
      folderName?: string | null;
      canonicalKey?: string | null;
      incognito?: boolean;
    }
  ): Promise<Session> {
    const isIncognito = options?.incognito === true;
    log('[SessionManager] Creating idle session:', title, isIncognito ? '(incognito)' : '');

    const session = this.createSession(
      isIncognito ? title || 'Incognito' : title,
      cwd,
      allowedTools,
      isIncognito ? false : memoryEnabled,
      options
    );

    if (session.incognito) {
      this.ephemeralSessions.set(session.id, session);
      this.messageCache.set(session.id, []);
    } else {
      this.saveSession(session);
    }

    return session;
  }

  isIncognitoSession(sessionId: string): boolean {
    return this.ephemeralSessions.has(sessionId);
  }

  // Create a new session object
  private buildMountedPaths(cwd?: string): Session['mountedPaths'] {
    if (!cwd) {
      return [];
    }
    // Both virtual roots resolve to the same real workspace folder so skill
    // output paths like /mnt/user-data/outputs stay inside the project.
    return [
      { virtual: WORKSPACE_MOUNT_VIRTUAL_PATH, real: cwd },
      { virtual: COWORK_USER_DATA_VIRTUAL_PATH, real: cwd },
    ];
  }

  private createSession(
    title: string,
    cwd?: string,
    allowedTools?: string[],
    memoryEnabled?: boolean,
    options?: {
      model?: string;
      provider?: string;
      lockModel?: boolean;
      division?: SessionDivisionFields['division'];
      hubProjectId?: string | null;
      hubProjectName?: string | null;
      launchpadProjectId?: number | null;
      launchpadProjectName?: string | null;
      folderId?: string | null;
      folderName?: string | null;
      canonicalKey?: string | null;
      incognito?: boolean;
    }
  ): Session {
    const now = Date.now();
    // Prefer frontend-provided cwd; never leave sessions on `/` (see resolveSessionCwd).
    const effectiveCwd = this.resolveSessionCwd(cwd);
    const isIncognito = options?.incognito === true;
    const resolvedMemoryEnabled = isIncognito
      ? false
      : typeof memoryEnabled === 'boolean'
        ? memoryEnabled
        : configStore.get('memoryEnabled') !== false;
    const lockModel = options?.lockModel === true;
    const lockedModel = options?.model?.trim();
    const lockedProvider = options?.provider?.trim();
    const divisionFields = normalizeSessionDivision({
      division: options?.division,
      hubProjectId: options?.hubProjectId,
      hubProjectName: options?.hubProjectName,
      launchpadProjectId: options?.launchpadProjectId,
      launchpadProjectName: options?.launchpadProjectName,
      folderId: options?.folderId,
      folderName: options?.folderName,
      canonicalKey: options?.canonicalKey,
    });
    return {
      id: uuidv4(),
      title: isIncognito && !title.trim() ? 'Incognito' : title,
      status: 'idle',
      cwd: effectiveCwd,
      mountedPaths: this.buildMountedPaths(effectiveCwd),
      allowedTools: allowedTools || [
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
      memoryEnabled: resolvedMemoryEnabled,
      model: lockModel && lockedModel ? lockedModel : configStore.get('model') || undefined,
      provider: lockModel && lockedProvider ? lockedProvider : undefined,
      modelLocked: lockModel && Boolean(lockedModel),
      division: divisionFields.division,
      hubProjectId: divisionFields.hubProjectId,
      hubProjectName: divisionFields.hubProjectName,
      launchpadProjectId: divisionFields.launchpadProjectId,
      launchpadProjectName: divisionFields.launchpadProjectName,
      folderId: divisionFields.folderId,
      folderName: divisionFields.folderName,
      canonicalKey: divisionFields.canonicalKey,
      incognito: isIncognito || undefined,
      createdAt: now,
      updatedAt: now,
    };
  }

  // Save session to database
  private saveSession(session: Session) {
    if (session.incognito) {
      this.ephemeralSessions.set(session.id, { ...session, updatedAt: Date.now() });
      return;
    }
    const divisionFields = normalizeSessionDivision({
      division: session.division,
      hubProjectId: session.hubProjectId,
      hubProjectName: session.hubProjectName,
      launchpadProjectId: session.launchpadProjectId,
      launchpadProjectName: session.launchpadProjectName,
      folderId: session.folderId,
      folderName: session.folderName,
      canonicalKey: session.canonicalKey,
    });
    this.db.sessions.create({
      id: session.id,
      title: session.title,
      claude_session_id: session.claudeSessionId || null,
      openai_thread_id: session.openaiThreadId || null,
      status: session.status,
      cwd: session.cwd || null,
      mounted_paths: JSON.stringify(session.mountedPaths),
      allowed_tools: JSON.stringify(session.allowedTools),
      memory_enabled: session.memoryEnabled ? 1 : 0,
      model: session.model || null,
      division: divisionFields.division,
      hub_project_id: divisionFields.hubProjectId ?? null,
      hub_project_name: divisionFields.hubProjectName ?? null,
      launchpad_project_id: divisionFields.launchpadProjectId ?? null,
      launchpad_project_name: divisionFields.launchpadProjectName ?? null,
      folder_id: divisionFields.folderId ?? null,
      folder_name: divisionFields.folderName ?? null,
      project_canonical_key: divisionFields.canonicalKey ?? null,
      pinned: session.pinned ? 1 : 0,
      created_at: session.createdAt,
      updated_at: session.updatedAt,
    });
  }

  private mapSessionRow(row: {
    id: string;
    title: string;
    claude_session_id: string | null;
    openai_thread_id: string | null;
    status: string;
    cwd: string | null;
    mounted_paths: string;
    allowed_tools: string;
    memory_enabled: number;
    model: string | null;
    division?: string | null;
    hub_project_id?: string | null;
    hub_project_name?: string | null;
    launchpad_project_id?: number | null;
    launchpad_project_name?: string | null;
    folder_id?: string | null;
    folder_name?: string | null;
    project_canonical_key?: string | null;
    pinned?: number | null;
    created_at: number;
    updated_at: number;
  }): Session {
    let mountedPaths;
    try {
      mountedPaths = JSON.parse(row.mounted_paths);
    } catch (e) {
      logError('[SessionManager] Failed to parse mounted_paths:', e);
      mountedPaths = [];
    }

    let allowedTools;
    try {
      allowedTools = JSON.parse(row.allowed_tools);
    } catch (e) {
      logError('[SessionManager] Failed to parse allowed_tools:', e);
      allowedTools = [];
    }

    const divisionFields = normalizeSessionDivision({
      division: parseDivisionKind(row.division),
      hubProjectId: row.hub_project_id,
      hubProjectName: row.hub_project_name,
      launchpadProjectId: row.launchpad_project_id,
      launchpadProjectName: row.launchpad_project_name,
      folderId: row.folder_id,
      folderName: row.folder_name,
      canonicalKey: row.project_canonical_key,
    });

    return {
      id: row.id,
      title: row.title,
      claudeSessionId: row.claude_session_id || undefined,
      openaiThreadId: row.openai_thread_id || undefined,
      status: row.status as Session['status'],
      cwd: row.cwd || undefined,
      mountedPaths,
      allowedTools,
      memoryEnabled: row.memory_enabled === 1,
      model: row.model || undefined,
      division: divisionFields.division,
      hubProjectId: divisionFields.hubProjectId,
      hubProjectName: divisionFields.hubProjectName,
      launchpadProjectId: divisionFields.launchpadProjectId,
      launchpadProjectName: divisionFields.launchpadProjectName,
      folderId: divisionFields.folderId,
      folderName: divisionFields.folderName,
      canonicalKey: divisionFields.canonicalKey,
      pinned: row.pinned === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  // Load session from ephemeral map or database
  private loadSession(sessionId: string): Session | null {
    const ephemeral = this.ephemeralSessions.get(sessionId);
    if (ephemeral) {
      return { ...ephemeral };
    }
    const row = this.db.sessions.get(sessionId);
    if (!row) return null;
    return this.mapSessionRow(row);
  }

  // List all sessions (persisted + live ephemeral)
  listSessions(): Session[] {
    const persisted = this.db.sessions.getAll().map((row) => this.mapSessionRow(row));
    const ephemeral = Array.from(this.ephemeralSessions.values()).map((session) => ({
      ...session,
    }));
    // Ephemeral first so open incognito chats stay visible after session.list refresh
    return [...ephemeral, ...persisted];
  }

  /** Public session lookup for export/import and other callers. */
  getSession(sessionId: string): Session | null {
    return this.loadSession(sessionId);
  }

  searchChats(query: string, limit?: number): ChatSearchHit[] {
    return this.db.chatSearch.search(query, limit);
  }

  /**
   * Import a portable chat payload as a new local session.
   * Clears provider resume IDs so the agent cold-starts from message history.
   */
  importSessionFromPayload(
    payload: ChatExportPayload,
    attachmentFiles: Map<string, Buffer>,
    options: { cwd?: string } = {}
  ): Session {
    const envCwd = process.env.YORK_IE_WORKDIR || process.env.WORKDIR || process.env.DEFAULT_CWD;
    const effectiveCwd = options.cwd || configStore.get('defaultWorkdir') || envCwd || undefined;

    const session = this.createSession(
      payload.session.title || 'Imported chat',
      effectiveCwd,
      payload.session.allowedTools,
      payload.session.memoryEnabled,
      {
        model: payload.session.model,
        division: payload.session.division,
        hubProjectId: payload.session.hubProjectId,
        hubProjectName: payload.session.hubProjectName,
        launchpadProjectId: payload.session.launchpadProjectId,
        launchpadProjectName: payload.session.launchpadProjectName,
        folderId: payload.session.folderId,
        folderName: payload.session.folderName,
        canonicalKey: payload.session.canonicalKey,
      }
    );
    // Never carry exporter resume IDs; continue uses DB history preamble.
    session.claudeSessionId = undefined;
    session.openaiThreadId = undefined;
    session.status = 'idle';
    session.pinned = false;

    this.saveSession(session);

    const tmpDir = this.ensureSessionTmpDir(session);

    const importedMessages: Message[] = [];

    for (const original of payload.messages) {
      if (!original || typeof original !== 'object') continue;
      const newMessageId = uuidv4();

      const content = this.stageImportedAttachments(
        Array.isArray(original.content) ? original.content : [],
        attachmentFiles,
        tmpDir
      );

      const message: Message = {
        id: newMessageId,
        sessionId: session.id,
        role: original.role === 'assistant' || original.role === 'system' ? original.role : 'user',
        content,
        timestamp: typeof original.timestamp === 'number' ? original.timestamp : Date.now(),
        tokenUsage: original.tokenUsage,
        executionTimeMs: original.executionTimeMs,
        api: original.api,
        provider: original.provider,
        model: original.model,
      };

      this.db.messages.create({
        id: message.id,
        session_id: message.sessionId,
        role: message.role,
        content: JSON.stringify(message.content),
        timestamp: message.timestamp,
        token_usage: message.tokenUsage ? JSON.stringify(message.tokenUsage) : null,
        execution_time_ms: message.executionTimeMs ?? null,
      });
      importedMessages.push(message);
    }

    this.messageCache.set(session.id, importedMessages);

    for (const original of payload.traceSteps) {
      if (!original || typeof original !== 'object') continue;
      const step: TraceStep = {
        id: uuidv4(),
        type:
          original.type === 'thinking' ||
          original.type === 'text' ||
          original.type === 'tool_call' ||
          original.type === 'tool_result'
            ? original.type
            : 'text',
        status:
          original.status === 'pending' ||
          original.status === 'running' ||
          original.status === 'completed' ||
          original.status === 'error'
            ? original.status
            : 'completed',
        title: typeof original.title === 'string' ? original.title : 'Step',
        content: original.content,
        toolName: original.toolName,
        toolInput: original.toolInput,
        toolOutput: original.toolOutput,
        isError: original.isError,
        timestamp: typeof original.timestamp === 'number' ? original.timestamp : Date.now(),
        duration: original.duration,
      };
      this.saveTraceStep(session.id, step);
    }

    log(
      '[SessionManager] Imported session',
      session.id,
      'with',
      importedMessages.length,
      'messages'
    );
    return session;
  }

  private stageImportedAttachments(
    content: ContentBlock[],
    attachmentFiles: Map<string, Buffer>,
    tmpDir: string
  ): ContentBlock[] {
    const result: ContentBlock[] = [];
    for (const block of content) {
      if (block.type !== 'file_attachment') {
        result.push(block);
        continue;
      }
      const fileBlock = block as FileAttachmentContent;
      const basename = path.basename(fileBlock.relativePath || fileBlock.filename || '');
      const candidates = [
        basename,
        fileBlock.filename,
        path.basename(fileBlock.relativePath || ''),
      ].filter((v): v is string => Boolean(v && v.trim()));

      let buffer: Buffer | undefined;
      for (const key of candidates) {
        const found = attachmentFiles.get(key);
        if (found) {
          buffer = found;
          break;
        }
      }
      if (!buffer && fileBlock.inlineDataBase64) {
        buffer = Buffer.from(fileBlock.inlineDataBase64, 'base64');
      }

      if (!buffer) {
        logWarn(
          '[SessionManager] Imported message missing attachment file:',
          fileBlock.filename || fileBlock.relativePath
        );
        // Keep metadata chip so the conversation still reads coherently
        result.push({
          ...fileBlock,
          relativePath: fileBlock.relativePath || `.tmp/${fileBlock.filename || 'missing'}`,
          inlineDataBase64: undefined,
        });
        continue;
      }

      const destFilename = basename || fileBlock.filename || `attachment-${Date.now()}`;
      const safeName = path.basename(destFilename) || `attachment-${Date.now()}`;
      let destPath = path.join(tmpDir, safeName);
      if (fs.existsSync(destPath)) {
        const ext = path.extname(safeName);
        const stem = path.basename(safeName, ext);
        destPath = path.join(tmpDir, `${stem}-${uuidv4().slice(0, 8)}${ext}`);
      }
      fs.writeFileSync(destPath, buffer);
      const rest = { ...fileBlock };
      delete rest.inlineDataBase64;
      result.push({
        ...rest,
        filename: fileBlock.filename || path.basename(destPath),
        relativePath: path.join('.tmp', path.basename(destPath)),
        size: buffer.length,
      });
    }
    return result;
  }

  // Continue an existing session
  async continueSession(
    sessionId: string,
    prompt: string,
    content?: ContentBlock[],
    options?: { broadcastUserMessage?: boolean }
  ): Promise<void> {
    log('[SessionManager] Continuing session:', sessionId);

    const session = this.loadSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    this.enqueuePrompt(session, prompt, content, options);
  }

  async generateSessionTitleFromPrompt(prompt: string): Promise<string> {
    const normalizedPrompt = prompt.trim();
    if (!normalizedPrompt) {
      return 'New Session';
    }

    const generated = await this.withTimeout(
      this.generateTitleWithConfig(buildTitlePrompt(normalizedPrompt)),
      TITLE_GENERATION_TIMEOUT_MS,
      'session-title-preview'
    );
    const normalizedGenerated = normalizeGeneratedTitle(generated, normalizedPrompt);
    return normalizedGenerated ?? getDefaultTitleFromPrompt(normalizedPrompt);
  }

  async generateScheduledTaskTitle(prompt: string): Promise<string> {
    const sessionTitle = await this.generateSessionTitleFromPrompt(prompt);
    return buildScheduledTaskTitle(sessionTitle);
  }

  /**
   * Ensure sandbox is initialized for the session's workspace
   */
  private async ensureSandboxInitialized(session: Session): Promise<void> {
    if (!session.cwd) {
      log('[SessionManager] No workspace directory, skipping sandbox init');
      return;
    }

    // Check if already initialized with this exact workspace
    if (this.sandboxAdapter.initialized && this.sandboxAdapter.workspacePath === session.cwd) {
      return;
    }

    // Check if initialization is already in progress
    const existingPromise = this.sandboxInitPromises.get(session.cwd);
    if (existingPromise) {
      await existingPromise;
      return;
    }

    // Initialize sandbox with workspace
    const initPromise = initializeSandbox({
      workspacePath: session.cwd,
      mainWindow: null, // Will show dialogs globally
    }).then(() => {
      /* void */
    });

    this.sandboxInitPromises.set(session.cwd, initPromise);

    try {
      await initPromise;
      log('[SessionManager] Sandbox initialized for workspace:', session.cwd);
      log('[SessionManager] Sandbox mode:', this.sandboxAdapter.mode);
    } catch (error) {
      logError('[SessionManager] Failed to initialize sandbox:', error);
      this.sendToRenderer({
        type: 'error',
        payload: {
          message: `Failed to initialize sandbox: ${error instanceof Error ? error.message : String(error)}`,
        },
      });
      // Continue anyway - sandbox adapter will fallback to native
    } finally {
      this.sandboxInitPromises.delete(session.cwd);
    }
  }

  // Helper: Copy files to session's .tmp directory and sync to sandbox if needed
  private async processFileAttachments(
    session: Session,
    content: ContentBlock[]
  ): Promise<ContentBlock[]> {
    const processedContent: ContentBlock[] = [];
    const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
    const mimeByExt: Record<string, 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'> = {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      webp: 'image/webp',
    };

    for (const block of content) {
      if (block.type === 'file_attachment') {
        const fileBlock = block as FileAttachmentContent;

        try {
          const tmpDir = this.ensureSessionTmpDir(session);

          // Get source file path from the file attachment
          const sourcePath = (fileBlock.relativePath || '').trim(); // This is the full path from Electron
          // IMPORTANT: Use path.basename() to extract only the filename, not the full path
          const fallbackFilename = fileBlock.filename || sourcePath || `attachment-${Date.now()}`;
          const destFilename = path.basename(fallbackFilename);
          if (!destFilename) continue;
          const destPath = path.join(tmpDir, destFilename);
          let actualSize = 0;

          // Copy file to .tmp directory
          if (sourcePath && fs.existsSync(sourcePath)) {
            fs.copyFileSync(sourcePath, destPath);

            // Get actual file size
            const stats = fs.statSync(destPath);
            actualSize = stats.size;

            log(
              '[SessionManager] Copied file:',
              sourcePath,
              '->',
              destPath,
              `(${actualSize} bytes)`
            );
          } else if (fileBlock.inlineDataBase64) {
            const buffer = Buffer.from(fileBlock.inlineDataBase64, 'base64');
            fs.writeFileSync(destPath, buffer);
            actualSize = buffer.length;
            log('[SessionManager] Wrote file from inline data:', destPath, `(${actualSize} bytes)`);
          } else {
            logError(
              '[SessionManager] Source file not found and inline data missing:',
              sourcePath || '(empty path)'
            );
            // Skip this file attachment
            continue;
          }

          // If sandbox is already initialized, sync the file to sandbox as well
          // This handles the case where user attaches files in subsequent messages
          const sandboxPath = SandboxSync.getSandboxPath(session.id);
          if (sandboxPath) {
            const sandboxRelativePath = `.tmp/${destFilename}`;
            log('[SessionManager] Syncing attached file to sandbox:', sandboxRelativePath);
            const syncResult = await SandboxSync.syncFileToSandbox(
              session.id,
              destPath,
              sandboxRelativePath
            );
            if (syncResult.success) {
              log('[SessionManager] File synced to sandbox:', syncResult.sandboxPath);
            } else {
              logError('[SessionManager] Failed to sync file to sandbox:', syncResult.error);
              // Continue anyway - file is in Windows .tmp, agent might still work via /mnt/
            }
          } else {
            // Check for Lima sandbox
            const { LimaSync } = await import('../sandbox/lima-sync');
            const limaSandboxPath = LimaSync.getSandboxPath(session.id);
            if (limaSandboxPath) {
              const sandboxRelativePath = `.tmp/${destFilename}`;
              log('[SessionManager] Syncing attached file to Lima sandbox:', sandboxRelativePath);
              const syncResult = await LimaSync.syncFileToSandbox(
                session.id,
                destPath,
                sandboxRelativePath
              );
              if (syncResult.success) {
                log('[SessionManager] File synced to Lima sandbox:', syncResult.sandboxPath);
              } else {
                logError('[SessionManager] Failed to sync file to Lima sandbox:', syncResult.error);
                // Continue anyway - file is in macOS .tmp, agent might still work via direct access
              }
            }
          }

          // Image attachments become ImageContent so the UI can show thumbnails
          // and the model receives vision input (instead of a filename-only chip).
          const ext = path.extname(destFilename).slice(1).toLowerCase();
          const declaredMime = (fileBlock.mimeType || '').toLowerCase();
          const mediaType =
            mimeByExt[ext] ||
            (declaredMime === 'image/jpeg' ||
            declaredMime === 'image/png' ||
            declaredMime === 'image/gif' ||
            declaredMime === 'image/webp'
              ? declaredMime
              : null);

          if (mediaType && IMAGE_EXTS.has(ext)) {
            const imageBuffer = fs.readFileSync(destPath);
            processedContent.push({
              type: 'image',
              source: {
                type: 'base64',
                media_type: mediaType,
                data: imageBuffer.toString('base64'),
              },
            });
            continue;
          }

          // Update the content block with the new relative path and actual size
          const relativePathFromCwd = path.join('.tmp', destFilename);
          const restFileBlock = { ...fileBlock };
          delete restFileBlock.inlineDataBase64;
          processedContent.push({
            ...restFileBlock,
            relativePath: relativePathFromCwd,
            size: actualSize,
          });
        } catch (error) {
          logError('[SessionManager] Error copying file:', error);
          this.sendToRenderer({
            type: 'error',
            payload: {
              message: `Failed to process file attachment: ${error instanceof Error ? error.message : String(error)}`,
            },
          });
          // Skip this file attachment
        }
      } else {
        // Keep other content blocks as-is
        processedContent.push(block);
      }
    }

    return processedContent;
  }

  // Process a prompt using CoworkAgentRunner
  private async processPrompt(
    session: Session,
    prompt: string,
    content?: ContentBlock[],
    options?: { broadcastUserMessage?: boolean }
  ): Promise<void> {
    const traceId = generateTraceId();
    return runWithLogContext(
      { sessionId: session.id, traceId, incognito: session.incognito === true },
      async () => {
        logCtx('[SessionManager] Processing prompt for session:', session.id, 'traceId:', traceId);
        logCtx(
          '[SessionManager] Received content:',
          content
            ? JSON.stringify(
                content.map((c) => ({
                  type: c.type,
                  hasData: !!(c as { source?: { data?: unknown } }).source?.data,
                }))
              )
            : 'none'
        );

        // Ensure sandbox is initialized for this workspace
        await this.ensureSandboxInitialized(session);

        try {
          // Use provided content blocks or fall back to simple text
          let messageContent: ContentBlock[] =
            content && content.length > 0
              ? content
              : [{ type: 'text', text: prompt } as TextContent];

          // Process file attachments - copy to .tmp directory
          messageContent = await this.processFileAttachments(session, messageContent);

          logCtx(
            '[SessionManager] Final message content types:',
            messageContent.map((c) => c.type)
          );

          // Build enhanced prompt with file information
          let enhancedPrompt = prompt;
          const fileAttachments = messageContent.filter(
            (c) => c.type === 'file_attachment'
          ) as FileAttachmentContent[];
          if (fileAttachments.length > 0) {
            const fileInfo = fileAttachments
              .map(
                (f) =>
                  `- ${f.filename} (${(f.size / 1024).toFixed(1)} KB) at path: ${f.relativePath}`
              )
              .join('\n');
            enhancedPrompt = `${enhancedPrompt}\n\n[Attached files - use Read tool to access them]:\n${fileInfo}`;
            logCtx('[SessionManager] Enhanced prompt with file info:', enhancedPrompt);
          }

          const meetingAttachments = messageContent.filter(
            (c) => c.type === 'meeting_attachment'
          ) as MeetingAttachmentContent[];
          if (meetingAttachments.length > 0 && this.meetingService?.isChatReferenceAllowed()) {
            const meetingBlocks: string[] = [];
            for (const attachment of meetingAttachments) {
              const meeting = this.meetingService.get(attachment.meetingId);
              if (!meeting) {
                meetingBlocks.push(
                  `- Meeting "${attachment.title}" (${attachment.meetingId}) — not found`
                );
                continue;
              }
              meetingBlocks.push(
                this.meetingService.formatMeetingForPrompt(
                  meeting,
                  Boolean(attachment.includeTranscript)
                )
              );
            }
            if (meetingBlocks.length > 0) {
              enhancedPrompt = `${enhancedPrompt}\n\n[Attached meetings — use only for this request]:\n${meetingBlocks.join('\n\n')}`;
              logCtx('[SessionManager] Enhanced prompt with meeting attachments');
            }
          }

          const externalReferences = messageContent.filter(
            (c) => c.type === 'external_reference'
          ) as ExternalReferenceContent[];
          if (externalReferences.length > 0) {
            const referenceBlocks: string[] = [];
            for (const attachment of externalReferences) {
              try {
                const resolved = await resolveExternalReference(this.mcpManager, attachment);
                const header = [
                  attachment.source.toUpperCase(),
                  attachment.title,
                  resolved.url || attachment.url,
                ]
                  .filter(Boolean)
                  .join(' — ');
                const body = resolved.error
                  ? `(Could not load content: ${resolved.error})`
                  : resolved.text || '(No content returned)';
                referenceBlocks.push(`- ${header}\n${body}`);
              } catch (error) {
                referenceBlocks.push(
                  `- ${attachment.source.toUpperCase()} — ${attachment.title}\n(Could not load content: ${
                    error instanceof Error ? error.message : String(error)
                  })`
                );
              }
            }
            if (referenceBlocks.length > 0) {
              enhancedPrompt = `${enhancedPrompt}\n\n[Attached references — use only for this request]:\n${referenceBlocks.join('\n\n')}`;
              logCtx('[SessionManager] Enhanced prompt with external references');
            }
          }

          // Save user message to database for persistence
          const existingMessages = this.getMessages(session.id);
          const userMessage: Message = {
            id: uuidv4(),
            sessionId: session.id,
            role: 'user',
            content: messageContent, // Save full content including images and files
            timestamp: Date.now(),
          };
          this.saveMessage(userMessage);
          logCtx(
            '[SessionManager] User message saved:',
            userMessage.id,
            'with',
            messageContent.length,
            'content blocks'
          );
          // Main-process-initiated continues (loops, schedules) never go through the
          // renderer optimistic path — emit so the transcript shows the user turn.
          // UI-initiated continues already add the bubble; skip to avoid duplicates.
          if (options?.broadcastUserMessage) {
            this.sendToRenderer({
              type: 'stream.message',
              payload: { sessionId: session.id, message: userMessage },
            });
          }
          const messagesForContext = [...existingMessages, userMessage];

          // Update session model to match current config (may have changed since session creation),
          // unless this session pinned a model (e.g. scheduled tasks).
          if (!session.modelLocked) {
            const currentModel = configStore.get('model');
            if (currentModel && currentModel !== session.model) {
              session.model = currentModel;
              if (session.incognito) {
                const ephemeral = this.ephemeralSessions.get(session.id);
                if (ephemeral) {
                  ephemeral.model = currentModel;
                  ephemeral.updatedAt = Date.now();
                }
              } else {
                this.db.sessions.update(session.id, { model: currentModel });
              }
              this.sendToRenderer({
                type: 'session.update',
                payload: { sessionId: session.id, updates: { model: currentModel } },
              });
            }
          }

          // Run the agent
          await this.agentRunner.run(session, enhancedPrompt, messagesForContext);

          if (this.extensionManager) {
            const stableMessages = this.getMessages(session.id);
            this.extensionManager
              .afterSessionRun({
                session,
                prompt: enhancedPrompt,
                messages: stableMessages,
              })
              .catch((error) =>
                logCtxError('[SessionManager] Runtime extension post-run hook failed:', error)
              );
          }

          // Title generation is no longer concurrent with the first turn, to avoid competing with the main request for the same upstream quota/channel and feeling slower.
          // Incognito: skip LLM title generation; keep local "Incognito" / first-prompt title only.
          if (!session.incognito) {
            this.runSessionTitleGeneration(session, prompt, existingMessages).catch((err) =>
              logCtxError('[SessionManager] Title generation failed:', err)
            );
          } else if (existingMessages.length === 0) {
            const localTitle = getDefaultTitleFromPrompt(prompt);
            if (localTitle && localTitle !== session.title) {
              this.updateSessionTitle(session.id, localTitle);
              session.title = localTitle;
            }
          }
        } catch (error) {
          logCtxError('[SessionManager] Error processing prompt:', error);
          const errorText = error instanceof Error ? error.message : 'Unknown error';
          const alreadyReportedToUser = Boolean(
            error &&
            typeof error === 'object' &&
            (error as { alreadyReportedToUser?: boolean }).alreadyReportedToUser
          );
          if (!alreadyReportedToUser) {
            const assistantMessage: Message = {
              id: uuidv4(),
              sessionId: session.id,
              role: 'assistant',
              content: [{ type: 'text', text: `**Error**: ${errorText}` }],
              timestamp: Date.now(),
            };
            this.saveMessage(assistantMessage);
            this.sendToRenderer({
              type: 'stream.message',
              payload: { sessionId: session.id, message: assistantMessage },
            });
          }
          this.sendToRenderer({
            type: 'error',
            payload: { message: errorText },
          });
        }
      }
    ); // end runWithLogContext
  }

  private async runSessionTitleGeneration(
    session: Session,
    prompt: string,
    existingMessages: Message[]
  ): Promise<void> {
    const token = Symbol(`title:${session.id}`);
    this.titleGenerationTokens.set(session.id, token);
    const shouldAbort = () => {
      if (this.titleGenerationTokens.get(session.id) !== token) {
        return true;
      }
      return !this.db.sessions.get(session.id);
    };
    const userMessageCount =
      existingMessages.filter((message) => message.role === 'user').length + 1;
    try {
      await maybeGenerateSessionTitle({
        sessionId: session.id,
        prompt,
        userMessageCount,
        currentTitle: session.title,
        hasAttempted: this.sessionTitleAttempts.has(session.id),
        generateTitle: async (titlePrompt) => {
          if (shouldAbort()) {
            return null;
          }
          const title = await this.withTimeout(
            this.generateTitleWithConfig(titlePrompt),
            TITLE_GENERATION_TIMEOUT_MS,
            session.id
          );
          return normalizeGeneratedTitle(title);
        },
        getLatestTitle: () => this.db.sessions.get(session.id)?.title ?? null,
        markAttempt: () => {
          this.sessionTitleAttempts.add(session.id);
        },
        updateTitle: async (title) => {
          if (shouldAbort()) {
            log('[SessionTitle] Skip update: session no longer active', session.id);
            return false;
          }
          const updated = this.updateSessionTitle(session.id, title);
          if (updated) {
            session.title = title;
          }
          return updated;
        },
        shouldAbort,
        log,
      });
    } catch (error) {
      logError('[SessionTitle] Unexpected error', session.id, error);
    } finally {
      if (this.titleGenerationTokens.get(session.id) === token) {
        this.titleGenerationTokens.delete(session.id);
      }
    }
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    sessionId: string
  ): Promise<T | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        logError('[SessionTitle] Generation timed out', { sessionId, timeoutMs });
        resolve(null);
      }, timeoutMs);
      promise
        .then((value) => {
          clearTimeout(timer);
          resolve(value);
        })
        .catch((error) => {
          clearTimeout(timer);
          logError('[SessionTitle] Generation rejected', { sessionId, error });
          resolve(null);
        });
    });
  }

  private async generateTitleWithConfig(titlePrompt: string): Promise<string | null> {
    // Always use pi-ai SDK for title generation
    return normalizeGeneratedTitle(await generateTitleWithSdk(titlePrompt, configStore.getAll()));
  }

  private enqueuePrompt(
    session: Session,
    prompt: string,
    content?: ContentBlock[],
    options?: { broadcastUserMessage?: boolean }
  ): void {
    const queue = this.promptQueues.get(session.id) || [];
    queue.push({ prompt, content, broadcastUserMessage: options?.broadcastUserMessage });
    this.promptQueues.set(session.id, queue);

    if (!this.activeSessions.has(session.id)) {
      this.processQueue(session).catch((err) => {
        logError('[SessionManager] Queue processing error:', err);
        this.sendToRenderer({
          type: 'error',
          payload: {
            message: `Failed to process message: ${err instanceof Error ? err.message : String(err)}`,
          },
        });
      });
    } else {
      log('[SessionManager] Session running, queued prompt:', session.id);
    }
  }

  private async processQueue(session: Session): Promise<void> {
    if (this.activeSessions.has(session.id)) return;

    const controller = new AbortController();
    this.activeSessions.set(session.id, controller);
    this.updateSessionStatus(session.id, 'running');

    try {
      // Outer loop: after the inner loop drains, re-check for items that
      // arrived while processPrompt was awaited. This keeps the session in
      // activeSessions the entire time, preventing enqueuePrompt from
      // spawning a duplicate processQueue during the gap that previously
      // existed between activeSessions.delete and the restart call.
      let shouldContinue = true;
      while (shouldContinue) {
        while (!controller.signal.aborted) {
          const queue = this.promptQueues.get(session.id);
          if (!queue || queue.length === 0) break;

          const item = queue.shift();
          if (!item) continue;

          const latestSession = this.loadSession(session.id);
          if (!latestSession) {
            log('[SessionManager] Session removed while processing queue:', session.id);
            return; // finally handles cleanup
          }

          await this.processPrompt(latestSession, item.prompt, item.content, {
            broadcastUserMessage: item.broadcastUserMessage,
          });

          if (controller.signal.aborted) return; // finally handles cleanup
        }

        // If aborted, exit immediately — finally handles cleanup.
        if (controller.signal.aborted) {
          shouldContinue = false;
          continue;
        }

        // Re-check: items may have been enqueued during the last processPrompt await.
        const pendingQueue = this.promptQueues.get(session.id);
        if (!pendingQueue || pendingQueue.length === 0) {
          shouldContinue = false;
          continue;
        }

        // Reload session before continuing with newly arrived prompts.
        const latestSession = this.loadSession(session.id);
        if (!latestSession) {
          this.promptQueues.delete(session.id);
          shouldContinue = false;
          continue;
        }
        session = latestSession;
        log('[SessionManager] Continuing queue with newly arrived prompts:', session.id);
      }
    } finally {
      // Only clean up here — no restart logic needed since the outer loop
      // already handles re-checking. activeSessions is only deleted once
      // there are truly no pending items remaining.
      this.activeSessions.delete(session.id);
      const queue = this.promptQueues.get(session.id);
      if (queue && queue.length === 0) {
        this.promptQueues.delete(session.id);
      }
      this.updateSessionStatus(session.id, 'idle');
    }
  }

  // Stop a running session
  stopSession(sessionId: string): void {
    log('[SessionManager] Stopping session:', sessionId);
    this.titleGenerationTokens.delete(sessionId);
    this.agentRunner.cancel(sessionId);
    // Cancel any pending sudo password requests for this session
    for (const [toolUseId, entry] of this.pendingSudoPasswords) {
      if (entry.sessionId === sessionId) {
        entry.resolve(null);
        this.pendingSudoPasswords.delete(toolUseId);
        this.sendToRenderer({ type: 'sudo.password.dismiss', payload: { toolUseId } });
      }
    }
    // Cancel pending AskUserQuestion waits so the agent Promise cannot hang
    this.askUserQuestionExtension?.dismissSessionQuestions(sessionId, 'session stopped');
    // Also abort any pending controller we tracked
    const controller = this.activeSessions.get(sessionId);
    if (controller) {
      controller.abort();
    }
    this.promptQueues.delete(sessionId);
    // Preserve in-memory history for incognito — there is no DB to reload from.
    if (!this.ephemeralSessions.has(sessionId)) {
      this.messageCache.delete(sessionId);
    }
    this.updateSessionStatus(sessionId, 'idle');
  }

  /**
   * Remove a still-queued (not-yet-running) prompt by FIFO index.
   * Index 0 is the next prompt that will run when the current turn finishes.
   */
  removeQueuedPrompt(sessionId: string, queueIndex: number): boolean {
    const queue = this.promptQueues.get(sessionId);
    if (!queue || queueIndex < 0 || queueIndex >= queue.length) {
      log('[SessionManager] removeQueuedPrompt: index out of range', {
        sessionId,
        queueIndex,
        length: queue?.length ?? 0,
      });
      return false;
    }
    queue.splice(queueIndex, 1);
    if (queue.length === 0) {
      this.promptQueues.delete(sessionId);
    }
    log('[SessionManager] Removed queued prompt:', {
      sessionId,
      queueIndex,
      remaining: queue.length,
    });
    return true;
  }

  /** Resolve a pending AskUserQuestion from the renderer / remote channel. */
  handleQuestionResponse(questionId: string, answer: string): boolean {
    if (!this.askUserQuestionExtension) {
      logWarn('[SessionManager] No AskUserQuestion extension registered');
      return false;
    }
    return this.askUserQuestionExtension.handleQuestionResponse(questionId, answer);
  }

  /** Cancel a pending AskUserQuestion without treating it as a user answer. */
  cancelQuestion(questionId: string, reason: string): boolean {
    if (!this.askUserQuestionExtension) {
      return false;
    }
    return this.askUserQuestionExtension.cancelQuestion(questionId, reason);
  }

  // Delete a session
  async deleteSession(sessionId: string): Promise<void> {
    const existingSession = this.loadSession(sessionId);
    const wasIncognito = this.ephemeralSessions.has(sessionId);

    // Stop if running
    this.stopSession(sessionId);

    // Sync and cleanup sandbox if it exists for this session
    if (SandboxSync.hasSession(sessionId)) {
      log('[SessionManager] Cleaning up sandbox for session:', sessionId);
      try {
        await SandboxSync.syncAndCleanup(sessionId);
        log('[SessionManager] Sandbox cleanup complete for session:', sessionId);
      } catch (error) {
        logError('[SessionManager] Failed to cleanup sandbox:', error);
        // Continue with session deletion even if sandbox cleanup fails
      }
    }

    this.ephemeralSessions.delete(sessionId);
    if (!wasIncognito) {
      // Delete from database (messages will be deleted automatically via CASCADE)
      this.db.sessions.delete(sessionId);
    }
    this.messageCache.delete(sessionId);
    this.sessionTitleAttempts.delete(sessionId);
    this.titleGenerationTokens.delete(sessionId);
    if (this.agentRunner?.clearSdkSession) {
      this.agentRunner.clearSdkSession(sessionId);
    }
    if (this.extensionManager) {
      await this.extensionManager.onSessionDeleted({
        sessionId,
        session: existingSession,
      });
    }
    forgetSessionPermissions(sessionId);

    log('[SessionManager] Session deleted:', sessionId);
  }

  async batchDeleteSessions(sessionIds: string[]): Promise<void> {
    const sessionsById = new Map(
      sessionIds.map((sessionId) => [sessionId, this.loadSession(sessionId)] as const)
    );
    // Stop sessions and clean up sandboxes first (async, cannot run inside SQLite transaction)
    for (const sessionId of sessionIds) {
      this.stopSession(sessionId);
      if (SandboxSync.hasSession(sessionId)) {
        try {
          await SandboxSync.syncAndCleanup(sessionId);
        } catch (error) {
          logError('[SessionManager] Failed to cleanup sandbox during batch delete:', error);
        }
      }
    }

    const persistedIds = sessionIds.filter((id) => !this.ephemeralSessions.has(id));
    for (const sessionId of sessionIds) {
      this.ephemeralSessions.delete(sessionId);
      this.messageCache.delete(sessionId);
      this.sessionTitleAttempts.delete(sessionId);
      this.titleGenerationTokens.delete(sessionId);
      forgetSessionPermissions(sessionId);
      if (this.agentRunner?.clearSdkSession) {
        this.agentRunner.clearSdkSession(sessionId);
      }
    }

    // Perform SQLite deletions atomically for persisted sessions only
    if (persistedIds.length > 0) {
      this.db.raw.transaction(() => {
        for (const sessionId of persistedIds) {
          this.db.sessions.delete(sessionId);
        }
      })();
    }

    if (this.extensionManager) {
      for (const sessionId of sessionIds) {
        await this.extensionManager.onSessionDeleted({
          sessionId,
          session: sessionsById.get(sessionId) || null,
        });
      }
    }

    log('[SessionManager] Batch deleted sessions:', sessionIds.length);
  }

  // Update session status
  private updateSessionStatus(sessionId: string, status: Session['status']): void {
    const now = Date.now();
    const ephemeral = this.ephemeralSessions.get(sessionId);
    if (ephemeral) {
      ephemeral.status = status;
      ephemeral.updatedAt = now;
    } else {
      this.db.sessions.update(sessionId, { status, updated_at: now });
    }

    this.sendToRenderer({
      type: 'session.status',
      payload: { sessionId, status },
    });
  }

  private updateSessionTitle(sessionId: string, title: string): boolean {
    const ephemeral = this.ephemeralSessions.get(sessionId);
    if (ephemeral) {
      ephemeral.title = title;
      ephemeral.updatedAt = Date.now();
      this.sendToRenderer({
        type: 'session.update',
        payload: { sessionId, updates: { title } },
      });
      return true;
    }
    const existing = this.db.sessions.get(sessionId);
    if (!existing) {
      log('[SessionTitle] Skip title update for deleted session:', sessionId);
      return false;
    }
    this.db.sessions.update(sessionId, { title });
    this.sendToRenderer({
      type: 'session.update',
      payload: { sessionId, updates: { title } },
    });
    return true;
  }

  setSessionPinned(sessionId: string, pinned: boolean): boolean {
    if (this.ephemeralSessions.has(sessionId)) {
      log('[SessionManager] Skip pin update for incognito session:', sessionId);
      return false;
    }
    const existing = this.db.sessions.get(sessionId);
    if (!existing) {
      log('[SessionManager] Skip pin update for missing session:', sessionId);
      return false;
    }
    this.db.sessions.update(sessionId, { pinned: pinned ? 1 : 0 });
    this.sendToRenderer({
      type: 'session.update',
      payload: { sessionId, updates: { pinned } },
    });
    log('[SessionManager] Session pinned updated:', sessionId, '->', pinned);
    return true;
  }

  // Update session's working directory
  // Also clears SDK session cache because Claude SDK sessions are bound to cwd
  updateSessionCwd(sessionId: string, cwd: string): void {
    if (this.activeSessions.has(sessionId)) {
      logWarn(
        '[SessionManager] CWD change requested while session running; stopping active run first',
        { sessionId, cwd }
      );
      this.stopSession(sessionId);
    }
    const mountedPaths = this.buildMountedPaths(cwd);
    const ephemeral = this.ephemeralSessions.get(sessionId);
    if (ephemeral) {
      ephemeral.cwd = cwd;
      ephemeral.mountedPaths = mountedPaths;
      ephemeral.claudeSessionId = undefined;
      ephemeral.openaiThreadId = undefined;
      ephemeral.updatedAt = Date.now();
    } else {
      // Clear claude_session_id in DB so next query creates a new SDK session
      // (Claude SDK sessions cannot change cwd mid-session)
      this.db.sessions.update(sessionId, {
        cwd,
        mounted_paths: JSON.stringify(mountedPaths),
        claude_session_id: null,
        openai_thread_id: null,
        updated_at: Date.now(),
      });
    }

    // Also clear the in-memory SDK session cache
    if (this.agentRunner?.clearSdkSession) {
      this.agentRunner.clearSdkSession(sessionId);
    }

    this.sendToRenderer({
      type: 'session.update',
      payload: { sessionId, updates: { cwd, mountedPaths } },
    });

    log('[SessionManager] Session cwd updated:', sessionId, '->', cwd, '(SDK session cleared)');
  }

  clearAllCachedAgentSessions(): void {
    this.agentRunner?.clearAllSdkSessions?.();
  }

  /**
   * Manually trigger context compaction for a session.
   * Delegates to the agent runner's compact() method.
   */
  async compactSession(
    sessionId: string,
    customInstructions?: string
  ): Promise<{
    summary: string;
    firstKeptEntryId: string;
    tokensBefore: number;
    details?: unknown;
  } | null> {
    if (!this.agentRunner?.compact) {
      logWarn('[SessionManager] Agent runner does not support compact()');
      return null;
    }
    return this.agentRunner.compact(sessionId, customInstructions);
  }

  /**
   * Get current context usage for a session.
   * Delegates to the agent runner's getContextUsage() method.
   */
  getContextUsage(
    sessionId: string
  ): { tokens: number | null; contextWindow: number; percent: number | null } | null {
    if (!this.agentRunner?.getContextUsage) {
      return null;
    }
    return this.agentRunner.getContextUsage(sessionId);
  }

  // Save message to database (or in-memory cache only for incognito)
  saveMessage(message: Message): void {
    const isIncognito = this.ephemeralSessions.has(message.sessionId);
    if (!isIncognito) {
      this.db.messages.create({
        id: message.id,
        session_id: message.sessionId,
        role: message.role,
        content: JSON.stringify(message.content),
        timestamp: message.timestamp,
        token_usage: message.tokenUsage ? JSON.stringify(message.tokenUsage) : null,
        execution_time_ms: message.executionTimeMs ?? null,
      });
    }
    const cached = this.messageCache.get(message.sessionId);
    if (cached) {
      cached.push(message);
    } else {
      // Only evict when the cache could actually grow (i.e. the session is
      // not cached yet). Evicting on every saveMessage call is wrong because
      // the Map size didn't increase — we just appended to an existing array —
      // and the oldest entry could be the very session we just updated.
      if (this.messageCache.size > SessionManager.MAX_CACHE_SIZE) {
        const firstKey = this.messageCache.keys().next().value;
        if (firstKey) this.messageCache.delete(firstKey);
      }
      if (isIncognito) {
        this.messageCache.set(message.sessionId, [message]);
      } else {
        // Hydrate from DB instead of seeding with only this message. After cache
        // eviction, a lone seed would make getMessages() return truncated history
        // and history clicks look like the chat failed to load.
        const messages = this.readMessagesFromDb(message.sessionId);
        if (!messages.some((m) => m.id === message.id)) {
          messages.push(message);
        }
        this.messageCache.set(message.sessionId, messages);
      }
    }

    log('[SessionManager] Message saved:', message.id, 'role:', message.role);
  }

  /** Post a completed assistant message to a session (e.g. Live Assist answer). */
  publishAssistantText(sessionId: string, text: string): void {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    const message: Message = {
      id: uuidv4(),
      sessionId,
      role: 'assistant',
      content: [{ type: 'text', text: trimmed }],
      timestamp: Date.now(),
    };
    this.saveMessage(message);
    this.sendToRenderer({
      type: 'stream.message',
      payload: { sessionId, message },
    });
  }

  /** Post a live meeting transcript segment to a session (deduped by segmentId). */
  publishMeetingTranscript(
    sessionId: string,
    segment: { id: string; speaker?: string | null; text: string }
  ): boolean {
    const text = segment.text.trim();
    if (!text) {
      return false;
    }

    const messages = this.getMessages(sessionId);
    const alreadyPublished = messages.some((message) =>
      message.content.some(
        (block) =>
          block.type === 'meeting_transcript' &&
          (block as { segmentId?: string }).segmentId === segment.id
      )
    );
    if (alreadyPublished) {
      return false;
    }

    const message: Message = {
      id: uuidv4(),
      sessionId,
      role: 'user',
      content: [
        {
          type: 'meeting_transcript',
          segmentId: segment.id,
          speaker: segment.speaker ?? null,
          text,
        },
      ],
      timestamp: Date.now(),
    };
    this.saveMessage(message);
    this.sendToRenderer({
      type: 'stream.message',
      payload: { sessionId, message },
    });
    return true;
  }

  /** Publish a Live Assist activity card (returns message id). */
  publishLiveAssistActivity(
    sessionId: string,
    activity: {
      activityId: string;
      phase: LiveAssistActivityPhase;
      question: string;
      detail?: string;
      status: 'running' | 'completed' | 'failed';
    }
  ): string {
    const message: Message = {
      id: uuidv4(),
      sessionId,
      role: 'assistant',
      content: [
        {
          type: 'live_assist_activity',
          activityId: activity.activityId,
          phase: activity.phase,
          question: activity.question,
          detail: activity.detail,
          status: activity.status,
        },
      ],
      timestamp: Date.now(),
    };
    this.saveMessage(message);
    this.sendToRenderer({
      type: 'stream.message',
      payload: { sessionId, message },
    });
    return message.id;
  }

  /** Update a previously published message's content blocks. */
  updatePublishedMessage(sessionId: string, messageId: string, content: ContentBlock[]): void {
    const messages = this.getMessages(sessionId);
    const existing = messages.find((message) => message.id === messageId);
    if (!existing) {
      return;
    }

    const updated: Message = { ...existing, content };
    const isIncognito = this.ephemeralSessions.has(sessionId);
    if (!isIncognito) {
      this.db.messages.update(messageId, { content: JSON.stringify(content) });
    }

    const cached = this.messageCache.get(sessionId);
    if (cached) {
      const idx = cached.findIndex((message) => message.id === messageId);
      if (idx >= 0) {
        cached[idx] = updated;
      }
    }

    this.sendToRenderer({
      type: 'stream.messageUpdate',
      payload: { sessionId, message: updated },
    });
  }

  private readMessagesFromDb(sessionId: string): Message[] {
    const rows = this.db.messages.getBySessionId(sessionId);
    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      role: row.role as Message['role'],
      content: this.normalizeContent(row.content),
      timestamp: row.timestamp,
      tokenUsage: row.token_usage ? JSON.parse(row.token_usage) : undefined,
      executionTimeMs: row.execution_time_ms ?? undefined,
    }));
  }

  // Get messages for a session
  getMessages(sessionId: string): Message[] {
    const cached = this.messageCache.get(sessionId);
    if (cached) {
      return [...cached];
    }

    if (this.ephemeralSessions.has(sessionId)) {
      this.messageCache.set(sessionId, []);
      return [];
    }

    const messages = this.readMessagesFromDb(sessionId);
    this.messageCache.set(sessionId, messages);
    return [...messages];
  }

  private normalizeContent(raw: string): ContentBlock[] {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        return parsed as ContentBlock[];
      }
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        'type' in parsed &&
        typeof (parsed as { type: unknown }).type === 'string'
      ) {
        return [parsed as ContentBlock];
      }
      if (typeof parsed === 'string') {
        return [{ type: 'text', text: parsed } as TextContent];
      }
      return [{ type: 'text', text: String(parsed) } as TextContent];
    } catch {
      return [{ type: 'text', text: raw } as TextContent];
    }
  }

  getTraceSteps(sessionId: string): TraceStep[] {
    const rows = this.db.traceSteps.getBySessionId(sessionId);
    const parseToolInput = (value: string | null): Record<string, unknown> | undefined => {
      if (!value) return undefined;
      try {
        return JSON.parse(value) as Record<string, unknown>;
      } catch {
        return undefined;
      }
    };
    return rows.map((row) => ({
      id: row.id,
      type: row.type as TraceStep['type'],
      status: row.status as TraceStep['status'],
      title: row.title,
      content: row.content || undefined,
      toolName: row.tool_name || undefined,
      toolInput: parseToolInput(row.tool_input),
      toolOutput: row.tool_output || undefined,
      isError: row.is_error === 1 ? true : undefined,
      timestamp: row.timestamp,
      duration: row.duration ?? undefined,
    }));
  }

  // Handle permission response
  handlePermissionResponse(toolUseId: string, result: PermissionResult): void {
    const resolver = this.pendingPermissions.get(toolUseId);
    if (resolver) {
      resolver(result);
      this.pendingPermissions.delete(toolUseId);
    }
  }

  // Request permission for a tool
  async requestPermission(
    sessionId: string,
    toolUseId: string,
    toolName: string,
    input: Record<string, unknown>
  ): Promise<PermissionResult> {
    // Only one Allow dialog in flight at a time — queue subsequent asks behind it.
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const previous = this.permissionAskChain;
    this.permissionAskChain = previous.then(() => gate);
    await previous;

    try {
      return await new Promise<PermissionResult>((resolve) => {
        const timeoutId = setTimeout(() => {
          this.pendingPermissions.delete(toolUseId);
          resolve('deny');
          this.sendToRenderer({ type: 'permission.dismiss', payload: { toolUseId } });
        }, 60_000);
        this.pendingPermissions.set(toolUseId, (result: PermissionResult) => {
          clearTimeout(timeoutId);
          resolve(result);
        });
        this.sendToRenderer({
          type: 'permission.request',
          payload: { toolUseId, toolName, input, sessionId },
        });
      });
    } finally {
      releaseGate();
    }
  }

  // Request sudo password from the user
  async requestSudoPassword(
    sessionId: string,
    toolUseId: string,
    command: string
  ): Promise<string | null> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingSudoPasswords.delete(toolUseId);
        resolve(null);
        this.sendToRenderer({ type: 'sudo.password.dismiss', payload: { toolUseId } });
      }, 60_000);
      this.pendingSudoPasswords.set(toolUseId, {
        sessionId,
        resolve: (password: string | null) => {
          clearTimeout(timeout);
          resolve(password);
        },
      });
      this.sendToRenderer({
        type: 'sudo.password.request',
        payload: { toolUseId, command, sessionId },
      });
    });
  }

  // Handle sudo password response from renderer
  handleSudoPasswordResponse(toolUseId: string, password: string | null): void {
    const entry = this.pendingSudoPasswords.get(toolUseId);
    if (entry) {
      entry.resolve(password);
      this.pendingSudoPasswords.delete(toolUseId);
    }
  }

  private saveTraceStep(sessionId: string, step: TraceStep): void {
    if (this.ephemeralSessions.has(sessionId)) {
      return;
    }
    this.db.traceSteps.create({
      id: step.id,
      session_id: sessionId,
      type: step.type,
      status: step.status,
      title: step.title,
      content: step.content ?? null,
      tool_name: step.toolName ?? null,
      tool_input: step.toolInput ? JSON.stringify(step.toolInput) : null,
      tool_output: step.toolOutput ?? null,
      is_error: step.isError ? 1 : null,
      timestamp: step.timestamp,
      duration: step.duration ?? null,
    });
  }

  private updateTraceStep(stepId: string, updates: Partial<TraceStep>): void {
    // Trace steps for incognito sessions are never written; skip DB updates.
    // We don't have sessionId here — only update when the row exists.
    const rowUpdates: Partial<TraceStepRow> = {};
    if (updates.type !== undefined) rowUpdates.type = updates.type;
    if (updates.status !== undefined) rowUpdates.status = updates.status;
    if (updates.title !== undefined) rowUpdates.title = updates.title;
    if (updates.content !== undefined) rowUpdates.content = updates.content;
    if (updates.toolName !== undefined) rowUpdates.tool_name = updates.toolName;
    if (updates.toolInput !== undefined) {
      rowUpdates.tool_input = updates.toolInput ? JSON.stringify(updates.toolInput) : null;
    }
    if (updates.toolOutput !== undefined) rowUpdates.tool_output = updates.toolOutput;
    if (updates.isError !== undefined) rowUpdates.is_error = updates.isError ? 1 : 0;
    if (updates.timestamp !== undefined) rowUpdates.timestamp = updates.timestamp;
    if (updates.duration !== undefined) rowUpdates.duration = updates.duration;

    this.db.traceSteps.update(stepId, rowUpdates);
  }
}
