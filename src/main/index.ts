/**
 * @module main/index
 *
 * Electron main-process entry point (2181 lines).
 *
 * Responsibilities:
 * - App lifecycle: ready, activate, before-quit, window-will-close
 * - Central IPC hub: ~60 handlers namespaced as config.*, mcp.*, session.*,
 *   sandbox.*, logs.*, remote.*, schedule.*, etc.
 * - BrowserWindow creation and deep-link / protocol handling
 *
 * Dependencies: session-manager, config-store, mcp-manager, sandbox-adapter,
 *               skills-manager, scheduled-task-manager, nav-server, remote-manager
 */
import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  Menu,
  nativeTheme,
  Tray,
  nativeImage,
  desktopCapturer,
  session,
  Notification,
  systemPreferences,
} from 'electron';
import { join, resolve, dirname, isAbsolute, basename, extname } from 'path';
import * as fs from 'fs';
import { execFileSync } from 'child_process';
import { config } from 'dotenv';
import { initDatabase, closeDatabase } from './db/database';
import { SessionManager } from './session/session-manager';
import { SkillsManager } from './skills/skills-manager';
import { HubSkillsLibraryService } from './skills/hub-skills-library-service';
import {
  clearHubAllocationsCache,
  HubAllocationsError,
  listAllocatedProjects,
} from './hub/hub-allocations';
import { PluginCatalogService } from './skills/plugin-catalog-service';
import { PluginRuntimeService } from './skills/plugin-runtime-service';
import { MemoryService } from './memory/memory-service';
import { MemoryExtension } from './memory/memory-extension';
import { bindConnectorMemoryService } from './connectors/connector-memory';
import { connectorManager } from './connectors/connector-manager';
import { MeetingService } from './meetings/meeting-service';
import { MeetingExtension } from './meetings/meeting-extension';
import { ConfigExtension } from './config/config-extension';
import { SubagentExtension } from './agent/subagent-extension';
import { AgentRuntimeExtensionManager } from './extensions/agent-runtime-extension-manager';
import { WebFetchExtension } from './tools/web-fetch-extension';
import { AskUserQuestionExtension } from './tools/ask-user-question-extension';
import {
  configStore,
  getPiAiModelPresets,
  type AppConfig,
  type AppTheme,
  type CreateConfigSetPayload,
} from './config/config-store';
import {
  startConfigFileWatcher,
  stopConfigFileWatcher,
  exportOnConfigChange,
} from './config/config-file-watcher';
import { runConfigApiTest } from './config/config-test-routing';
import { listOllamaModels } from './config/ollama-api';
import { fetchBackendModels } from './config/backend-client';
import { setPermissionRules, decidePermission } from './config/permission-rules-store';
import {
  setMcpWriteAccessEnabled,
  setMcpWriteAccessServerSource,
} from './config/mcp-write-access-store';
import { mcpConfigStore } from './mcp/mcp-config-store';
import { buildWelcomeConnectorSnapshot } from './welcome/connector-snapshot';
import { getStaticFallbackChips, getWelcomeQuickActions } from './welcome/generate-welcome-actions';
import { resolveWelcomeProfile } from './welcome/resolve-welcome-profile';
import { DEFAULT_WELCOME_TAGLINE, buildConnectorFingerprint } from '../shared/welcome-actions';
import { getSandboxAdapter, shutdownSandbox } from './sandbox/sandbox-adapter';
import { SandboxSync } from './sandbox/sandbox-sync';
import { WSLBridge } from './sandbox/wsl-bridge';
import { LimaBridge } from './sandbox/lima-bridge';
import { getSandboxBootstrap } from './sandbox/sandbox-bootstrap';
import type { MCPServerConfig } from './mcp/mcp-manager';
import type {
  ClientEvent,
  ServerEvent,
  ApiTestInput,
  ApiTestResult,
  DiagnosticInput,
  ProviderModelInfo,
  PermissionRule,
} from '../renderer/types';
import { remoteManager, type AgentExecutor } from './remote/remote-manager';
import { remoteConfigStore } from './remote/remote-config-store';
import type { GatewayConfig, FeishuChannelConfig, ChannelType } from './remote/types';
import { startNavServer, stopNavServer } from './nav-server';
import {
  ScheduledTaskManager,
  type ScheduledTaskCreateInput,
  type ScheduledTaskUpdateInput,
} from './schedule/scheduled-task-manager';
import { createScheduledTaskStore } from './schedule/scheduled-task-store';
import { executeScheduledTask } from './schedule/execute-scheduled-task';
import {
  ChatLoopManager,
  extractAssistantText,
  type ChatLoopStartInput,
} from './loop/chat-loop-manager';
import { runPiAiOneShot } from './agent/sdk-one-shot';
import { installIpcAuthGuard } from './auth/ipc-auth-guard';
import { warmupJwksCache } from './auth/cognito';
import { submitViteOAuthCode, getOAuthDebugInfo, initHubOAuthRelay } from './auth/hub-oauth';
import { authConfig } from '../shared/auth-config';
import type { ConnectorId } from '../shared/ipc-types';
import {
  getAuthStatus,
  startGoogleLogin,
  getMe,
  logout as authLogout,
  refreshAuth,
  initAuth,
  setAuthRendererNotifier,
  stopAuthRefreshTimer,
  startAuthRefreshTimer,
  ensureAuthenticatedSession,
  AuthRequiredError,
  AUTH_REQUIRED_CODE,
  isAuthenticated,
  completeOAuthFromHubCode,
  getCurrentSession,
} from './auth/session';
import { resolveAvatarDataUrl } from './auth/avatar-proxy';
import {
  buildScheduledTaskFallbackTitle,
  buildScheduledTaskTitle,
} from '../shared/schedule/task-title';
import {
  isUncPath,
  isWindowsDrivePath,
  localPathFromAppUrlPathname,
  localPathFromFileUrl,
  decodePathSafely,
} from '../shared/local-file-path';
import { resolvePathAgainstWorkspace } from '../shared/workspace-path';
import { eventRequiresSessionManager } from './client-event-utils';
import { getUnsupportedWorkspacePathReason } from './workspace-path-constraints';
import {
  log,
  logWarn,
  logError,
  getLogFilePath,
  getLogsDirectory,
  getAllLogFiles,
  closeLogFile,
  setDevLogsEnabled,
  isDevLogsEnabled,
} from './utils/logger';
import { listRecentWorkspaceFiles } from './utils/recent-workspace-files';
import { buildDiagnosticsSummary } from './utils/diagnostics-summary';
import {
  parseHeadlessArgs,
  redirectConsoleToStderr,
  createHeadlessSendToRenderer,
  emitSessionStarted,
  emitSessionEnded,
  emitHeadlessReady,
  readStdinPrompt,
  startRpcLoop,
} from './cli/headless-io';

// Current working directory (persisted between sessions)
let currentWorkingDir: string | null = null;

// Dev → `.env`; production / packaged → staged `env.prod` / `.env.prod` (fallback `.env`)
// Note: electron-builder ignores `.env*` *source* files, so packaged builds ship `env.prod`.
function resolveDotenvPath(): string {
  const projectRoot = resolve(__dirname, '../..');
  const packagedCandidates = app.isPackaged
    ? [join(process.resourcesPath, 'env.prod'), join(process.resourcesPath, '.env.prod')]
    : [];
  const projectProdCandidates = [join(projectRoot, '.env.prod'), join(projectRoot, 'env.prod')];
  const projectDev = join(projectRoot, '.env');
  const preferProd = app.isPackaged || !process.env.VITE_DEV_SERVER_URL;

  if (preferProd) {
    for (const candidate of [...packagedCandidates, ...projectProdCandidates]) {
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return projectDev;
}

const envPath = resolveDotenvPath();
log('[dotenv] Loading from:', envPath);
const dotenvResult = config({ path: envPath });
if (dotenvResult.error) {
  logWarn('[dotenv] Failed to load env file:', dotenvResult.error.message);
} else {
  log('[dotenv] Loaded successfully');
}

installIpcAuthGuard();
initHubOAuthRelay();
log('[Auth] Hub OAuth redirect URL (Launchpad-compatible):', authConfig.hubOAuthRedirectUrl);
log('[Auth] Hub MCP URL:', authConfig.hubMcpUrl);
log('[Auth] Launchpad MCP URL:', authConfig.launchpadMcpUrl);
log('[Auth] R&D Pulse MCP URL:', authConfig.rndPulseMcpUrl);

// Apply saved config (this overrides .env if config exists)
if (configStore.isConfigured()) {
  log('[Config] Applying saved configuration...');
  configStore.applyToEnv();
}

// Disable hardware acceleration for better compatibility
app.disableHardwareAcceleration();

let mainWindow: BrowserWindow | null = null;
let sessionManager: SessionManager | null = null;
let skillsManager: SkillsManager | null = null;
let pluginRuntimeService: PluginRuntimeService | null = null;
let memoryService: MemoryService | null = null;
let meetingService: MeetingService | null = null;
let scheduledTaskManager: ScheduledTaskManager | null = null;
let chatLoopManager: ChatLoopManager | null = null;

/**
 * Tool names that a spawned subagent may never invoke, regardless of what
 * `decidePermission` returns. Subagents run non-interactively — there is no
 * user present to answer a permission prompt — so for tools whose whole
 * purpose is to require interactive approval (like `config_write`, which
 * mutates persisted app configuration), the only safe non-interactive
 * decision is `deny`. This intentionally overrides even an explicit
 * `'allow'` permission rule: config writes must always go through the
 * interactive dialog in the top-level session, never through a background
 * subagent.
 */
const SUBAGENT_ALWAYS_DENIED_TOOLS = new Set<string>(['config_write']);

/**
 * Resolve the allow/deny decision for a tool call made by a spawned
 * subagent. Delegates to the shared `decidePermission` rules cache, but
 * hard-denies tools in `SUBAGENT_ALWAYS_DENIED_TOOLS` first — see that
 * constant's docstring for why.
 */
function resolveSubagentToolPermission(
  toolName: string,
  toolInput: Record<string, unknown>
): 'allow' | 'deny' {
  if (SUBAGENT_ALWAYS_DENIED_TOOLS.has(toolName)) {
    return 'deny';
  }
  const decision = decidePermission('subagent', toolName, toolInput);
  return decision === 'deny' ? 'deny' : 'allow';
}

function sanitizeDiagnosticBaseUrl(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = new URL(value);
    const pathname = parsed.pathname === '/' ? '' : parsed.pathname;
    return `${parsed.origin}${pathname}`;
  } catch {
    return value.replace(/[?#].*$/, '');
  }
}

async function verifyGeminiRuntimeForSmokeTest(): Promise<void> {
  const { completeSimple, getModel } = await import('@mariozechner/pi-ai');
  const model = getModel('google', 'gemini-2.5-flash');
  if (!model) {
    throw new Error('Gemini smoke-test model is missing from the pi-ai registry');
  }

  // Abort before dispatch so this loads the packaged Gemini provider and SDK
  // without sending a network request or requiring a real API key.
  const controller = new AbortController();
  controller.abort();
  const result = await completeSimple(
    model,
    {
      systemPrompt: 'smoke',
      messages: [{ role: 'user', content: 'smoke', timestamp: Date.now() }],
    },
    { apiKey: 'smoke-test-key', signal: controller.signal }
  );

  if (result.stopReason !== 'aborted') {
    throw new Error(`Gemini provider smoke test returned ${result.stopReason}`);
  }
}

async function resolveScheduledTaskTitle(
  prompt: string,
  _cwd?: string,
  fallbackTitle?: string
): Promise<string> {
  const normalizedPrompt = prompt.trim();
  const fallback = fallbackTitle
    ? buildScheduledTaskTitle(fallbackTitle)
    : buildScheduledTaskFallbackTitle(normalizedPrompt);
  if (!sessionManager) {
    return fallback;
  }
  try {
    return await sessionManager.generateScheduledTaskTitle(normalizedPrompt);
  } catch (error) {
    logWarn('[Schedule] Failed to generate title via session title flow, using fallback', error);
    return fallback;
  }
}

async function waitForDevServer(url: string, maxAttempts = 30, intervalMs = 500): Promise<boolean> {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(url, { method: 'GET' });
      if (response.ok) {
        if (attempt > 1) {
          log(`[App] Dev server ready after ${attempt} attempt(s): ${url}`);
        }
        return true;
      }
    } catch {
      // Ignore and retry until timeout
    }

    if (attempt < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  logWarn(`[App] Dev server did not become ready within timeout: ${url}`);
  return false;
}

// Single-instance lock: skip in dev mode so vite-plugin-electron can restart freely
// without the old process blocking the new one during async cleanup.
const isDev = !!process.env.VITE_DEV_SERVER_URL;
const ELECTRON_DEVTOOLS_DEBUG_PORT = '9223';
const PRODUCT_NAME = 'York WorkOS';

function resolveResourcePath(...parts: string[]): string {
  return app.isPackaged
    ? join(process.resourcesPath, ...parts)
    : join(__dirname, '../../resources', ...parts);
}

/** Menu name + Dock icon (critical in `npm run dev`, where Electron.app is the host). */
function applyAppBranding() {
  app.setName(PRODUCT_NAME);

  if (process.platform === 'darwin' && app.dock) {
    const dockIconPath = resolveResourcePath('icon.png');
    if (fs.existsSync(dockIconPath)) {
      const image = nativeImage.createFromPath(dockIconPath);
      if (!image.isEmpty()) {
        app.dock.setIcon(image);
      }
    }
  }
}

applyAppBranding();

// Chromium's macOS Media Session / Now Playing path queries MediaPlayer and can
// trigger an Apple Music / media-library TCC prompt even though this app never
// uses that API. Disable before ready so Chromium never touches it.
if (process.platform === 'darwin') {
  const existing = app.commandLine.getSwitchValue('disable-features');
  const required = ['MediaSessionService', 'HardwareMediaKeyHandling'];
  const merged = [
    ...new Set(
      [...(existing ? existing.split(',') : []), ...required]
        .map((feature) => feature.trim())
        .filter(Boolean)
    ),
  ].join(',');
  app.commandLine.appendSwitch('disable-features', merged);
}

// Enable Chrome DevTools Protocol in dev mode so the renderer can be inspected
// via chrome://inspect or connected to by Puppeteer/Playwright at localhost:9223.
// Chrome MCP uses 9222, so keep Electron on a separate port in development.
if (isDev) {
  app.commandLine.appendSwitch('remote-debugging-port', ELECTRON_DEVTOOLS_DEBUG_PORT);
  app.commandLine.appendSwitch(
    'remote-allow-origins',
    `http://localhost:${ELECTRON_DEVTOOLS_DEBUG_PORT}`
  );
}

const hasSingleInstanceLock = isDev || app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  logWarn('[App] Another instance is already running, quitting this instance');
  app.quit();
} else if (!isDev) {
  app.on('second-instance', () => {
    const existingWindow =
      mainWindow && !mainWindow.isDestroyed()
        ? mainWindow
        : BrowserWindow.getAllWindows().find((window) => !window.isDestroyed());

    if (!existingWindow) {
      log('[App] No existing window found, creating new one');
      createWindow();
      return;
    }

    if (!mainWindow || mainWindow.isDestroyed()) {
      mainWindow = existingWindow;
    }
    if (existingWindow.isMinimized()) {
      existingWindow.restore();
    }
    existingWindow.show();
    existingWindow.focus();
    log('[App] Blocked second instance and focused existing window');
  });
}

// Tray instance (kept alive to prevent GC)
let tray: Tray | null = null;
const DARK_BG = '#171614';
const LIGHT_BG = '#f5f3ee';

function buildMacMenu() {
  if (process.platform !== 'darwin') return;

  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: 'Preferences…',
          accelerator: 'CmdOrCtrl+,',
          click: () =>
            mainWindow?.webContents.send('server-event', { type: 'navigate', payload: 'settings' }),
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'togglefullscreen' },
        { type: 'separator' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { role: 'resetZoom' },
      ],
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'close' }, { type: 'separator' }, { role: 'front' }],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function setupTray() {
  if (tray) return;

  // Use .ico on Windows for proper multi-resolution tray support; fall back to .png if absent
  const iconName =
    process.platform === 'darwin'
      ? 'tray-iconTemplate.png'
      : process.platform === 'win32'
        ? 'tray-icon.ico'
        : 'tray-icon.png';
  // TODO: create resources/tray-icon.ico from tray-icon.png for full Windows tray fidelity
  const iconPath = resolveResourcePath(iconName);

  // On Windows, fall back to .png if the .ico file has not been created yet
  const resolvedIconPath =
    process.platform === 'win32' && !fs.existsSync(iconPath)
      ? resolveResourcePath('tray-icon.png')
      : iconPath;

  // Gracefully skip tray if icon is missing (e.g. dev environment)
  if (!fs.existsSync(resolvedIconPath)) {
    log('[Tray] Icon not found at', resolvedIconPath, '— skipping tray setup');
    return;
  }

  // macOS menu bar expects ~16pt. A bare 32×32 PNG is shown at 32pt (too large).
  // Prefer the @2x asset (32px with scaleFactor 2 → 16pt) so retina stays sharp.
  let trayImage: Electron.NativeImage;
  if (process.platform === 'darwin') {
    const retinaPath = resolveResourcePath('tray-iconTemplate@2x.png');
    const imagePath = fs.existsSync(retinaPath) ? retinaPath : resolvedIconPath;
    trayImage = nativeImage.createFromPath(imagePath);
    if (trayImage.isEmpty()) {
      log('[Tray] Failed to load icon at', imagePath, '— skipping tray setup');
      return;
    }
    // Filename @2x sets scaleFactor to 2. If loading a plain oversized PNG, force 16pt.
    const scaleFactors = trayImage.getScaleFactors();
    const dipSize = trayImage.getSize();
    if (!scaleFactors.includes(2) && (dipSize.width > 18 || dipSize.height > 18)) {
      trayImage = nativeImage.createFromBuffer(trayImage.toPNG(), { scaleFactor: 2 });
    }
    trayImage.setTemplateImage(true);
  } else {
    trayImage = nativeImage.createFromPath(resolvedIconPath);
    if (trayImage.isEmpty()) {
      log('[Tray] Failed to load icon at', resolvedIconPath, '— skipping tray setup');
      return;
    }
  }

  tray = new Tray(trayImage);
  tray.setToolTip(PRODUCT_NAME);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show / Hide Window',
      click: () => {
        if (!mainWindow || mainWindow.isDestroyed()) {
          createWindow();
        } else if (mainWindow.isVisible()) {
          mainWindow.hide();
        } else {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    {
      label: 'New Session',
      click: () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.show();
          mainWindow.focus();
          mainWindow.webContents.send('server-event', { type: 'new-session' });
        }
      },
    },
    {
      label: 'Settings',
      click: () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.show();
          mainWindow.focus();
          mainWindow.webContents.send('server-event', { type: 'navigate', payload: 'settings' });
        }
      },
    },
    { type: 'separator' },
    { label: 'Quit', role: 'quit' },
  ]);
  tray.setContextMenu(contextMenu);

  tray.on('click', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      createWindow();
    } else if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

function getSavedThemePreference(): AppTheme {
  const theme = configStore.get('theme');
  return theme === 'dark' || theme === 'system' ? theme : 'light';
}

function resolveEffectiveTheme(theme: AppTheme): 'dark' | 'light' {
  if (theme === 'system') {
    return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  }
  return theme;
}

function applyNativeThemePreference(theme: AppTheme): void {
  nativeTheme.themeSource = theme;
}

function setupMeetingMediaCapture(): void {
  try {
    // Meeting capture needs mic (getUserMedia) + speaker/system loopback.
    // getDisplayMedia always requests video; when Screen Recording is unavailable we
    // satisfy that with this window's frame (not a screen share) and still grant loopback.
    session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
      let streams: {
        video?: Electron.DesktopCapturerSource | Electron.WebFrameMain;
        audio?: 'loopback';
      } = {};

      const screenStatus =
        process.platform === 'darwin' || process.platform === 'win32'
          ? systemPreferences.getMediaAccessStatus('screen')
          : 'unknown';

      // Avoid calling getSources when denied — it rejects and can surface unhandled rejections.
      if (screenStatus === 'granted') {
        const sources = await desktopCapturer
          .getSources({
            types: ['screen'],
            thumbnailSize: { width: 1, height: 1 },
          })
          .catch((error: unknown) => {
            log('[Meetings] Screen sources unavailable for loopback setup', error);
            return [] as Electron.DesktopCapturerSource[];
          });
        if (sources[0]) {
          streams = { video: sources[0], audio: 'loopback' };
        }
      }

      if (!streams.video) {
        const frame =
          mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents.mainFrame : null;
        if (frame) {
          streams = { video: frame, audio: 'loopback' };
          log('[Meetings] Granting app-frame video + system loopback audio');
        } else {
          logWarn('[Meetings] No video source available for display-media grant');
        }
      }

      try {
        callback(streams);
      } catch (error) {
        logWarn('[Meetings] Display media grant rejected', error);
      }
    });
  } catch (error) {
    logWarn('[Meetings] Failed to register display media handler', error);
  }
}

/** Queued when auto-start fires before the renderer is ready to receive IPC. */
let pendingMeetingsAutoStartIpc = false;
let pendingMeetingsAutoStartNotify = false;

function flushPendingMeetingsAutoStart(): void {
  if (!pendingMeetingsAutoStartIpc) return;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.webContents.isLoading()) return;
  pendingMeetingsAutoStartIpc = false;
  const showNotify = pendingMeetingsAutoStartNotify;
  pendingMeetingsAutoStartNotify = false;
  log('[Meetings] Flushing queued auto-start request to renderer');
  sendMeetingsAutoStartToRenderer(showNotify);
}

function sendMeetingsAutoStartToRenderer(showOsNotification: boolean): void {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isLoading()) {
    pendingMeetingsAutoStartIpc = true;
    pendingMeetingsAutoStartNotify = pendingMeetingsAutoStartNotify || showOsNotification;
    log('[Meetings] Renderer not ready — queuing auto-start IPC');
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.send('meetings:requestAutoStart');
  if (showOsNotification) {
    showMeetingOsNotification({
      title: 'Live capture in progress',
      body: 'York is capturing this Zoom call. Notes will save to History when it ends.',
    });
  }
}

function wireMeetingServiceEvents(service: MeetingService): void {
  service.onStatus((status) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('meetings:status', status);
    }
  });
  service.onSegment((payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('meetings:segment', payload);
    }
  });
  service.onNotesReady((meeting) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('meetings:notesReady', meeting);
    }
  });
  service.onMeetingDetected((payload) => {
    log(`[Meetings] Broadcasting detection to renderer: ${payload.newlyDetected.join(', ')}`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('meetings:detected', payload);
    }
  });
  service.onAutoStartRequested((options) => {
    log('[Meetings] Broadcasting auto-start request to renderer');
    sendMeetingsAutoStartToRenderer(Boolean(options?.showOsNotification));
  });
  service.onAutoStopRequested(() => {
    log('[Meetings] Broadcasting auto-stop request to renderer');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('meetings:requestAutoStop');
    }
    showMeetingOsNotification({
      title: 'Saving meeting notes',
      body: 'Call ended — generating notes for History…',
    });
  });
  service.syncDetectionPolling();
}

/** Keep refs so Chromium does not GC notifications before they appear. */
const retainedMeetingNotifications = new Set<Notification>();

function showMeetingOsNotification(options: { title: string; body: string }): void {
  log(`[Meetings] Showing OS notification: ${options.title}`);
  if (!Notification.isSupported()) {
    logWarn('[Meetings] Electron Notification API is not supported on this platform');
    return;
  }
  try {
    const notification = new Notification({
      title: options.title,
      body: options.body,
      silent: false,
      timeoutType: 'default',
      urgency: 'normal',
    });
    retainedMeetingNotifications.add(notification);
    notification.on('click', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isMinimized()) {
          mainWindow.restore();
        }
        mainWindow.show();
        mainWindow.focus();
        mainWindow.webContents.send('meetings:openSettings');
      }
    });
    notification.on('failed', (event, error) => {
      logWarn(
        '[Meetings] OS notification failed — on macOS Electron 41+ requires a valid code signature ' +
          '(dev: npm run brand:electron re-signs the host) and Notification Center permission for this app',
        error || event
      );
      retainedMeetingNotifications.delete(notification);
    });
    notification.on('close', () => {
      retainedMeetingNotifications.delete(notification);
    });
    notification.on('show', () => {
      log('[Meetings] OS notification shown');
    });
    notification.show();
  } catch (error) {
    logWarn('[Meetings] Failed to show OS notification', error);
  }
}

function createWindow() {
  const savedTheme = getSavedThemePreference();
  applyNativeThemePreference(savedTheme);
  const effectiveTheme = resolveEffectiveTheme(savedTheme);
  const THEME =
    effectiveTheme === 'dark'
      ? {
          background: DARK_BG,
          titleBar: DARK_BG,
          titleBarSymbol: '#f1ece4',
        }
      : {
          background: LIGHT_BG,
          titleBar: LIGHT_BG,
          titleBarSymbol: '#1a1a1a',
        };

  // Platform-specific window configuration
  const isMac = process.platform === 'darwin';
  const isWindows = process.platform === 'win32';

  // Base window options
  const windowOptions: Electron.BrowserWindowConstructorOptions = {
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: THEME.background,
    icon: (() => {
      const windowIconName = isMac ? 'icon.icns' : isWindows ? 'icon.ico' : 'icon.png';
      return resolveResourcePath(windowIconName);
    })(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  };

  if (isMac) {
    // macOS: Use hiddenInset for native traffic light buttons
    windowOptions.titleBarStyle = 'hiddenInset';
    windowOptions.trafficLightPosition = { x: 16, y: 12 };
  } else if (isWindows) {
    // Windows: Use frameless window with custom titlebar
    // Note: frame: false removes native frame, allowing custom titlebar
    windowOptions.frame = false;
  } else {
    // Linux: Use frameless window
    windowOptions.frame = false;
  }

  mainWindow = new BrowserWindow(windowOptions);
  mainWindow.setTitle(PRODUCT_NAME);

  const allowedOrigins = new Set<string>();
  if (process.env.VITE_DEV_SERVER_URL) {
    try {
      allowedOrigins.add(new URL(process.env.VITE_DEV_SERVER_URL).origin);
    } catch {
      // Ignore invalid dev server URLs
    }
  }
  const allowedProtocols = new Set<string>(['file:', 'devtools:']);

  const isExternalUrl = (url: string) => {
    try {
      const parsed = new URL(url);
      if (allowedProtocols.has(parsed.protocol)) {
        return false;
      }
      if (allowedOrigins.has(parsed.origin)) {
        return false;
      }
      return true;
    } catch {
      return true;
    }
  };

  const extractLocalPathFromNavigationUrl = (url: string): string | null => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'file:') {
        return localPathFromFileUrl(url);
      }
      if (!allowedOrigins.has(parsed.origin)) {
        return null;
      }
      return localPathFromAppUrlPathname(parsed.pathname || '');
    } catch {
      return null;
    }
  };

  async function revealNavigationTarget(url: string): Promise<boolean> {
    const localPath = extractLocalPathFromNavigationUrl(url);
    if (!localPath) {
      return false;
    }
    return revealFileInFolder(localPath);
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const localPath = extractLocalPathFromNavigationUrl(url);
    if (localPath) {
      void revealNavigationTarget(url);
      return { action: 'deny' };
    }
    if (isExternalUrl(url)) {
      void shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const localPath = extractLocalPathFromNavigationUrl(url);
    if (localPath) {
      event.preventDefault();
      void revealNavigationTarget(url);
      return;
    }
    if (isExternalUrl(url)) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });

  // Load the app
  if (process.env.VITE_DEV_SERVER_URL) {
    const devServerUrl = process.env.VITE_DEV_SERVER_URL;
    void (async () => {
      await waitForDevServer(devServerUrl, 40, 500);
      if (!mainWindow || mainWindow.isDestroyed()) return;

      try {
        await mainWindow.loadURL(devServerUrl);
      } catch (error) {
        logError('[App] Failed to load dev server URL:', error);
      }
    })();
    // mainWindow.webContents.openDevTools(); // Commented out - open manually with Cmd+Option+I if needed
  } else {
    mainWindow.loadFile(join(__dirname, '../../dist/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Notify renderer about config status after window is ready
  mainWindow.webContents.on('did-finish-load', () => {
    const isConfigured = configStore.isConfigured();
    log('[Config] Notifying renderer, isConfigured:', isConfigured);
    sendToRenderer({
      type: 'config.status',
      payload: {
        isConfigured,
        config: configStore.getAll(),
      },
    });

    // Send current working directory to renderer
    sendToRenderer({
      type: 'workdir.changed',
      payload: { path: currentWorkingDir || '' },
    });

    // Start sandbox bootstrap after window is loaded
    startSandboxBootstrap();

    // Late-open Zoom: deliver auto-start that fired before the renderer was ready.
    flushPendingMeetingsAutoStart();
  });
}

/**
 * Initialize default working directory
 * This is always the app's default_working_dir in userData - it never changes
 * Each session can have its own cwd that differs from this default
 */
function initializeDefaultWorkingDir(): string {
  // Create default working directory in user data path (this is the permanent global default)
  const userDataPath = app.getPath('userData');
  const defaultDir = join(userDataPath, 'default_working_dir');

  if (!fs.existsSync(defaultDir)) {
    fs.mkdirSync(defaultDir, { recursive: true });
    log('[App] Created default working directory:', defaultDir);
  }

  currentWorkingDir = defaultDir;

  log('[App] Global default working directory:', currentWorkingDir);
  return currentWorkingDir;
}

/**
 * Get current working directory
 */
function getWorkingDir(): string | null {
  return currentWorkingDir;
}

function getWorkspacePathUnsupportedReason(workspacePath?: string): string | null {
  return getUnsupportedWorkspacePathReason({
    platform: process.platform,
    sandboxEnabled: configStore.get('sandboxEnabled') !== false,
    workspacePath,
  });
}

/**
 * Set working directory
 * - If sessionId is provided: update only that session's cwd (for switching directories within a chat)
 * - If no sessionId: update UI display only (for WelcomeView - will be used when creating new session)
 *
 * Note: The global default (currentWorkingDir) is NEVER changed after initialization.
 * It is always app.getPath('userData')/default_working_dir
 */
async function setWorkingDir(
  newDir: string,
  sessionId?: string
): Promise<{ success: boolean; path: string; error?: string }> {
  const unsupportedReason = getWorkspacePathUnsupportedReason(newDir);
  if (unsupportedReason) {
    return { success: false, path: newDir, error: unsupportedReason };
  }

  if (!fs.existsSync(newDir)) {
    return { success: false, path: newDir, error: 'Directory does not exist' };
  }

  if (sessionId && sessionManager) {
    // Update only this session's cwd - don't change the global default
    log('[App] Updating session cwd:', sessionId, '->', newDir);
    sessionManager.updateSessionCwd(sessionId, newDir);

    // Clear this session's sandbox mapping so next query uses the new directory
    SandboxSync.clearSession(sessionId);
    const { LimaSync } = await import('./sandbox/lima-sync');
    LimaSync.clearSession(sessionId);
  }

  // Notify renderer of workdir change (for UI display)
  // This updates what the user sees, and will be passed to startSession for new sessions
  sendToRenderer({
    type: 'workdir.changed',
    payload: { path: newDir },
  });

  log(
    '[App] Working directory for UI updated:',
    newDir,
    sessionId ? `(session: ${sessionId})` : '(pending new session)'
  );

  return { success: true, path: newDir };
}

/**
 * Start sandbox bootstrap in the background
 * This pre-initializes WSL/Lima environment at app startup
 */
async function startSandboxBootstrap(): Promise<void> {
  // Skip sandbox bootstrap if disabled - use native mode directly
  const sandboxEnabled = configStore.get('sandboxEnabled');
  if (sandboxEnabled === false) {
    log('[App] Sandbox disabled, skipping bootstrap (using native mode)');
    return;
  }

  const bootstrap = getSandboxBootstrap();

  // Skip if already complete
  if (bootstrap.isComplete()) {
    log('[App] Sandbox bootstrap already complete');
    return;
  }

  // Set up progress callback to notify renderer
  bootstrap.setProgressCallback((progress) => {
    sendToRenderer({
      type: 'sandbox.progress',
      payload: progress,
    });
  });

  // Start bootstrap (non-blocking)
  log('[App] Starting sandbox bootstrap...');
  try {
    const result = await bootstrap.bootstrap();
    log('[App] Sandbox bootstrap complete:', result.mode);
  } catch (error) {
    logError('[App] Sandbox bootstrap error:', error);
  }
}

// Pluggable event sender — defaults to mainWindow IPC, swapped for JSONL in headless mode
let eventSender: ((event: ServerEvent) => void) | null = null;

// Send events to the renderer (including remote session interception)
function sendToRenderer(event: ServerEvent) {
  const payload =
    'payload' in event
      ? (event.payload as { sessionId?: string; [key: string]: unknown })
      : undefined;
  const sessionId = payload?.sessionId;

  // Check whether this is a remote session
  if (sessionId && remoteManager.isRemoteSession(sessionId)) {
    // Handle remote session events

    // Intercept stream.message for relay back to the remote channel
    if (event.type === 'stream.message') {
      const message = payload.message as {
        role?: string;
        content?: Array<{ type: string; text?: string }>;
      };
      if (message?.role === 'assistant' && message?.content) {
        // Extract assistant text content
        const textContent = message.content
          .filter((c) => c.type === 'text' && c.text)
          .map((c) => c.text)
          .join('\n');

        if (textContent) {
          // Send to remote channel (with buffering)
          remoteManager.sendResponseToChannel(sessionId, textContent).catch((err: Error) => {
            logError('[Remote] Failed to send response to channel:', err);
          });
        }
      }
    }

    // Intercept trace.step as tool progress
    if (event.type === 'trace.step') {
      const step = payload.step as {
        type?: string;
        toolName?: string;
        status?: string;
        title?: string;
      };
      if (step?.type === 'tool_call' && step?.toolName) {
        remoteManager
          .sendToolProgress(
            sessionId,
            step.toolName,
            step.status === 'completed'
              ? 'completed'
              : step.status === 'error'
                ? 'error'
                : 'running'
          )
          .catch((err: Error) => {
            logError('[Remote] Failed to send tool progress:', err);
          });
      }
    }

    // trace.update reserved; currently mainly use trace.step

    // Intercept session.status for cleanup
    if (event.type === 'session.status') {
      const status = payload.status as string;
      if (status === 'idle' || status === 'error') {
        // Session ended; clear buffer
        remoteManager.clearSessionBuffer(sessionId).catch((err: Error) => {
          logError('[Remote] Failed to clear session buffer:', err);
        });
      }
    }

    // Intercept permission.request
    if (event.type === 'permission.request' && payload.toolUseId && payload.toolName) {
      log('[Remote] Intercepting permission for remote session:', sessionId);
      remoteManager
        .handlePermissionRequest(
          sessionId,
          payload.toolUseId as string,
          payload.toolName as string,
          (payload.input as Record<string, unknown> | undefined) ?? {}
        )
        .then((result) => {
          if (result !== null && sessionManager) {
            let permissionResult: 'allow' | 'deny' | 'allow_always';
            if (result.allow) {
              permissionResult = result.remember ? 'allow_always' : 'allow';
            } else {
              permissionResult = 'deny';
            }
            sessionManager.handlePermissionResponse(payload.toolUseId as string, permissionResult);
          }
        })
        .catch((err) => {
          logError('[Remote] Failed to handle permission request:', err);
        });
      return; // Do not send to local UI
    }

    // Intercept question.request — always resolve so the agent cannot hang
    if (event.type === 'question.request' && payload.questionId && payload.questions) {
      log('[Remote] Intercepting question for remote session:', sessionId);
      remoteManager
        .handleQuestionRequest(
          sessionId,
          payload.questionId as string,
          payload.questions as Array<{
            question: string;
            header?: string;
            options?: Array<{ label: string; description?: string; recommended?: boolean }>;
            multiSelect?: boolean;
          }>
        )
        .then((answer) => {
          if (!sessionManager) {
            return;
          }
          if (answer !== null) {
            sessionManager.handleQuestionResponse(payload.questionId as string, answer);
          } else {
            // Gateway send failed / not a remote session path that returned null
            sessionManager.cancelQuestion(
              payload.questionId as string,
              'remote question delivery failed'
            );
          }
        })
        .catch((err) => {
          logError('[Remote] Failed to handle question request:', err);
          sessionManager?.cancelQuestion(
            payload.questionId as string,
            'remote question handler error'
          );
        });
      return; // Do not send to local UI
    }
  }

  // Send to local UI (or headless JSONL sender)
  if (eventSender) {
    eventSender(event);
  } else if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('server-event', event);
  }
}

// Initialize app
app
  .whenReady()
  .then(async () => {
    // Re-apply after ready so Dock picks up icon/name reliably on macOS.
    applyAppBranding();

    // Smoke test mode: verify the app can start, then exit cleanly
    if (process.argv.includes('--smoke-test')) {
      log('[SmokeTest] App launched successfully in smoke test mode');
      log('[SmokeTest] Platform:', process.platform, 'Arch:', process.arch);
      log('[SmokeTest] Electron:', process.versions.electron, 'Node:', process.versions.node);
      try {
        // Verify critical native modules load
        require('better-sqlite3');
        log('[SmokeTest] better-sqlite3: OK');
      } catch (e) {
        log('[SmokeTest] FAIL: better-sqlite3 failed to load:', e);
        process.exit(1);
      }
      try {
        await verifyGeminiRuntimeForSmokeTest();
        log('[SmokeTest] Gemini provider runtime: OK');
      } catch (e) {
        log('[SmokeTest] FAIL: Gemini provider runtime failed to load:', e);
        process.exit(1);
      }
      log('[SmokeTest] PASSED');
      process.exit(0);
    }

    // ── Headless mode ──────────────────────────────────────────────────
    const headlessArgs = parseHeadlessArgs();

    if (headlessArgs.headless) {
      // Redirect console.log/warn to stderr so stdout stays clean JSONL
      redirectConsoleToStderr();

      log('[Headless] Starting in headless mode');
      log('[Headless] Args:', JSON.stringify(headlessArgs));

      if (headlessArgs.autoApprove) {
        process.stderr.write(
          '\n⚠️  WARNING: --auto-approve is active. ALL tool calls (file writes, shell commands, network) will be approved without confirmation.\n\n'
        );
      }

      // Validate --cwd before proceeding
      const cwdUnsupported = getWorkspacePathUnsupportedReason(headlessArgs.cwd);
      if (cwdUnsupported) {
        process.stderr.write(`Error: --cwd path is invalid: ${cwdUnsupported}\n`);
        process.exit(1);
        return;
      }
      const fs = await import('fs');
      if (!fs.existsSync(headlessArgs.cwd)) {
        process.stderr.write(`Error: --cwd path does not exist: ${headlessArgs.cwd}\n`);
        process.exit(1);
        return;
      }

      // Apply dev logs setting
      setDevLogsEnabled(configStore.get('enableDevLogs'));
      setMcpWriteAccessServerSource(() => mcpConfigStore.getServers());
      setMcpWriteAccessEnabled(configStore.get('mcpWriteAccessEnabled') !== false);

      // Start config file watcher for bidirectional sync
      startConfigFileWatcher();
      const db = initDatabase();

      pluginRuntimeService = new PluginRuntimeService(new PluginCatalogService());
      memoryService = new MemoryService(db);
      meetingService = new MeetingService();
      meetingService.setMemoryService(memoryService);

      // Build the JSONL sender with permission/question interception BEFORE constructing SessionManager
      const headlessSendToRenderer = createHeadlessSendToRenderer();
      // Mutable interceptor: set in stdio mode to route events to StdioChannel
      let stdioEventInterceptor: ((event: ServerEvent) => void) | null = null;
      const headlessSendWithPermission = (event: ServerEvent) => {
        if (event.type === 'permission.request') {
          const { toolUseId } = event.payload;
          const result = headlessArgs.autoApprove ? 'allow' : 'deny';
          log(
            `[Headless] Permission ${result} for ${event.payload.toolName} (auto-approve=${headlessArgs.autoApprove})`
          );
          setTimeout(() => {
            sessionManager?.handlePermissionResponse(toolUseId, result);
          }, 0);
        }
        if (event.type === 'question.request') {
          const { questionId } = event.payload;
          // Headless has no interactive UI — auto-cancel so the agent can proceed with assumptions
          log(`[Headless] AskUserQuestion auto-cancelled for ${questionId}`);
          setTimeout(() => {
            sessionManager?.cancelQuestion(questionId, 'headless mode has no UI');
          }, 0);
        }
        if (event.type === 'sudo.password.request') {
          const { toolUseId } = event.payload;
          log('[Headless] Sudo password request denied (headless mode)');
          setTimeout(() => {
            sessionManager?.handleSudoPasswordResponse(toolUseId, null);
          }, 0);
        }
        // Route to stdio channel if interceptor is set (must come before headlessSendToRenderer
        // because headlessSendToRenderer writes JSONL to stdout which conflicts with stdio events)
        if (stdioEventInterceptor) {
          stdioEventInterceptor(event);
          return;
        }
        headlessSendToRenderer(event);
      };

      const headlessAskUserQuestionExtension = new AskUserQuestionExtension(
        headlessSendWithPermission
      );
      const headlessExtensionManager = new AgentRuntimeExtensionManager([
        new MemoryExtension(memoryService),
        new MeetingExtension(meetingService),
        new ConfigExtension(configStore),
        new WebFetchExtension(),
        headlessAskUserQuestionExtension,
        new SubagentExtension(
          () => sessionManager?.getMCPManager() ?? null,
          sendToRenderer,
          async (toolName, toolInput) =>
            resolveSubagentToolPermission(toolName, toolInput as Record<string, unknown>)
        ),
      ]);

      // Set the global event sender so handleClientEvent's sendToRenderer calls
      // go through JSONL instead of the null mainWindow
      eventSender = headlessSendWithPermission;

      sessionManager = new SessionManager(
        db,
        headlessSendWithPermission,
        pluginRuntimeService,
        headlessExtensionManager,
        headlessAskUserQuestionExtension
      );
      sessionManager.setMeetingService(meetingService);

      skillsManager = new SkillsManager(db, {
        getConfiguredGlobalSkillsPath: () => configStore.get('globalSkillsPath') || '',
        setConfiguredGlobalSkillsPath: (nextPath: string) => {
          configStore.update({ globalSkillsPath: nextPath });
        },
        watchStorage: false, // No renderer to notify in headless mode
      });

      // Set working directory from --cwd flag
      currentWorkingDir = headlessArgs.cwd;
      log('[Headless] Working directory:', currentWorkingDir);

      // Initialize scheduled task manager (runs in background)
      const headlessScheduledTaskStore = createScheduledTaskStore(db);
      scheduledTaskManager = new ScheduledTaskManager({
        store: headlessScheduledTaskStore,
        executeTask: async (task) => {
          if (!sessionManager) {
            throw new Error('Session manager not initialized');
          }
          return executeScheduledTask(task, {
            sessionManager,
            resolveTitle: resolveScheduledTaskTitle,
            updateTaskTitle: (taskId, title) => {
              headlessScheduledTaskStore.update(taskId, { title });
            },
            validateCwd: getWorkspacePathUnsupportedReason,
            omitSessionId: true,
          });
        },
        runAgentWatchCheck: async (prompt) => {
          const config = configStore.getAll();
          const result = await runPiAiOneShot(
            `${prompt}\n\nReply with JSON only: {"changed":boolean,"summary":string}`,
            'You are a change detector. Return JSON only.',
            config,
            { maxTokens: 256, temperature: 0 }
          );
          try {
            const parsed = JSON.parse(result.text.trim()) as {
              changed?: boolean;
              summary?: string;
            };
            return {
              changed: Boolean(parsed.changed),
              summary:
                typeof parsed.summary === 'string' ? parsed.summary : result.text.slice(0, 200),
            };
          } catch {
            return {
              changed: /changed|yes|true/i.test(result.text),
              summary: result.text.slice(0, 200),
            };
          }
        },
        onTaskError: (taskId, error) => {
          headlessSendWithPermission({
            type: 'scheduled-task.error',
            payload: { taskId, error },
          });
        },
        now: () => Date.now(),
      });
      scheduledTaskManager.start();

      chatLoopManager = new ChatLoopManager({
        api: {
          continueSession: async (sessionId, prompt) => {
            if (!sessionManager) throw new Error('Session manager not initialized');
            await sessionManager.continueSession(sessionId, prompt);
          },
          getSessionStatus: (sessionId) => {
            const session = sessionManager?.listSessions().find((s) => s.id === sessionId);
            if (!session) return null;
            if (session.status === 'running') return 'running';
            if (session.status === 'completed') return 'completed';
            return 'idle';
          },
          getLatestAssistantText: (sessionId) => {
            if (!sessionManager) return null;
            return extractAssistantText(sessionManager.getMessages(sessionId));
          },
          sessionExists: (sessionId) =>
            Boolean(sessionManager?.listSessions().some((s) => s.id === sessionId)),
        },
      });

      // Headless cleanup on exit signals
      const headlessCleanup = async () => {
        log('[Headless] Cleaning up...');
        stopConfigFileWatcher();
        scheduledTaskManager?.stop();
        chatLoopManager?.stopAll('shutdown');
        try {
          const mcpManager = sessionManager?.getMCPManager();
          if (mcpManager) {
            await mcpManager.shutdown();
          }
        } catch (e) {
          logError('[Headless] MCP shutdown error:', e);
        }
        try {
          closeDatabase();
        } catch (e) {
          logError('[Headless] DB close error:', e);
        }
        closeLogFile();
      };

      // Handle SIGTERM/SIGINT for headless mode
      for (const sig of ['SIGTERM', 'SIGINT'] as const) {
        process.on(sig, async () => {
          log(`[Headless] Received ${sig}`);
          // Stop all active sessions
          if (sessionManager) {
            const sessions = sessionManager.listSessions();
            for (const s of sessions) {
              if (s.status === 'running') {
                try {
                  await sessionManager.stopSession(s.id);
                } catch {
                  // Best effort
                }
              }
            }
          }
          await headlessCleanup();
          process.exit(0);
        });
      }

      // Helper: wait for a session to reach idle/error state
      const waitForSessionCompletion = (sessionId: string): Promise<void> =>
        new Promise((resolve) => {
          const checkInterval = setInterval(() => {
            const sessions = sessionManager!.listSessions();
            const current = sessions.find((s) => s.id === sessionId);
            if (!current || current.status === 'idle' || current.status === 'error') {
              clearInterval(checkInterval);
              resolve();
            }
          }, 500);
          // Clear interval on process exit to avoid firing during cleanup
          for (const sig of ['SIGTERM', 'SIGINT'] as const) {
            process.once(sig, () => clearInterval(checkInterval));
          }
        });

      if (headlessArgs.prompt) {
        // ── Single-shot mode: run prompt, stream output, exit ──
        log('[Headless] Single-shot mode with prompt');

        if (!configStore.hasUsableCredentialsForActiveSet()) {
          headlessSendWithPermission({
            type: 'error',
            payload: {
              message: 'No usable API credentials configured. Run the GUI to set up API keys.',
              code: 'CONFIG_REQUIRED_ACTIVE_SET',
            },
          });
          await headlessCleanup();
          process.exit(1);
          return;
        }

        try {
          const session = await sessionManager.startSession(
            'Headless Session',
            headlessArgs.prompt,
            headlessArgs.cwd
          );
          emitSessionStarted(session.id);
          await waitForSessionCompletion(session.id);
          emitSessionEnded(session.id);
          await headlessCleanup();
          process.exit(0);
        } catch (err) {
          logError('[Headless] Session error:', err);
          headlessSendWithPermission({
            type: 'error',
            payload: {
              message: err instanceof Error ? err.message : String(err),
            },
          });
          await headlessCleanup();
          process.exit(1);
        }
      } else if (headlessArgs.mode === 'rpc') {
        // ── RPC mode: read ClientEvent JSONL from stdin, keep running ──
        log('[Headless] RPC mode — reading JSONL from stdin');
        emitHeadlessReady();

        startRpcLoop(async (event) => {
          // Guard GUI-only operations in headless mode
          if (event.type === 'folder.select' || event.type === 'workdir.select') {
            throw new Error(`${event.type} is not supported in headless mode`);
          }
          return handleClientEvent(event);
        });

        // Process stays alive until stdin closes or signal received
      } else if (headlessArgs.mode === 'stdio') {
        // ── Stdio channel mode: session-based RPC via RemoteManager ──
        log('[Headless] Stdio channel mode');

        if (!configStore.hasUsableCredentialsForActiveSet()) {
          headlessSendWithPermission({
            type: 'error',
            payload: {
              message: 'No usable API credentials configured. Run the GUI to set up API keys.',
              code: 'CONFIG_REQUIRED_ACTIVE_SET',
            },
          });
          await headlessCleanup();
          process.exit(1);
          return;
        }

        // Set up RemoteManager with StdioChannel
        const stdioAgentExecutor: AgentExecutor = {
          startSession: async (title, prompt, cwd) => {
            if (!sessionManager) throw new Error('Session manager not initialized');
            const unsupportedReason = getWorkspacePathUnsupportedReason(cwd);
            if (unsupportedReason) {
              throw new Error(unsupportedReason);
            }
            return sessionManager.startSession(title, prompt, cwd);
          },
          continueSession: async (sessionId, prompt, content) => {
            if (!sessionManager) throw new Error('Session manager not initialized');
            await sessionManager.continueSession(sessionId, prompt, content);
          },
          stopSession: async (sessionId) => {
            if (!sessionManager) throw new Error('Session manager not initialized');
            await sessionManager.stopSession(sessionId);
          },
          validateWorkingDirectory: (cwd) => {
            return getWorkspacePathUnsupportedReason(cwd) || null;
          },
        };
        remoteManager.setAgentExecutor(stdioAgentExecutor);
        remoteManager.setRendererCallback(headlessSendWithPermission);

        const stdioChannel = await remoteManager.startStdioMode(headlessArgs.cwd);

        // Set the interceptor so ALL events from SM flow through stdio routing
        // (fixes the dead-code issue: SM calls headlessSendWithPermission directly,
        // which now checks stdioEventInterceptor before writing JSONL)
        stdioEventInterceptor = (event: ServerEvent) => {
          const payload =
            'payload' in event
              ? (event.payload as { sessionId?: string; [key: string]: unknown })
              : undefined;
          const sessionId = payload?.sessionId;

          if (sessionId && remoteManager.isRemoteSession(sessionId)) {
            if (event.type === 'stream.partial') {
              stdioChannel.writeEvent({
                type: 'agent.text_delta',
                sessionId,
                text: (payload.delta as string) || '',
              });
            } else if (event.type === 'trace.step') {
              const step = payload.step as {
                type?: string;
                toolName?: string;
                status?: string;
                title?: string;
                input?: unknown;
                output?: string;
              };
              if (step?.type === 'tool_call' && step?.toolName) {
                if (step.status === 'running') {
                  stdioChannel.writeToolStart(sessionId, step.toolName, step.input || {});
                } else if (step.status === 'completed' || step.status === 'error') {
                  stdioChannel.writeToolEnd(sessionId, step.toolName, step.output || '');
                }
              }
            } else if (event.type === 'session.status') {
              const status = payload.status as string;
              if (status === 'running') {
                stdioChannel.writeSessionStarted(sessionId);
              } else if (status === 'idle' || status === 'error') {
                stdioChannel.writeSessionEnd(sessionId);
                remoteManager.clearSessionBuffer(sessionId).catch(() => {});
              }
            }
            // permission.request is already handled by headlessSendWithPermission above
          }
        };

        // Notify that session.started events should come through the channel
        // The StdioChannel's onMessage triggers the MessageRouter which calls
        // remoteManager.executeAgent → sessionManager.startSession. When the session
        // is created, the remoteManager will call back writeSessionStarted via
        // its session mapping.

        // Process stays alive until stdin closes or signal received
      } else {
        // No prompt and not RPC mode — try reading from stdin pipe
        log('[Headless] Attempting to read prompt from stdin');
        const stdinPrompt = await readStdinPrompt();
        if (stdinPrompt) {
          if (!configStore.hasUsableCredentialsForActiveSet()) {
            headlessSendWithPermission({
              type: 'error',
              payload: {
                message: 'No usable API credentials configured.',
                code: 'CONFIG_REQUIRED_ACTIVE_SET',
              },
            });
            await headlessCleanup();
            process.exit(1);
            return;
          }

          try {
            const session = await sessionManager.startSession(
              'Headless Session',
              stdinPrompt,
              headlessArgs.cwd
            );
            emitSessionStarted(session.id);
            await waitForSessionCompletion(session.id);
            emitSessionEnded(session.id);
            await headlessCleanup();
            process.exit(0);
          } catch (err) {
            logError('[Headless] Session error:', err);
            await headlessCleanup();
            process.exit(1);
          }
        } else {
          process.stderr.write(
            'Error: --headless requires either -p "prompt", --mode rpc, or piped stdin\n'
          );
          await headlessCleanup();
          process.exit(1);
        }
      }

      return; // Skip all GUI initialization below
    }

    // ── GUI mode (default) ─────────────────────────────────────────────

    // Apply dev logs setting from config
    const enableDevLogs = configStore.get('enableDevLogs');
    setDevLogsEnabled(enableDevLogs);
    setMcpWriteAccessServerSource(() => mcpConfigStore.getServers());
    setMcpWriteAccessEnabled(configStore.get('mcpWriteAccessEnabled') !== false);

    // Start config file watcher for bidirectional sync
    startConfigFileWatcher();

    // Log environment variables for debugging
    log('=== York IE VECOS Starting ===');
    log('Config file:', configStore.getPath());
    log('Is configured:', configStore.isConfigured());
    log('[Runtime] Using York IE agent SDK for all providers');
    log('Developer logs:', enableDevLogs ? 'Enabled' : 'Disabled');
    log('Environment Variables:');
    log('  ANTHROPIC_AUTH_TOKEN:', process.env.ANTHROPIC_AUTH_TOKEN ? '✓ Set' : '✗ Not set');
    log('  ANTHROPIC_BASE_URL:', process.env.ANTHROPIC_BASE_URL || '(not set)');
    log('  CLAUDE_MODEL:', process.env.CLAUDE_MODEL || '(not set)');
    log('  AGENT_CLI_PATH:', process.env.AGENT_CLI_PATH || '(not set)');
    log('  OPENAI_API_KEY:', process.env.OPENAI_API_KEY ? '✓ Set' : '✗ Not set');
    log('  OPENAI_BASE_URL:', process.env.OPENAI_BASE_URL || '(not set)');
    log('  OPENAI_MODEL:', process.env.OPENAI_MODEL || '(not set)');
    log('  OPENAI_API_MODE:', process.env.OPENAI_API_MODE || '(default)');
    log('===========================');

    // Initialize default working directory
    initializeDefaultWorkingDir();
    log('Working directory:', currentWorkingDir);
    // Remote sessions use the global working directory by default
    remoteManager.setDefaultWorkingDirectory(currentWorkingDir || undefined);

    // Initialize database
    const db = initDatabase();

    void warmupJwksCache();
    setAuthRendererNotifier((win) => {
      if (win && !win.isDestroyed()) {
        win.webContents.send('auth:changed', getAuthStatus());
      }
    });
    await initAuth(() => mainWindow);
    if (isAuthenticated()) {
      startAuthRefreshTimer(() => mainWindow);
    }

    pluginRuntimeService = new PluginRuntimeService(new PluginCatalogService());
    memoryService = new MemoryService(db);
    bindConnectorMemoryService(memoryService);
    meetingService = new MeetingService();
    meetingService.setMemoryService(memoryService);
    wireMeetingServiceEvents(meetingService);
    const askUserQuestionExtension = new AskUserQuestionExtension(sendToRenderer);
    const extensionManager = new AgentRuntimeExtensionManager([
      new MemoryExtension(memoryService),
      new MeetingExtension(meetingService),
      new ConfigExtension(configStore),
      new WebFetchExtension(),
      askUserQuestionExtension,
      new SubagentExtension(
        () => sessionManager?.getMCPManager() ?? null,
        sendToRenderer,
        async (toolName, toolInput) =>
          resolveSubagentToolPermission(toolName, toolInput as Record<string, unknown>)
      ),
    ]);

    // Initialize session manager before creating an interactive window.
    // This avoids session.start racing the startup path and hitting a null manager.
    sessionManager = new SessionManager(
      db,
      sendToRenderer,
      pluginRuntimeService,
      extensionManager,
      askUserQuestionExtension
    );
    sessionManager.setMeetingService(meetingService);
    skillsManager = new SkillsManager(db, {
      getConfiguredGlobalSkillsPath: () => configStore.get('globalSkillsPath') || '',
      setConfiguredGlobalSkillsPath: (nextPath: string) => {
        configStore.update({ globalSkillsPath: nextPath });
      },
      watchStorage: true,
    });
    skillsManager.onStorageChanged((event) => {
      sendToRenderer({
        type: 'skills.storageChanged',
        payload: event,
      });
    });
    // pi-ai handles model routing natively — no proxy warmup needed

    // macOS: application menu, dock menu, tray icon
    buildMacMenu();
    setupTray();

    // Show window after core managers are ready so first-load actions can be handled.
    setupMeetingMediaCapture();
    createWindow();

    // macOS: dock menu
    if (process.platform === 'darwin') {
      const dockMenu = Menu.buildFromTemplate([
        {
          label: 'New Session',
          click: () => mainWindow?.webContents.send('server-event', { type: 'new-session' }),
        },
        {
          label: 'Settings',
          click: () =>
            mainWindow?.webContents.send('server-event', { type: 'navigate', payload: 'settings' }),
        },
      ]);
      app.dock?.setMenu(dockMenu);
    }

    // macOS: send initial system theme to renderer
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.on('did-finish-load', () => {
        sendToRenderer({
          type: 'native-theme.changed',
          payload: { shouldUseDarkColors: nativeTheme.shouldUseDarkColors },
        });
      });
    }

    // Listen for system theme changes
    nativeTheme.on('updated', () => {
      sendToRenderer({
        type: 'native-theme.changed',
        payload: { shouldUseDarkColors: nativeTheme.shouldUseDarkColors },
      });
      if (getSavedThemePreference() === 'system' && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.setBackgroundColor(nativeTheme.shouldUseDarkColors ? DARK_BG : LIGHT_BG);
      }
    });

    // Auto-updater: check for updates in production
    if (!isDev) {
      import('electron-updater')
        .then(({ autoUpdater }) => {
          autoUpdater.checkForUpdatesAndNotify().catch((err: unknown) => {
            log('[AutoUpdater] Update check failed:', err);
          });
        })
        .catch((err: unknown) => {
          log('[AutoUpdater] Failed to load electron-updater:', err);
        });
    }

    startNavServer(() => mainWindow);

    const scheduledTaskStore = createScheduledTaskStore(db);
    scheduledTaskManager = new ScheduledTaskManager({
      store: scheduledTaskStore,
      executeTask: async (task) => {
        if (!sessionManager) {
          throw new Error('Session manager not initialized');
        }
        return executeScheduledTask(task, {
          sessionManager,
          resolveTitle: resolveScheduledTaskTitle,
          updateTaskTitle: (taskId, title) => {
            scheduledTaskStore.update(taskId, { title });
          },
          validateCwd: getWorkspacePathUnsupportedReason,
          onSessionStarted: (started) => {
            sendToRenderer({
              type: 'session.update',
              payload: { sessionId: started.id, updates: started },
            });
          },
        });
      },
      runAgentWatchCheck: async (prompt) => {
        const config = configStore.getAll();
        const result = await runPiAiOneShot(
          `${prompt}\n\nReply with JSON only: {"changed":boolean,"summary":string}`,
          'You are a change detector. Return JSON only.',
          config,
          { maxTokens: 256, temperature: 0 }
        );
        try {
          const parsed = JSON.parse(result.text.trim()) as {
            changed?: boolean;
            summary?: string;
          };
          return {
            changed: Boolean(parsed.changed),
            summary:
              typeof parsed.summary === 'string' ? parsed.summary : result.text.slice(0, 200),
          };
        } catch {
          return {
            changed: /changed|yes|true/i.test(result.text),
            summary: result.text.slice(0, 200),
          };
        }
      },
      onTaskError: (taskId, error) => {
        sendToRenderer({
          type: 'scheduled-task.error',
          payload: { taskId, error },
        });
      },
      now: () => Date.now(),
    });
    scheduledTaskManager.start();

    chatLoopManager = new ChatLoopManager({
      api: {
        continueSession: async (sessionId, prompt) => {
          if (!sessionManager) throw new Error('Session manager not initialized');
          await sessionManager.continueSession(sessionId, prompt);
        },
        getSessionStatus: (sessionId) => {
          const session = sessionManager?.listSessions().find((s) => s.id === sessionId);
          if (!session) return null;
          if (session.status === 'running') return 'running';
          if (session.status === 'completed') return 'completed';
          return 'idle';
        },
        getLatestAssistantText: (sessionId) => {
          if (!sessionManager) return null;
          return extractAssistantText(sessionManager.getMessages(sessionId));
        },
        sessionExists: (sessionId) =>
          Boolean(sessionManager?.listSessions().some((s) => s.id === sessionId)),
      },
      onChanged: (status, sessionId) => {
        sendToRenderer({
          type: 'chat-loop.update',
          payload: { sessionId, status },
        });
      },
    });

    // Initialize remote manager
    remoteManager.setRendererCallback(sendToRenderer);
    const agentExecutor: AgentExecutor = {
      startSession: async (title, prompt, cwd) => {
        if (!sessionManager) throw new Error('Session manager not initialized');
        const unsupportedReason = getWorkspacePathUnsupportedReason(cwd);
        if (unsupportedReason) {
          throw new Error(unsupportedReason);
        }
        return sessionManager.startSession(title, prompt, cwd);
      },
      continueSession: async (sessionId, prompt, content, cwd) => {
        if (!sessionManager) throw new Error('Session manager not initialized');
        if (cwd) {
          const result = await setWorkingDir(cwd, sessionId);
          if (!result.success) {
            throw new Error(result.error || 'Failed to update working directory');
          }
        }
        await sessionManager.continueSession(sessionId, prompt, content);
      },
      stopSession: async (sessionId) => {
        if (!sessionManager) throw new Error('Session manager not initialized');
        await sessionManager.stopSession(sessionId);
      },
      validateWorkingDirectory: async (cwd) => {
        const unsupportedReason = getWorkspacePathUnsupportedReason(cwd);
        if (unsupportedReason) {
          return unsupportedReason;
        }
        if (!fs.existsSync(cwd)) {
          return 'Directory does not exist';
        }
        return null;
      },
    };
    remoteManager.setAgentExecutor(agentExecutor);

    // Start remote control when enabled
    if (remoteConfigStore.isEnabled()) {
      remoteManager.start().catch((error) => {
        logError('[App] Failed to start remote control:', error);
      });
    }

    app.on('activate', () => {
      const hasVisibleWindow = BrowserWindow.getAllWindows().some((w) => !w.isDestroyed());
      if (!hasVisibleWindow) {
        createWindow();
      }
    });
  })
  .catch((error) => {
    logError('[App] Startup failed:', error);
    const message = error instanceof Error ? error.message : 'Unknown startup error';
    dialog.showErrorBox(
      'York WorkOS failed to start',
      `${message}\n\nPlease check the logs for more information.`
    );
    app.quit();
  });

// Flag to prevent double cleanup
let isCleaningUp = false;
// Tracks explicit quit intent (Cmd+Q, Quit menu, tray Quit) vs window close only
let isQuitting = false;

function withTimeout<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
  });

  return Promise.race([operation, timeoutPromise]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  }) as Promise<T>;
}

/**
 * Cleanup all sandbox resources
 * Called on app quit (both Windows and macOS)
 */
async function cleanupSandboxResources(): Promise<void> {
  if (isCleaningUp) {
    log('[App] Cleanup already in progress, skipping...');
    return;
  }
  isCleaningUp = true;

  stopNavServer();
  stopConfigFileWatcher();
  skillsManager?.stopStorageMonitoring();
  scheduledTaskManager?.stop();
  chatLoopManager?.stopAll('shutdown');
  tray?.destroy();
  tray = null;

  // Stop remote control
  try {
    log('[App] Stopping remote control...');
    await withTimeout(remoteManager.stop(), 5000, 'Remote control shutdown');
    log('[App] Remote control stopped');
  } catch (error) {
    logError('[App] Error stopping remote control:', error);
  }

  // Cleanup all sandbox sessions (sync changes back to host OS first)
  try {
    log('[App] Cleaning up all sandbox sessions...');

    // Cleanup WSL sessions
    await withTimeout(SandboxSync.cleanupAllSessions(), 30000, 'WSL session cleanup');

    // Cleanup Lima sessions
    const { LimaSync } = await import('./sandbox/lima-sync');
    await withTimeout(LimaSync.cleanupAllSessions(), 30000, 'Lima session cleanup');

    log('[App] Sandbox sessions cleanup complete');
  } catch (error) {
    logError('[App] Error cleaning up sandbox sessions:', error);
  }

  // Shutdown sandbox adapter
  try {
    await withTimeout(shutdownSandbox(), 8000, 'Sandbox shutdown');
    log('[App] Sandbox shutdown complete');
  } catch (error) {
    logError('[App] Error shutting down sandbox:', error);
  }

  // Shutdown MCP servers
  try {
    const mcpManager = sessionManager?.getMCPManager();
    if (mcpManager) {
      log('[App] Shutting down MCP servers...');
      await withTimeout(mcpManager.shutdown(), 5000, 'MCP shutdown');
      log('[App] MCP servers shutdown complete');
    }
  } catch (error) {
    logError('[App] Error shutting down MCP servers:', error);
  }

  try {
    closeDatabase();
  } catch (error) {
    logError('[App] Error closing database:', error);
  }

  closeLogFile();

  // pi-ai doesn't need proxy shutdown
}

// Handle app quit - window-all-closed (primary for Windows/Linux)
app.on('window-all-closed', async () => {
  // In headless mode there are no windows, so this event fires immediately.
  // The headless path manages its own lifecycle — skip cleanup here.
  if (process.argv.includes('--headless')) return;

  if (isQuitting || process.platform !== 'darwin' || process.env.VITE_DEV_SERVER_URL) {
    // Quit when user initiated quit (Cmd+Q/Quit menu), or on Windows/Linux, or macOS dev.
    // On macOS dev mode, also quit — so vite-plugin-electron can restart cleanly
    // without the old process holding the single-instance lock.
    await cleanupSandboxResources();
    app.quit();
  }
  // On macOS production window close only (X/Cmd+W), keep app alive — cleanup in before-quit
});

// Handle SIGTERM/SIGINT (e.g. pkill) — route through app.quit() for clean shutdown
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => app.quit());
}

// Handle app quit - before-quit (for macOS Cmd+Q and other quit methods)
app.on('before-quit', async (event) => {
  // In dev mode, exit quickly — no need for async sandbox cleanup
  if (process.env.VITE_DEV_SERVER_URL) {
    stopNavServer();
    try {
      closeDatabase();
    } catch {
      /* best-effort */
    }
    closeLogFile();
    tray?.destroy();
    tray = null;
    return;
  }

  if (isQuitting) {
    return;
  }

  isQuitting = true;
  event.preventDefault();
  try {
    await cleanupSandboxResources();
  } catch (error) {
    logError('[App] before-quit cleanup failed, forcing quit:', error);
  }
  app.exit(0);
});

// IPC Handlers
ipcMain.handle('auth.getStatus', () => getAuthStatus());

ipcMain.handle('auth.getOAuthDebug', async (_event, rendererRedirectUrl?: string) => {
  return getOAuthDebugInfo(rendererRedirectUrl);
});

ipcMain.handle('auth.startGoogleLogin', async () => {
  try {
    const status = await startGoogleLogin(mainWindow);
    startAuthRefreshTimer(() => mainWindow);
    return { success: true, ...status };
  } catch (error) {
    logError('[Auth] Google login failed:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Sign-in failed',
      user: null,
      tokens: null,
    };
  }
});

ipcMain.handle('auth.me', async () => {
  try {
    return { success: true, ...(await getMe()) };
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      return { success: false, error: error.message, code: error.code };
    }
    throw error;
  }
});

ipcMain.handle('auth.getAvatarDataUrl', async (_event, imageUrl?: string) => {
  try {
    await ensureAuthenticatedSession();
    const current = getCurrentSession();
    if (!current) {
      return { success: false, dataUrl: null as string | null };
    }
    const url =
      typeof imageUrl === 'string' && imageUrl.trim()
        ? imageUrl.trim()
        : current.user.image?.trim();
    if (!url) {
      return { success: true, dataUrl: null as string | null };
    }
    const dataUrl = await resolveAvatarDataUrl(url, [current.accessToken, current.idToken]);
    return { success: true, dataUrl };
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      return { success: false, dataUrl: null as string | null, code: error.code };
    }
    throw error;
  }
});

ipcMain.handle('auth.logout', async () => {
  stopAuthRefreshTimer();
  clearHubAllocationsCache();
  await authLogout(mainWindow);
  return { success: true };
});

ipcMain.handle('auth.refresh', async () => {
  try {
    const status = await refreshAuth(mainWindow);
    return { success: true, ...status };
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      return { success: false, error: error.message, code: error.code };
    }
    throw error;
  }
});

ipcMain.handle('auth.submitOAuthCode', async (_event, code: string, redirectUri: string) => {
  if (!code?.trim()) {
    return { success: false, error: 'Missing sign-in code.' };
  }
  const redirect = redirectUri?.trim() || authConfig.hubOAuthRedirectUrl;
  if (submitViteOAuthCode(code.trim())) {
    return { success: true, pending: true };
  }
  try {
    const status = await completeOAuthFromHubCode(mainWindow, code.trim(), redirect);
    startAuthRefreshTimer(() => mainWindow);
    clearHubAllocationsCache();
    return { success: true, ...status };
  } catch (error) {
    logError('[Auth] OAuth callback failed:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Sign-in failed',
    };
  }
});

ipcMain.handle('hub.listAllocatedProjects', async (_event, forceRefresh?: boolean) => {
  try {
    await ensureAuthenticatedSession();
    const projects = await listAllocatedProjects({ forceRefresh: Boolean(forceRefresh) });
    return { success: true, projects };
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      return { success: false, projects: [], error: error.message, code: error.code };
    }
    if (error instanceof HubAllocationsError) {
      return { success: false, projects: [], error: error.message, code: 'HUB_ALLOCATIONS' };
    }
    logError('[HubAllocations] listAllocatedProjects failed:', error);
    return {
      success: false,
      projects: [],
      error: error instanceof Error ? error.message : 'Failed to load allocations',
    };
  }
});

ipcMain.on('client-event', async (_event, data: ClientEvent) => {
  try {
    await handleClientEvent(data);
  } catch (error) {
    logError('Error handling client event:', error);
    const payload: { message: string; code?: 'CONFIG_REQUIRED_ACTIVE_SET' | 'AUTH_REQUIRED' } = {
      message: error instanceof Error ? error.message : 'Unknown error',
    };
    if (error instanceof AuthRequiredError) {
      payload.code = AUTH_REQUIRED_CODE;
    }
    sendToRenderer({
      type: 'error',
      payload,
    });
  }
});

ipcMain.handle('client-invoke', async (_event, data: ClientEvent) => {
  return handleClientEvent(data);
});

ipcMain.handle('get-version', () => {
  try {
    return app.getVersion();
  } catch (error) {
    logError('[IPC] Error getting version:', error);
    return 'unknown';
  }
});

ipcMain.handle('system.getTheme', () => {
  try {
    return { shouldUseDarkColors: nativeTheme.shouldUseDarkColors };
  } catch (error) {
    logError('[IPC] Error getting theme:', error);
    return { shouldUseDarkColors: true };
  }
});

ipcMain.handle('shell.openExternal', async (_event, url: string) => {
  if (!url) {
    return false;
  }

  try {
    const parsed = new URL(url);
    if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) {
      logWarn('[shell.openExternal] Blocked URL with disallowed protocol:', parsed.protocol);
      return false;
    }
  } catch {
    logWarn('[shell.openExternal] Blocked invalid URL:', url);
    return false;
  }

  return shell.openExternal(url);
});

async function revealFileInFolder(filePath: string, cwd?: string): Promise<boolean> {
  if (!filePath) {
    return false;
  }

  const trimInput = filePath.trim();
  if (!trimInput) {
    return false;
  }

  let normalizedPath = decodePathSafely(trimInput);

  if (normalizedPath.startsWith('file://')) {
    const localPath = localPathFromFileUrl(normalizedPath);
    if (!localPath) {
      logWarn('[shell.showItemInFolder] could not parse file URL:', normalizedPath);
      return false;
    }
    normalizedPath = localPath;
  }

  const baseDir = cwd && isAbsolute(cwd) ? cwd : getWorkingDir() || app.getPath('home');
  normalizedPath = resolvePathAgainstWorkspace(normalizedPath, baseDir);
  if (
    !isAbsolute(normalizedPath) &&
    !isWindowsDrivePath(normalizedPath) &&
    !isUncPath(normalizedPath)
  ) {
    normalizedPath = resolve(baseDir, normalizedPath);
  }

  if (!isUncPath(normalizedPath)) {
    normalizedPath = resolve(normalizedPath);
  }
  log('[shell.showItemInFolder] request:', { filePath, cwd, resolved: normalizedPath });

  const findFileByName = (fileName: string, roots: string[]): string | null => {
    if (!fileName) {
      return null;
    }

    const visited = new Set<string>();
    const queue = roots
      .map((root) => resolve(root))
      .filter((root) => !!root && fs.existsSync(root) && fs.statSync(root).isDirectory());

    let scannedDirs = 0;
    const MAX_DIRS = 2000;

    while (queue.length > 0 && scannedDirs < MAX_DIRS) {
      const dir = queue.shift()!;
      if (visited.has(dir)) {
        continue;
      }
      visited.add(dir);
      scannedDirs += 1;

      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isFile() && entry.name === fileName) {
          return fullPath;
        }
        if (entry.isDirectory()) {
          queue.push(fullPath);
        }
      }
    }

    return null;
  };

  try {
    if (fs.existsSync(normalizedPath)) {
      const stat = fs.statSync(normalizedPath);
      if (stat.isDirectory()) {
        const openDirResult = await shell.openPath(normalizedPath);
        if (openDirResult) {
          logWarn('[shell.showItemInFolder] openPath returned warning:', openDirResult);
        }
      } else {
        if (process.platform === 'darwin') {
          try {
            execFileSync('open', ['-R', normalizedPath]);
          } catch (error) {
            logWarn(
              '[shell.showItemInFolder] open -R failed, fallback to shell.showItemInFolder:',
              error
            );
            shell.showItemInFolder(normalizedPath);
          }
        } else {
          shell.showItemInFolder(normalizedPath);
        }
      }
      return true;
    }

    const fileName = basename(normalizedPath);
    const defaultWorkingDir = getWorkingDir() || '';
    const discoveredPath = findFileByName(fileName, [
      cwd || '',
      defaultWorkingDir,
      join(app.getPath('userData'), 'default_working_dir'),
    ]);

    if (discoveredPath) {
      logWarn('[shell.showItemInFolder] resolved path not found, discovered by filename:', {
        requested: normalizedPath,
        discoveredPath,
      });
      if (process.platform === 'darwin') {
        try {
          execFileSync('open', ['-R', discoveredPath]);
        } catch (error) {
          logWarn(
            '[shell.showItemInFolder] open -R discovered file failed, fallback to shell.showItemInFolder:',
            error
          );
          shell.showItemInFolder(discoveredPath);
        }
      } else {
        shell.showItemInFolder(discoveredPath);
      }
      return true;
    }

    const parentDir = dirname(normalizedPath);
    if (parentDir && fs.existsSync(parentDir)) {
      logWarn('[shell.showItemInFolder] file not found, opening parent directory:', parentDir);
      const openParentResult = await shell.openPath(parentDir);
      if (openParentResult) {
        logWarn('[shell.showItemInFolder] openPath parent returned warning:', openParentResult);
      }
      return true;
    }

    logWarn('[shell.showItemInFolder] path and parent directory do not exist:', normalizedPath);
    return false;
  } catch (error) {
    logError('[shell.showItemInFolder] failed:', error);
    return false;
  }
}

ipcMain.handle('shell.showItemInFolder', async (_event, filePath: string, cwd?: string) => {
  return revealFileInFolder(filePath, cwd);
});

ipcMain.handle(
  'artifacts.listRecentFiles',
  async (_event, cwd: string, sinceMs: number, limit: number = 50) => {
    if (!cwd || !isAbsolute(cwd)) {
      return [];
    }
    return listRecentWorkspaceFiles(cwd, sinceMs, limit);
  }
);

const MAX_FILE_DATA_URL_BYTES = 8 * 1024 * 1024; // 8MB cap for renderer previews

ipcMain.handle('dialog.selectFiles', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    title: 'Select Files',
  });

  if (result.canceled) {
    return [];
  }

  const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
  const mimeByExt: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    pdf: 'application/pdf',
  };

  return result.filePaths.map((filePath) => {
    const name = basename(filePath);
    const ext = extname(filePath).slice(1).toLowerCase();
    const mimeType = mimeByExt[ext] || 'application/octet-stream';
    let size = 0;
    let dataUrl: string | undefined;
    try {
      const stat = fs.statSync(filePath);
      size = stat.size;
      if (IMAGE_EXTS.has(ext) && stat.isFile() && stat.size <= MAX_FILE_DATA_URL_BYTES) {
        const buffer = fs.readFileSync(filePath);
        dataUrl = `data:${mimeType};base64,${buffer.toString('base64')}`;
      }
    } catch (error) {
      logError('[Files] selectFiles preview failed:', error);
    }
    return { path: filePath, name, size, mimeType, dataUrl };
  });
});

ipcMain.handle(
  'files.readAsDataUrl',
  async (
    _event,
    filePath: string
  ): Promise<{ success: boolean; dataUrl?: string; size?: number; error?: string }> => {
    try {
      if (typeof filePath !== 'string' || !filePath.trim()) {
        return { success: false, error: 'Invalid path' };
      }
      const resolved = resolve(filePath);
      const stat = fs.statSync(resolved);
      if (!stat.isFile()) {
        return { success: false, error: 'Not a file' };
      }
      if (stat.size > MAX_FILE_DATA_URL_BYTES) {
        return { success: false, error: 'File too large', size: stat.size };
      }
      const buffer = fs.readFileSync(resolved);
      const ext = extname(resolved).slice(1).toLowerCase();
      const mimeByExt: Record<string, string> = {
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        gif: 'image/gif',
        webp: 'image/webp',
      };
      const mime = mimeByExt[ext] || 'application/octet-stream';
      return {
        success: true,
        dataUrl: `data:${mime};base64,${buffer.toString('base64')}`,
        size: stat.size,
      };
    } catch (error) {
      logError('[Files] readAsDataUrl failed:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to read file',
      };
    }
  }
);

// Config IPC handlers
ipcMain.handle('config.get', () => {
  try {
    return configStore.getAll();
  } catch (error) {
    logError('[Config] Error getting config:', error);
    return {};
  }
});

ipcMain.handle('config.getPresets', () => {
  try {
    return getPiAiModelPresets();
  } catch (error) {
    logError('[Config] Error getting presets:', error);
    return [];
  }
});

const buildAgentRuntimeSignature = (config: AppConfig): string =>
  JSON.stringify({
    provider: config.provider,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    customProtocol: config.customProtocol,
    model: config.model,
    enableThinking: config.enableThinking,
    memoryEnabled: config.memoryEnabled,
    memoryRuntime: config.memoryRuntime,
  });

const syncConfigAfterMutation = async (previousConfig: AppConfig) => {
  // Mark as configured if any config set has usable credentials
  configStore.set('isConfigured', configStore.hasAnyUsableCredentials());

  // Apply to environment
  configStore.applyToEnv();

  const updatedConfig = configStore.getAll();
  setMcpWriteAccessEnabled(updatedConfig.mcpWriteAccessEnabled !== false);
  const shouldReloadRunner =
    buildAgentRuntimeSignature(previousConfig) !== buildAgentRuntimeSignature(updatedConfig);
  const shouldReloadSandbox = previousConfig.sandboxEnabled !== updatedConfig.sandboxEnabled;

  if (sessionManager) {
    if (shouldReloadRunner) {
      sessionManager.reloadConfig();
    }
    if (shouldReloadSandbox) {
      await sessionManager
        .reloadSandbox()
        .catch((err) => logError('[Config] Sandbox reload failed:', err));
    }
    if (shouldReloadRunner || shouldReloadSandbox) {
      log(
        '[Config] Session manager config synced:',
        JSON.stringify({ runnerReloaded: shouldReloadRunner, sandboxReloaded: shouldReloadSandbox })
      );
    }
  }

  // Notify renderer of config update
  const isConfigured = configStore.isConfigured();
  sendToRenderer({
    type: 'config.status',
    payload: {
      isConfigured,
      config: updatedConfig,
    },
  });
  log('[Config] Notified renderer of config update, isConfigured:', isConfigured);

  // Sync plaintext config file with updated safe fields
  exportOnConfigChange();

  return updatedConfig;
};

ipcMain.handle('config.save', async (_event, newConfig: Partial<AppConfig>) => {
  log('[Config] Saving config:', {
    ...newConfig,
    apiKey: newConfig.apiKey ? '***' : '',
    openRouterUserApiKey: newConfig.openRouterUserApiKey ? '***' : '',
    memoryRuntime: newConfig.memoryRuntime
      ? {
          ...newConfig.memoryRuntime,
          llm: newConfig.memoryRuntime.llm
            ? {
                ...newConfig.memoryRuntime.llm,
                apiKey: newConfig.memoryRuntime.llm.apiKey ? '***' : '',
              }
            : undefined,
          embedding: newConfig.memoryRuntime.embedding
            ? {
                ...newConfig.memoryRuntime.embedding,
                apiKey: newConfig.memoryRuntime.embedding.apiKey ? '***' : '',
              }
            : undefined,
        }
      : undefined,
  });

  const previousConfig = configStore.getAll();
  // Update config
  configStore.update(newConfig);
  const updatedConfig = await syncConfigAfterMutation(previousConfig);

  if (
    meetingService &&
    (newConfig.meetingsEnabled !== undefined || newConfig.meetingsRuntime !== undefined)
  ) {
    meetingService.syncDetectionPolling();
  }

  return { success: true, config: updatedConfig };
});

ipcMain.handle('config.createSet', async (_event, payload: CreateConfigSetPayload) => {
  log('[Config] Creating config set:', payload);
  const previousConfig = configStore.getAll();
  configStore.createSet(payload);
  const updatedConfig = await syncConfigAfterMutation(previousConfig);
  return { success: true, config: updatedConfig };
});

ipcMain.handle('config.renameSet', async (_event, payload: { id: string; name: string }) => {
  log('[Config] Renaming config set:', payload);
  const previousConfig = configStore.getAll();
  configStore.renameSet(payload);
  const updatedConfig = await syncConfigAfterMutation(previousConfig);
  return { success: true, config: updatedConfig };
});

ipcMain.handle('config.deleteSet', async (_event, payload: { id: string }) => {
  log('[Config] Deleting config set:', payload);
  const previousConfig = configStore.getAll();
  configStore.deleteSet(payload);
  const updatedConfig = await syncConfigAfterMutation(previousConfig);
  return { success: true, config: updatedConfig };
});

ipcMain.handle('config.switchSet', async (_event, payload: { id: string }) => {
  log('[Config] Switching config set:', payload);
  const previousConfig = configStore.getAll();
  configStore.switchSet(payload);
  const updatedConfig = await syncConfigAfterMutation(previousConfig);
  return { success: true, config: updatedConfig };
});

ipcMain.handle('config.isConfigured', () => {
  try {
    return configStore.isConfigured();
  } catch (error) {
    logError('[Config] Error checking configured status:', error);
    return false;
  }
});

ipcMain.handle('config.test', async (_event, payload: ApiTestInput): Promise<ApiTestResult> => {
  try {
    return await runConfigApiTest(payload, configStore.getAll());
  } catch (error) {
    logError('[Config] API test failed:', error);
    return {
      ok: false,
      errorType: 'unknown',
      details: error instanceof Error ? error.message : String(error),
    };
  }
});

ipcMain.handle(
  'config.listModels',
  async (
    _event,
    payload: { provider: AppConfig['provider']; apiKey: string; baseUrl?: string }
  ): Promise<ProviderModelInfo[]> => {
    if (payload.provider !== 'ollama') {
      return [];
    }
    return listOllamaModels(payload);
  }
);

ipcMain.handle('config.listBackendModels', async () => {
  return fetchBackendModels();
});

ipcMain.handle('config.diagnose', async (_event, payload: DiagnosticInput) => {
  try {
    const { runDiagnostics } = await import('./config/api-diagnostics');
    return await runDiagnostics(payload);
  } catch (error) {
    logError('[Config] Error running diagnostics:', error);
    throw error;
  }
});

ipcMain.handle('config.discover-local', async (_event, payload?: { baseUrl?: string }) => {
  try {
    const { discoverLocalOllama } = await import('./config/api-diagnostics');
    return await discoverLocalOllama(payload);
  } catch (error) {
    logError('[Config] Error discovering local services:', error);
    return [];
  }
});

// Config file export/import IPC handlers
ipcMain.handle('config.exportFile', () => {
  try {
    exportOnConfigChange();
    return { success: true, path: configStore.getPublicConfigPath() };
  } catch (error) {
    logError('[Config] Error exporting config file:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
});

ipcMain.handle('config.importFile', async () => {
  try {
    const previousConfig = configStore.getAll();
    const imported = configStore.importSafeConfig();
    if (imported) {
      await syncConfigAfterMutation(previousConfig);
    }
    return { success: true, imported };
  } catch (error) {
    logError('[Config] Error importing config file:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
});

ipcMain.handle('config.getPublicPath', () => {
  try {
    return configStore.getPublicConfigPath();
  } catch (error) {
    logError('[Config] Error getting public config path:', error);
    return null;
  }
});

// MCP Server IPC handlers
ipcMain.handle('mcp.getServers', () => {
  try {
    return mcpConfigStore.getServers();
  } catch (error) {
    logError('[MCP] Error getting servers:', error);
    return [];
  }
});

ipcMain.handle('mcp.getServer', (_event, serverId: string) => {
  try {
    return mcpConfigStore.getServer(serverId);
  } catch (error) {
    logError('[MCP] Error getting server:', error);
    return null;
  }
});

ipcMain.handle('mcp.saveServer', async (_event, config: MCPServerConfig) => {
  mcpConfigStore.saveServer(config);
  // Update only this specific server, not all servers
  if (sessionManager) {
    const mcpManager = sessionManager.getMCPManager();
    try {
      await mcpManager.updateServer(config);
      sessionManager.invalidateMcpServersCache();
      log(`[MCP] Server ${config.name} updated successfully`);
    } catch (err) {
      logError('[MCP] Failed to update server:', err);
      const errorMessage = err instanceof Error ? err.message : String(err);
      return { success: false, error: errorMessage };
    }
  }
  return { success: true };
});

ipcMain.handle('mcp.deleteServer', async (_event, serverId: string) => {
  const deleted = mcpConfigStore.deleteServer(serverId);
  if (!deleted) {
    return { success: false, error: 'The built-in Chrome connector cannot be deleted' };
  }
  // Remove and disconnect only this specific server
  if (sessionManager) {
    const mcpManager = sessionManager.getMCPManager();
    try {
      await mcpManager.removeServer(serverId);
      sessionManager.invalidateMcpServersCache();
      log(`[MCP] Server ${serverId} removed successfully`);
    } catch (err) {
      logError('[MCP] Failed to remove server:', err);
    }
  }
  return { success: true };
});

ipcMain.handle('mcp.getTools', () => {
  try {
    if (!sessionManager) {
      return [];
    }
    const mcpManager = sessionManager.getMCPManager();
    return mcpManager.getTools();
  } catch (error) {
    logError('[MCP] Error getting tools:', error);
    return [];
  }
});

ipcMain.handle('mcp.getServerStatus', () => {
  try {
    if (!sessionManager) {
      return [];
    }
    const mcpManager = sessionManager.getMCPManager();
    return mcpManager.getServerStatus();
  } catch (error) {
    logError('[MCP] Error getting server status:', error);
    return [];
  }
});

ipcMain.handle('mcp.getToolsReadyState', () => {
  try {
    if (!sessionManager) {
      return { ready: false, connectingCount: 0, bootstrapComplete: false };
    }
    const mcpManager = sessionManager.getMCPManager();
    return mcpManager.getToolsReadyState();
  } catch (error) {
    logError('[MCP] Error getting tools ready state:', error);
    return { ready: false, connectingCount: 0, bootstrapComplete: false };
  }
});

ipcMain.handle('mcp.connectServer', async (_event, serverId: string) => {
  try {
    const config = mcpConfigStore.getServer(serverId);
    if (!config) {
      return { success: false, error: `MCP server not found: ${serverId}` };
    }
    const updated = { ...config, enabled: true };
    mcpConfigStore.saveServer(updated);
    if (sessionManager) {
      const mcpManager = sessionManager.getMCPManager();
      await mcpManager.updateServer(updated);
      sessionManager.invalidateMcpServersCache();
      log(`[MCP] Server ${updated.name} connected via IPC`);
    }
    return { success: true };
  } catch (error) {
    logError('[MCP] Error connecting server:', error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    return { success: false, error: errorMessage };
  }
});

ipcMain.handle('mcp.disconnectServer', async (_event, serverId: string) => {
  try {
    const config = mcpConfigStore.getServer(serverId);
    if (!config) {
      return { success: false, error: `MCP server not found: ${serverId}` };
    }
    const updated = { ...config, enabled: false };
    mcpConfigStore.saveServer(updated);
    if (sessionManager) {
      const mcpManager = sessionManager.getMCPManager();
      await mcpManager.updateServer(updated);
      sessionManager.invalidateMcpServersCache();
      log(`[MCP] Server ${updated.name} disconnected via IPC`);
    }
    return { success: true };
  } catch (error) {
    logError('[MCP] Error disconnecting server:', error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    return { success: false, error: errorMessage };
  }
});

ipcMain.handle('mcp.reconnectServer', async (_event, serverId: string) => {
  try {
    if (!sessionManager) {
      return { success: false, error: 'Session manager not available' };
    }
    const mcpManager = sessionManager.getMCPManager();
    const ok = await mcpManager.reconnectServer(serverId);
    sessionManager.invalidateMcpServersCache();
    if (!ok) {
      return { success: false, error: `Failed to reconnect MCP server: ${serverId}` };
    }
    log(`[MCP] Server ${serverId} reconnected via IPC`);
    return { success: true };
  } catch (error) {
    logError('[MCP] Error reconnecting server:', error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    return { success: false, error: errorMessage };
  }
});

ipcMain.handle('mcp.getPresets', () => {
  try {
    return mcpConfigStore.getPresets();
  } catch (error) {
    logError('[MCP] Error getting presets:', error);
    return {};
  }
});

ipcMain.handle('connectors.getStatus', () => {
  return connectorManager.getStatuses();
});

function mcpServerIdsForConnector(connectorId: ConnectorId): string[] {
  if (connectorId === 'slack') return ['mcp-slack-default'];
  if (connectorId === 'google') {
    return ['mcp-gmail-default', 'mcp-google-drive-default', 'mcp-google-calendar-default'];
  }
  return [];
}

async function setConnectorMcpEnabled(connectorId: ConnectorId, enabled: boolean): Promise<void> {
  if (!sessionManager) return;
  for (const serverId of mcpServerIdsForConnector(connectorId)) {
    const config = mcpConfigStore.getServer(serverId);
    if (!config) continue;
    const nextConfig = { ...config, enabled };
    mcpConfigStore.saveServer(nextConfig);
    await sessionManager.getMCPManager().updateServer(nextConfig);
  }
  sessionManager.invalidateMcpServersCache();
}

ipcMain.handle('connectors.connect', async (_event, connectorId: ConnectorId) => {
  try {
    const status = await connectorManager.connect(connectorId);
    await setConnectorMcpEnabled(connectorId, true);
    if (connectorId === 'zoom' && meetingService) {
      meetingService.syncDetectionPolling();
    }
    return { success: true, status };
  } catch (error) {
    logError('[Connectors] Error connecting connector:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
});

ipcMain.handle('connectors.disconnect', async (_event, connectorId: ConnectorId) => {
  try {
    connectorManager.disconnect(connectorId);
    await setConnectorMcpEnabled(connectorId, false);
    if (connectorId === 'zoom' && meetingService) {
      meetingService.syncDetectionPolling();
    }
    return { success: true };
  } catch (error) {
    logError('[Connectors] Error disconnecting connector:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
});

async function handleWelcomeQuickActions(forceRegenerate: boolean) {
  try {
    const mcpManager = sessionManager?.getMCPManager() ?? null;
    const profile = await resolveWelcomeProfile({ mcpManager });
    const connectors = buildWelcomeConnectorSnapshot(mcpManager);
    return await getWelcomeQuickActions({
      profile,
      connectors,
      config: configStore.getAll(),
      forceRegenerate,
    });
  } catch (error) {
    logError('[Welcome] Error getting quick actions:', error);
    const connectors = buildWelcomeConnectorSnapshot(sessionManager?.getMCPManager() ?? null);
    return {
      chips: getStaticFallbackChips(connectors),
      tagline: DEFAULT_WELCOME_TAGLINE,
      source: 'fallback' as const,
      profileSummary: null,
      connectorFingerprint: buildConnectorFingerprint(connectors),
    };
  }
}

ipcMain.handle('welcome.getQuickActions', async () => handleWelcomeQuickActions(false));

ipcMain.handle('welcome.regenerateQuickActions', async () => handleWelcomeQuickActions(true));

// Skills API handlers
ipcMain.handle('skills.getAll', async () => {
  try {
    if (!skillsManager) {
      throw new Error('Skills manager is still starting');
    }
    return await skillsManager.listSkills();
  } catch (error) {
    logError('[Skills] Error getting skills:', error);
    throw error;
  }
});

ipcMain.handle('skills.install', async (_event, skillPath: string) => {
  try {
    if (!skillsManager) {
      throw new Error('SkillsManager not initialized');
    }
    const skill = await skillsManager.installSkill(skillPath);
    sessionManager?.invalidateSkillsSetup();
    return { success: true, skill };
  } catch (error) {
    logError('[Skills] Error installing skill:', error);
    throw error;
  }
});

ipcMain.handle('skills.delete', async (_event, skillId: string) => {
  try {
    if (!skillsManager) {
      throw new Error('SkillsManager not initialized');
    }
    await skillsManager.uninstallSkill(skillId);
    sessionManager?.invalidateSkillsSetup();
    return { success: true };
  } catch (error) {
    logError('[Skills] Error deleting skill:', error);
    throw error;
  }
});

ipcMain.handle('skills.setEnabled', async (_event, skillId: string, enabled: boolean) => {
  try {
    if (!skillsManager) {
      throw new Error('SkillsManager not initialized');
    }
    skillsManager.setSkillEnabled(skillId, enabled);
    sessionManager?.invalidateSkillsSetup();
    return { success: true };
  } catch (error) {
    logError('[Skills] Error toggling skill:', error);
    throw error;
  }
});

ipcMain.handle('skills.validate', async (_event, skillPath: string) => {
  try {
    if (!skillsManager) {
      return { valid: false, errors: ['SkillsManager not initialized'] };
    }
    const result = await skillsManager.validateSkillFolder(skillPath);
    return result;
  } catch (error) {
    logError('[Skills] Error validating skill:', error);
    return { valid: false, errors: ['Validation failed'] };
  }
});

ipcMain.handle('skills.getStoragePath', async () => {
  try {
    if (!skillsManager) {
      return null;
    }
    return skillsManager.getGlobalSkillsPath();
  } catch (error) {
    logError('[Skills] Error getting storage path:', error);
    return null;
  }
});

ipcMain.handle('skills.setStoragePath', async (_event, targetPath: string, migrate = true) => {
  if (!skillsManager) {
    throw new Error('SkillsManager not initialized');
  }
  const result = await skillsManager.setGlobalSkillsPath(targetPath, migrate !== false);
  sendToRenderer({
    type: 'config.status',
    payload: {
      isConfigured: configStore.isConfigured(),
      config: configStore.getAll(),
    },
  });
  return { success: true, ...result };
});

ipcMain.handle('skills.openStoragePath', async () => {
  if (!skillsManager) {
    throw new Error('SkillsManager not initialized');
  }
  const storagePath = skillsManager.getGlobalSkillsPath();
  const openResult = await shell.openPath(storagePath);
  if (openResult) {
    return { success: false, path: storagePath, error: openResult };
  }
  return { success: true, path: storagePath };
});

ipcMain.handle('plugins.listCatalog', async (_event, options?: { installableOnly?: boolean }) => {
  try {
    if (!pluginRuntimeService) {
      throw new Error('PluginRuntimeService not initialized');
    }
    return await pluginRuntimeService.listCatalog(options);
  } catch (error) {
    logError('[Plugins] Error listing catalog:', error);
    throw error;
  }
});

ipcMain.handle('plugins.listInstalled', async () => {
  try {
    if (!pluginRuntimeService) {
      throw new Error('PluginRuntimeService not initialized');
    }
    return pluginRuntimeService.listInstalled();
  } catch (error) {
    logError('[Plugins] Error listing installed plugins:', error);
    throw error;
  }
});

ipcMain.handle('plugins.install', async (_event, pluginName: string) => {
  try {
    if (!pluginRuntimeService) {
      throw new Error('PluginRuntimeService not initialized');
    }
    const result = await pluginRuntimeService.install(pluginName);
    sessionManager?.invalidateSkillsSetup();
    return result;
  } catch (error) {
    logError('[Plugins] Error installing plugin:', error);
    throw error;
  }
});

ipcMain.handle('plugins.setEnabled', async (_event, pluginId: string, enabled: boolean) => {
  try {
    if (!pluginRuntimeService) {
      throw new Error('PluginRuntimeService not initialized');
    }
    const result = await pluginRuntimeService.setEnabled(pluginId, enabled);
    sessionManager?.invalidateSkillsSetup();
    return result;
  } catch (error) {
    logError('[Plugins] Error toggling plugin:', error);
    throw error;
  }
});

ipcMain.handle(
  'plugins.setComponentEnabled',
  async (
    _event,
    pluginId: string,
    component: 'skills' | 'commands' | 'agents' | 'hooks' | 'mcp',
    enabled: boolean
  ) => {
    try {
      if (!pluginRuntimeService) {
        throw new Error('PluginRuntimeService not initialized');
      }
      const result = await pluginRuntimeService.setComponentEnabled(pluginId, component, enabled);
      if (component === 'skills') {
        sessionManager?.invalidateSkillsSetup();
      }
      return result;
    } catch (error) {
      logError('[Plugins] Error toggling plugin component:', error);
      throw error;
    }
  }
);

ipcMain.handle('plugins.uninstall', async (_event, pluginId: string) => {
  try {
    if (!pluginRuntimeService) {
      throw new Error('PluginRuntimeService not initialized');
    }
    const result = await pluginRuntimeService.uninstall(pluginId);
    sessionManager?.invalidateSkillsSetup();
    return result;
  } catch (error) {
    logError('[Plugins] Error uninstalling plugin:', error);
    throw error;
  }
});

ipcMain.handle('hubSkills.list', async () => {
  try {
    if (!skillsManager) {
      throw new Error('SkillsManager not initialized');
    }
    const hubSkills = new HubSkillsLibraryService(skillsManager);
    return await hubSkills.listPublicSkills();
  } catch (error) {
    logError('[HubSkills] Error listing skills:', error);
    throw error;
  }
});

ipcMain.handle('hubSkills.install', async (_event, skillId: string) => {
  try {
    if (!skillsManager) {
      throw new Error('SkillsManager not initialized');
    }
    const hubSkills = new HubSkillsLibraryService(skillsManager);
    const skill = await hubSkills.installSkill(skillId);
    sessionManager?.invalidateSkillsSetup();
    return { success: true, skill };
  } catch (error) {
    logError('[HubSkills] Error installing skill:', error);
    throw error;
  }
});

// Window control IPC handlers
ipcMain.on('window.minimize', () => {
  try {
    mainWindow?.minimize();
  } catch (error) {
    logError('[Window] Error minimizing:', error);
  }
});

ipcMain.on('window.maximize', () => {
  try {
    if (mainWindow?.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow?.maximize();
    }
  } catch (error) {
    logError('[Window] Error maximizing:', error);
  }
});

ipcMain.on('window.close', () => {
  try {
    mainWindow?.close();
  } catch (error) {
    logError('[Window] Error closing:', error);
  }
});

// Sandbox IPC handlers
ipcMain.handle('sandbox.getStatus', async () => {
  try {
    const adapter = getSandboxAdapter();
    const platform = process.platform;

    if (platform === 'win32') {
      const wslStatus = await WSLBridge.checkWSLStatus();
      return {
        platform: 'win32',
        mode: adapter.initialized ? adapter.mode : 'none',
        initialized: adapter.initialized,
        wsl: wslStatus,
        lima: null,
      };
    } else if (platform === 'darwin') {
      const limaStatus = await LimaBridge.checkLimaStatus();
      return {
        platform: 'darwin',
        mode: adapter.initialized ? adapter.mode : 'native',
        initialized: adapter.initialized,
        wsl: null,
        lima: limaStatus,
      };
    } else {
      return {
        platform,
        mode: adapter.initialized ? adapter.mode : 'native',
        initialized: adapter.initialized,
        wsl: null,
        lima: null,
      };
    }
  } catch (error) {
    logError('[Sandbox] Error getting status:', error);
    return {
      platform: process.platform,
      mode: 'none',
      initialized: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
});

// WSL IPC handlers (Windows)
ipcMain.handle('sandbox.checkWSL', async () => {
  try {
    return await WSLBridge.checkWSLStatus();
  } catch (error) {
    logError('[Sandbox] Error checking WSL:', error);
    return { available: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
});

ipcMain.handle('sandbox.installNodeInWSL', async (_event, distro: string) => {
  try {
    return await WSLBridge.installNodeInWSL(distro);
  } catch (error) {
    logError('[Sandbox] Error installing Node.js:', error);
    return false;
  }
});

ipcMain.handle('sandbox.installPythonInWSL', async (_event, distro: string) => {
  try {
    return await WSLBridge.installPythonInWSL(distro);
  } catch (error) {
    logError('[Sandbox] Error installing Python:', error);
    return false;
  }
});

// Lima IPC handlers (macOS)
ipcMain.handle('sandbox.checkLima', async () => {
  try {
    return await LimaBridge.checkLimaStatus();
  } catch (error) {
    logError('[Sandbox] Error checking Lima:', error);
    return { available: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
});

ipcMain.handle('sandbox.createLimaInstance', async () => {
  try {
    return await LimaBridge.createLimaInstance();
  } catch (error) {
    logError('[Sandbox] Error creating Lima instance:', error);
    return false;
  }
});

ipcMain.handle('sandbox.startLimaInstance', async () => {
  try {
    return await LimaBridge.startLimaInstance();
  } catch (error) {
    logError('[Sandbox] Error starting Lima instance:', error);
    return false;
  }
});

ipcMain.handle('sandbox.stopLimaInstance', async () => {
  try {
    return await LimaBridge.stopLimaInstance();
  } catch (error) {
    logError('[Sandbox] Error stopping Lima instance:', error);
    return false;
  }
});

ipcMain.handle('sandbox.installNodeInLima', async () => {
  try {
    return await LimaBridge.installNodeInLima();
  } catch (error) {
    logError('[Sandbox] Error installing Node.js in Lima:', error);
    return false;
  }
});

ipcMain.handle('sandbox.installPythonInLima', async () => {
  try {
    return await LimaBridge.installPythonInLima();
  } catch (error) {
    logError('[Sandbox] Error installing Python in Lima:', error);
    return false;
  }
});

// Logs IPC handlers
ipcMain.handle('logs.getPath', () => {
  try {
    return getLogFilePath();
  } catch (error) {
    logError('[Logs] Error getting log path:', error);
    return null;
  }
});

ipcMain.handle('logs.getDirectory', () => {
  try {
    return getLogsDirectory();
  } catch (error) {
    logError('[Logs] Error getting logs directory:', error);
    return null;
  }
});

ipcMain.handle('logs.getAll', () => {
  try {
    return getAllLogFiles();
  } catch (error) {
    logError('[Logs] Error getting all log files:', error);
    return [];
  }
});

ipcMain.handle('logs.export', async () => {
  try {
    const logFiles = getAllLogFiles();
    const diagnosticsSummary = buildDiagnosticsSummary({
      app: {
        version: app.getVersion(),
        isPackaged: app.isPackaged,
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.version,
        electronVersion: process.versions.electron,
        chromeVersion: process.versions.chrome,
      },
      runtime: {
        currentWorkingDir,
        logsDirectory: getLogsDirectory(),
        logFileCount: logFiles.length,
        totalLogSizeBytes: logFiles.reduce((total, file) => total + file.size, 0),
        devLogsEnabled: isDevLogsEnabled(),
      },
      config: {
        provider: configStore.get('provider'),
        model: configStore.get('model'),
        baseUrl: sanitizeDiagnosticBaseUrl(configStore.get('baseUrl') || undefined),
        customProtocol: configStore.get('customProtocol') || null,
        sandboxEnabled: !!configStore.get('sandboxEnabled'),
        thinkingEnabled: !!configStore.get('enableThinking'),
        apiKeyConfigured: !!configStore.get('apiKey'),
        agentCliPathConfigured: !!configStore.get('agentCliPath'),
        defaultWorkdir: configStore.get('defaultWorkdir') || null,
        globalSkillsPathConfigured: !!configStore.get('globalSkillsPath'),
      },
      sandbox: {
        mode: getSandboxAdapter().mode,
        initialized: getSandboxAdapter().initialized,
      },
      sessions: sessionManager ? sessionManager.listSessions() : [],
      logFiles,
      deps: {
        getMessages: (sessionId: string) =>
          sessionManager ? sessionManager.getMessages(sessionId) : [],
        getTraceSteps: (sessionId: string) =>
          sessionManager ? sessionManager.getTraceSteps(sessionId) : [],
      },
    });

    // Show save dialog
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: 'Export Logs',
      defaultPath: `york-ie-logs-${new Date().toISOString().split('T')[0]}.zip`,
      filters: [
        { name: 'ZIP Archive', extensions: ['zip'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });

    if (result.canceled || !result.filePath) {
      return { success: false, error: 'User cancelled' };
    }

    // Dynamic import archiver
    const archiver = await import('archiver');
    const output = fs.createWriteStream(result.filePath);
    const archive = archiver.default('zip', { zlib: { level: 9 } });

    return new Promise((resolve) => {
      let settled = false;
      const settle = (value: {
        success: boolean;
        path?: string;
        size?: number;
        error?: string;
      }) => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(value);
      };

      output.on('close', () => {
        log('[Logs] Exported logs to:', result.filePath);
        settle({
          success: true,
          path: result.filePath,
          size: archive.pointer(),
        });
      });

      output.on('error', (err: Error) => {
        logError('[Logs] Error writing exported archive:', err);
        settle({ success: false, error: err.message });
      });

      archive.on('error', (err: Error) => {
        logError('[Logs] Error creating archive:', err);
        settle({ success: false, error: err.message });
      });

      archive.pipe(output);

      // Add all log files
      for (const logFile of logFiles) {
        archive.file(logFile.path, { name: logFile.name });
      }

      // Add system info
      const systemInfo = {
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.version,
        electronVersion: process.versions.electron,
        appVersion: app.getVersion(),
        exportDate: new Date().toISOString(),
        logFiles: logFiles.map((f) => ({
          name: f.name,
          size: f.size,
          modified: f.mtime,
        })),
      };
      archive.append(JSON.stringify(systemInfo, null, 2), { name: 'system-info.json' });
      archive.append(JSON.stringify(diagnosticsSummary, null, 2), {
        name: 'diagnostics-summary.json',
      });
      archive.append(
        [
          'York IE VECOS diagnostic bundle',
          `Exported at: ${diagnosticsSummary.exportedAt}`,
          '',
          'Included files:',
          '- Application log files (*.log)',
          '- system-info.json',
          '- diagnostics-summary.json',
          '',
          'diagnostics-summary.json contains a redacted runtime/config snapshot,',
          'plus metadata-only session summaries and recent error traces to speed up debugging.',
        ].join('\n'),
        { name: 'README.txt' }
      );

      archive.finalize();
    });
  } catch (error) {
    logError('[Logs] Error exporting logs:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
});

ipcMain.handle('logs.open', async () => {
  try {
    const logsDir = getLogsDirectory();
    await shell.openPath(logsDir);
    return { success: true };
  } catch (error) {
    logError('[Logs] Error opening logs directory:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
});

ipcMain.handle('logs.clear', async () => {
  try {
    const logFiles = getAllLogFiles();

    // Close current log file
    closeLogFile();

    // Delete all log files
    for (const logFile of logFiles) {
      try {
        fs.unlinkSync(logFile.path);
        log('[Logs] Deleted log file:', logFile.name);
      } catch (err) {
        logError('[Logs] Failed to delete log file:', logFile.name, err);
      }
    }

    // Log will automatically reinitialize on next log call
    log('[Logs] Log files cleared and reinitialized');

    return { success: true, deletedCount: logFiles.length };
  } catch (error) {
    logError('[Logs] Error clearing logs:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
});

ipcMain.handle('logs.setEnabled', async (_event, enabled: boolean) => {
  try {
    setDevLogsEnabled(enabled);
    configStore.set('enableDevLogs', enabled);
    log('[Logs] Developer logs', enabled ? 'enabled' : 'disabled');
    return { success: true, enabled };
  } catch (error) {
    logError('[Logs] Error setting dev logs enabled:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
});

ipcMain.handle('logs.isEnabled', () => {
  try {
    return { success: true, enabled: isDevLogsEnabled() };
  } catch (error) {
    logError('[Logs] Error getting dev logs enabled:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
});

// ============================================================================
// Remote control IPC handlers
// ============================================================================

ipcMain.handle('remote.getConfig', () => {
  try {
    return remoteConfigStore.getAll();
  } catch (error) {
    logError('[Remote] Error getting config:', error);
    return null;
  }
});

ipcMain.handle('remote.getStatus', () => {
  try {
    return remoteManager.getStatus();
  } catch (error) {
    logError('[Remote] Error getting status:', error);
    return { running: false, channels: [], activeSessions: 0, pendingPairings: 0 };
  }
});

ipcMain.handle('remote.setEnabled', async (_event, enabled: boolean) => {
  try {
    remoteConfigStore.setEnabled(enabled);

    if (enabled) {
      await remoteManager.start();
    } else {
      await remoteManager.stop();
    }

    return { success: true };
  } catch (error) {
    logError('[Remote] Error setting enabled:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
});

ipcMain.handle('remote.updateGatewayConfig', async (_event, config: Partial<GatewayConfig>) => {
  try {
    await remoteManager.updateGatewayConfig(config);
    return { success: true };
  } catch (error) {
    logError('[Remote] Error updating gateway config:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
});

ipcMain.handle('remote.updateFeishuConfig', async (_event, config: FeishuChannelConfig) => {
  try {
    await remoteManager.updateFeishuConfig(config);
    return { success: true };
  } catch (error) {
    logError('[Remote] Error updating Feishu config:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
});

ipcMain.handle('remote.getPairedUsers', () => {
  try {
    return remoteManager.getPairedUsers();
  } catch (error) {
    logError('[Remote] Error getting paired users:', error);
    return [];
  }
});

ipcMain.handle('remote.getPendingPairings', () => {
  try {
    return remoteManager.getPendingPairings();
  } catch (error) {
    logError('[Remote] Error getting pending pairings:', error);
    return [];
  }
});

ipcMain.handle('remote.approvePairing', (_event, channelType: ChannelType, userId: string) => {
  try {
    const success = remoteManager.approvePairing(channelType, userId);
    return { success };
  } catch (error) {
    logError('[Remote] Error approving pairing:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
});

ipcMain.handle('remote.revokePairing', (_event, channelType: ChannelType, userId: string) => {
  try {
    const success = remoteManager.revokePairing(channelType, userId);
    return { success };
  } catch (error) {
    logError('[Remote] Error revoking pairing:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
});

ipcMain.handle('remote.rejectPairing', (_event, channelType: ChannelType, userId: string) => {
  try {
    const success = remoteManager.rejectPairing(channelType, userId);
    return { success };
  } catch (error) {
    logError('[Remote] Error rejecting pairing:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
});

ipcMain.handle('remote.getRemoteSessions', () => {
  try {
    return remoteManager.getRemoteSessions();
  } catch (error) {
    logError('[Remote] Error getting remote sessions:', error);
    return [];
  }
});

ipcMain.handle('remote.clearRemoteSession', (_event, sessionId: string) => {
  try {
    const success = remoteManager.clearRemoteSession(sessionId);
    return { success };
  } catch (error) {
    logError('[Remote] Error clearing remote session:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
});

ipcMain.handle('remote.getTunnelStatus', () => {
  try {
    return remoteManager.getTunnelStatus();
  } catch (error) {
    logError('[Remote] Error getting tunnel status:', error);
    return { connected: false, url: null, provider: 'none' };
  }
});

ipcMain.handle('remote.getWebhookUrl', () => {
  try {
    return remoteManager.getFeishuWebhookUrl();
  } catch (error) {
    logError('[Remote] Error getting webhook URL:', error);
    return null;
  }
});

ipcMain.handle('remote.restart', async () => {
  try {
    await remoteManager.restart();
    return { success: true };
  } catch (error) {
    logError('[Remote] Error restarting:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
});

ipcMain.handle('schedule.list', () => {
  try {
    if (!scheduledTaskManager) return [];
    return scheduledTaskManager.list();
  } catch (error) {
    logError('[Schedule] Error listing tasks:', error);
    return [];
  }
});

ipcMain.handle('schedule.create', async (_event, payload: ScheduledTaskCreateInput) => {
  if (!scheduledTaskManager) {
    throw new Error('Scheduled task manager not initialized');
  }
  const unsupportedReason = getWorkspacePathUnsupportedReason(payload.cwd);
  if (unsupportedReason) {
    throw new Error(unsupportedReason);
  }
  const normalizedPrompt = payload.prompt.trim();
  const title = await resolveScheduledTaskTitle(normalizedPrompt, payload.cwd, payload.title);
  return scheduledTaskManager.create({
    ...payload,
    prompt: normalizedPrompt,
    title,
  });
});

ipcMain.handle('schedule.update', async (_event, id: string, updates: ScheduledTaskUpdateInput) => {
  if (!scheduledTaskManager) {
    throw new Error('Scheduled task manager not initialized');
  }
  const existing = scheduledTaskManager.get(id);
  if (!existing) return null;
  const nextCwd = updates.cwd ?? existing.cwd;
  const unsupportedReason = getWorkspacePathUnsupportedReason(nextCwd);
  if (unsupportedReason) {
    throw new Error(unsupportedReason);
  }
  const normalizedPrompt = updates.prompt === undefined ? existing.prompt : updates.prompt.trim();
  const normalizedUpdates: ScheduledTaskUpdateInput = {
    ...updates,
    prompt: normalizedPrompt,
  };

  if (updates.prompt !== undefined) {
    normalizedUpdates.title = await resolveScheduledTaskTitle(
      normalizedPrompt,
      updates.cwd ?? existing.cwd,
      updates.title ?? existing.title
    );
  } else if (updates.title !== undefined) {
    normalizedUpdates.title = buildScheduledTaskTitle(updates.title);
  }

  return scheduledTaskManager.update(id, normalizedUpdates);
});

ipcMain.handle('schedule.delete', (_event, id: string) => {
  if (!scheduledTaskManager) {
    throw new Error('Scheduled task manager not initialized');
  }
  return { success: scheduledTaskManager.delete(id) };
});

ipcMain.handle('schedule.toggle', (_event, id: string, enabled: boolean) => {
  if (!scheduledTaskManager) {
    throw new Error('Scheduled task manager not initialized');
  }
  return scheduledTaskManager.toggle(id, enabled);
});

ipcMain.handle('schedule.runNow', async (_event, id: string) => {
  if (!scheduledTaskManager) {
    throw new Error('Scheduled task manager not initialized');
  }
  return scheduledTaskManager.runNow(id);
});

ipcMain.handle('loop.start', (_event, payload: ChatLoopStartInput) => {
  if (!chatLoopManager) {
    throw new Error('Chat loop manager not initialized');
  }
  if (!payload?.sessionId || !payload.prompt?.trim()) {
    throw new Error('sessionId and prompt are required');
  }
  return chatLoopManager.start({
    sessionId: payload.sessionId,
    kind: payload.kind === 'goal' ? 'goal' : 'interval',
    prompt: payload.prompt.trim(),
    intervalMs: payload.intervalMs,
    maxIterations: payload.maxIterations,
    runImmediately: payload.runImmediately,
  });
});

ipcMain.handle('loop.stop', (_event, sessionId: string) => {
  if (!chatLoopManager) {
    throw new Error('Chat loop manager not initialized');
  }
  return chatLoopManager.stop(sessionId, 'user_stop');
});

ipcMain.handle('loop.status', (_event, sessionId: string) => {
  if (!chatLoopManager) return null;
  return chatLoopManager.status(sessionId);
});

ipcMain.handle('loop.list', () => {
  if (!chatLoopManager) return [];
  return chatLoopManager.list();
});

ipcMain.handle('memory.getOverview', (_event, cwd?: string) => {
  if (!memoryService) {
    throw new Error('Memory service not initialized');
  }
  return memoryService.getOverview(cwd);
});

ipcMain.handle(
  'memory.search',
  (
    _event,
    payload: {
      query: string;
      cwd?: string;
      sourceWorkspace?: string | null;
      scope?: 'workspace' | 'global' | 'all';
      limit?: number;
    }
  ) => {
    if (!memoryService) {
      throw new Error('Memory service not initialized');
    }
    return memoryService.search(payload);
  }
);

ipcMain.handle('memory.read', (_event, id: string) => {
  if (!memoryService) {
    throw new Error('Memory service not initialized');
  }
  return memoryService.read(id);
});

ipcMain.handle('memory.rebuildWorkspace', async (_event, cwd: string) => {
  if (!memoryService) {
    throw new Error('Memory service not initialized');
  }
  return memoryService.rebuildWorkspace(cwd);
});

ipcMain.handle('memory.clearWorkspace', (_event, cwd: string) => {
  if (!memoryService) {
    throw new Error('Memory service not initialized');
  }
  return memoryService.clearWorkspace(cwd);
});

ipcMain.handle('memory.clearCoreMemory', () => {
  if (!memoryService) {
    throw new Error('Memory service not initialized');
  }
  return memoryService.clearCoreMemory();
});

ipcMain.handle('memory.rebuildAll', async () => {
  if (!memoryService) {
    throw new Error('Memory service not initialized');
  }
  return memoryService.rebuildAll();
});

ipcMain.handle('memory.listFiles', () => {
  if (!memoryService) {
    throw new Error('Memory service not initialized');
  }
  return memoryService.listFiles();
});

ipcMain.handle('memory.readFile', (_event, filePath: string) => {
  if (!memoryService) {
    throw new Error('Memory service not initialized');
  }
  return memoryService.readFile(filePath);
});

ipcMain.handle('memory.inspectSession', (_event, sessionId: string, workspaceKey?: string) => {
  if (!memoryService) {
    throw new Error('Memory service not initialized');
  }
  return memoryService.inspectSession(sessionId, workspaceKey);
});

ipcMain.handle('memory.setEnabled', (_event, enabled: boolean) => {
  if (!memoryService) {
    throw new Error('Memory service not initialized');
  }
  const result = memoryService.setEnabled(enabled);
  sessionManager?.clearAllCachedAgentSessions();
  sendToRenderer({
    type: 'config.status',
    payload: {
      isConfigured: configStore.isConfigured(),
      config: configStore.getAll(),
    },
  });
  return result;
});

ipcMain.handle('meetings.getOverview', async () => {
  if (!meetingService) {
    throw new Error('Meeting service not initialized');
  }
  return meetingService.getOverview();
});

ipcMain.handle('meetings.setEnabled', (_event, enabled: boolean) => {
  if (!meetingService) {
    throw new Error('Meeting service not initialized');
  }
  const result = meetingService.setEnabled(enabled);
  sendToRenderer({
    type: 'config.status',
    payload: {
      isConfigured: configStore.isConfigured(),
      config: configStore.getAll(),
    },
  });
  return result;
});

ipcMain.handle('meetings.start', async (_event, title?: string) => {
  if (!meetingService) {
    throw new Error('Meeting service not initialized');
  }
  return meetingService.start(title);
});

ipcMain.handle('meetings.stop', async () => {
  if (!meetingService) {
    throw new Error('Meeting service not initialized');
  }
  return meetingService.stop();
});

ipcMain.handle('meetings.getStatus', () => {
  if (!meetingService) {
    throw new Error('Meeting service not initialized');
  }
  return meetingService.getCaptureStatus();
});

ipcMain.handle(
  'meetings.appendChunk',
  async (
    _event,
    payload: {
      meetingId: string;
      data: ArrayBuffer | Uint8Array;
      mimeType?: string;
      rms?: number;
    }
  ) => {
    if (!meetingService) {
      throw new Error('Meeting service not initialized');
    }
    return meetingService.appendChunk(payload);
  }
);

ipcMain.handle('meetings.list', () => {
  if (!meetingService) {
    throw new Error('Meeting service not initialized');
  }
  return meetingService.list();
});

ipcMain.handle('meetings.get', (_event, id: string) => {
  if (!meetingService) {
    throw new Error('Meeting service not initialized');
  }
  return meetingService.get(id);
});

ipcMain.handle('meetings.search', (_event, query: string, limit?: number) => {
  if (!meetingService) {
    throw new Error('Meeting service not initialized');
  }
  return meetingService.search(query, limit);
});

ipcMain.handle('meetings.delete', (_event, id: string) => {
  if (!meetingService) {
    throw new Error('Meeting service not initialized');
  }
  return meetingService.delete(id);
});

ipcMain.handle('meetings.clearAll', () => {
  if (!meetingService) {
    throw new Error('Meeting service not initialized');
  }
  return meetingService.clearAll();
});

ipcMain.handle('meetings.requestMicrophoneAccess', async () => {
  if (!meetingService) {
    throw new Error('Meeting service not initialized');
  }
  return requestMeetingCapturePermissions();
});

ipcMain.handle('meetings.requestCapturePermissions', async () => {
  if (!meetingService) {
    throw new Error('Meeting service not initialized');
  }
  return requestMeetingCapturePermissions();
});

async function requestMeetingCapturePermissions(): Promise<{
  permissions: ReturnType<MeetingService['getPermissions']>;
  requestedMicrophone: boolean;
  requestedScreen: boolean;
}> {
  if (!meetingService) {
    throw new Error('Meeting service not initialized');
  }
  return meetingService.requestCapturePermissions();
}

ipcMain.handle('meetings.getPermissions', () => {
  if (!meetingService) {
    throw new Error('Meeting service not initialized');
  }
  return meetingService.getPermissions();
});

ipcMain.handle('meetings.autoStartResult', (_event, result: { ok: boolean; error?: string }) => {
  if (!meetingService) {
    return { success: false };
  }
  meetingService.reportAutoStartResult({
    ok: Boolean(result?.ok),
    error: typeof result?.error === 'string' ? result.error : undefined,
  });
  return { success: true };
});

ipcMain.handle('logs.write', (_event, level: 'info' | 'warn' | 'error', args: unknown[]) => {
  try {
    if (level === 'warn') {
      logWarn(...args);
    } else if (level === 'error') {
      logError(...args);
    } else {
      log(...args);
    }
    return { success: true };
  } catch (error) {
    console.error('[Logs] Error writing log:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
});

ipcMain.handle('sandbox.retryLimaSetup', async () => {
  if (process.platform !== 'darwin') {
    return { success: false, error: 'Lima is only available on macOS' };
  }

  try {
    const bootstrap = getSandboxBootstrap();
    bootstrap.setProgressCallback((progress) => {
      sendToRenderer({
        type: 'sandbox.progress',
        payload: progress,
      });
    });

    try {
      await LimaBridge.stopLimaInstance();
    } catch (error) {
      logError('[Sandbox] Error stopping Lima before retry:', error);
    }

    bootstrap.reset();
    const result = await bootstrap.bootstrap();
    const success = !result.error;
    return { success, result, error: result.error };
  } catch (error) {
    logError('[Sandbox] Error retrying Lima setup:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
});

// Generic retry setup for both WSL and Lima
ipcMain.handle('sandbox.retrySetup', async () => {
  try {
    const bootstrap = getSandboxBootstrap();
    bootstrap.setProgressCallback((progress) => {
      sendToRenderer({
        type: 'sandbox.progress',
        payload: progress,
      });
    });

    // Reset and re-run bootstrap
    bootstrap.reset();
    const result = await bootstrap.bootstrap();
    const success = !result.error;
    return { success, result, error: result.error };
  } catch (error) {
    logError('[Sandbox] Error retrying setup:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
});

async function handleClientEvent(event: ClientEvent): Promise<unknown> {
  await ensureAuthenticatedSession();

  // Check if configured before starting sessions
  if (event.type === 'session.start' && !configStore.hasUsableCredentialsForActiveSet()) {
    sendToRenderer({
      type: 'error',
      payload: {
        message: 'No model is configured. Please select a model before starting a session.',
        code: 'CONFIG_REQUIRED_ACTIVE_SET',
      },
    });
    return null;
  }

  if (eventRequiresSessionManager(event) && !sessionManager) {
    throw new Error('Session manager not initialized');
  }
  // After the guard above, sessionManager is guaranteed non-null for session.* events.
  // Use a local alias to satisfy TypeScript's control-flow narrowing.
  const sm = sessionManager!;

  switch (event.type) {
    case 'session.start':
      if (getWorkspacePathUnsupportedReason(event.payload.cwd)) {
        sendToRenderer({
          type: 'error',
          payload: {
            message: getWorkspacePathUnsupportedReason(event.payload.cwd)!,
          },
        });
        return null;
      }
      return sm.startSession(
        event.payload.title,
        event.payload.prompt,
        event.payload.cwd,
        event.payload.allowedTools,
        event.payload.content,
        event.payload.memoryEnabled,
        {
          division: event.payload.division,
          hubProjectId: event.payload.hubProjectId,
          hubProjectName: event.payload.hubProjectName,
        }
      );

    case 'session.continue':
      return sm.continueSession(
        event.payload.sessionId,
        event.payload.prompt,
        event.payload.content
      );

    case 'session.stop':
      return sm.stopSession(event.payload.sessionId);

    case 'session.delete':
      chatLoopManager?.stop(event.payload.sessionId, 'session_deleted');
      return sm.deleteSession(event.payload.sessionId);

    case 'session.batchDelete':
      for (const sessionId of event.payload.sessionIds) {
        chatLoopManager?.stop(sessionId, 'session_deleted');
      }
      return sm.batchDeleteSessions(event.payload.sessionIds);

    case 'session.list': {
      const sessions = sm.listSessions();
      sendToRenderer({ type: 'session.list', payload: { sessions } });
      return sessions;
    }

    case 'session.getMessages':
      return sm.getMessages(event.payload.sessionId);

    case 'session.getTraceSteps':
      return sm.getTraceSteps(event.payload.sessionId);

    case 'session.compact':
      return sm.compactSession(event.payload.sessionId, event.payload.customInstructions);

    case 'session.getContextUsage':
      return sm.getContextUsage(event.payload.sessionId);

    case 'permission.response':
      return sm.handlePermissionResponse(event.payload.toolUseId, event.payload.result);

    case 'question.response':
      return sm.handleQuestionResponse(event.payload.questionId, event.payload.answer);

    case 'sudo.password.response':
      return sm.handleSudoPasswordResponse(event.payload.toolUseId, event.payload.password);

    case 'folder.select': {
      const folderResult = await dialog.showOpenDialog(mainWindow!, {
        properties: ['openDirectory'],
      });
      if (!folderResult.canceled && folderResult.filePaths.length > 0) {
        sendToRenderer({
          type: 'folder.selected',
          payload: { path: folderResult.filePaths[0] },
        });
        return folderResult.filePaths[0];
      }
      return null;
    }

    case 'workdir.get':
      return getWorkingDir();

    case 'workdir.set':
      return setWorkingDir(event.payload.path, event.payload.sessionId);

    case 'workdir.select': {
      const dialogDefaultPath =
        event.payload.currentPath && isAbsolute(event.payload.currentPath)
          ? event.payload.currentPath
          : currentWorkingDir || undefined;
      const workdirResult = await dialog.showOpenDialog(mainWindow!, {
        properties: ['openDirectory'],
        title: 'Select Working Directory',
        defaultPath: dialogDefaultPath,
      });
      if (!workdirResult.canceled && workdirResult.filePaths.length > 0) {
        const selectedPath = workdirResult.filePaths[0];
        return setWorkingDir(selectedPath, event.payload.sessionId);
      }
      return { success: false, path: '', error: 'User cancelled' };
    }

    case 'settings.update':
      if (
        event.payload.theme === 'dark' ||
        event.payload.theme === 'light' ||
        event.payload.theme === 'system'
      ) {
        const nextTheme = event.payload.theme as AppTheme;
        configStore.update({ theme: nextTheme });
        applyNativeThemePreference(nextTheme);
        if (mainWindow && !mainWindow.isDestroyed()) {
          const effectiveTheme = resolveEffectiveTheme(nextTheme);
          mainWindow.setBackgroundColor(effectiveTheme === 'dark' ? DARK_BG : LIGHT_BG);
        }
        sendToRenderer({
          type: 'config.status',
          payload: {
            isConfigured: configStore.isConfigured(),
            config: configStore.getAll(),
          },
        });
      }

      if (Array.isArray((event.payload as { permissionRules?: unknown }).permissionRules)) {
        setPermissionRules(
          (event.payload as { permissionRules: PermissionRule[] }).permissionRules
        );
      }
      return null;

    default:
      logWarn('Unknown event type:', event);
      return null;
  }
}
