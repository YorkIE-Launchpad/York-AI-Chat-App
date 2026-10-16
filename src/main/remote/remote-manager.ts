/**
 * Remote Manager
 * Manages the remote control system, integrating Gateway, Channels, and MessageRouter
 */

import { EventEmitter } from 'events';
import { randomBytes } from 'crypto';
import { log, logError, logWarn } from '../utils/logger';
import { v4 as uuidv4 } from 'uuid';
import { RemoteGateway } from './gateway';
import { MessageRouter } from './message-router';
import { FeishuChannel } from './channels/feishu';
import { SlackChannel } from './channels/slack';
import {
  SLACK_RELAY_CHANNEL_ID,
  SlackRelayChannel,
  slackRelayReplyHandleOf,
} from './channels/slack/slack-relay-channel';
import {
  SLACK_RELAY_PICKER_MAX_ITEMS,
  SLACK_RELAY_QUESTION_LIMITS,
  SLACK_RELAY_SLASH_COMMAND,
  type SlackRelayAction,
  type SlackRelayPickerKind,
  type SlackRelayChatEntry,
  type SlackRelayCommandName,
} from './channels/slack/slack-relay-protocol';
import {
  formatAnswerFooter,
  formatUpdatedLabel,
  slackRelayHelpText,
  parseSlackTextCommand,
  slackStatusLabelForTool,
  summarizeToolInput,
} from './channels/slack/slack-relay-format';
import { StdioChannel } from './channels/stdio-channel';
import { remoteConfigStore } from './remote-config-store';
import { tunnelManager, TunnelStatus } from './tunnel-manager';
import { buildRemoteSessionTitle } from './remote-title';
import {
  PERMISSION_ASK_TIMEOUT_MS,
  PERMISSION_AUTO_APPROVE_MS,
} from '../../shared/permission-policy';
import { SessionNotFoundError } from '../session/session-errors';
import type {
  GatewayStatus,
  GatewayConfig,
  FeishuChannelConfig,
  ChannelType,
  RemoteMessage,
  RemoteSessionMapping,
  PairedUser,
  PairingRequest,
  RemoteConfig,
  SlackRelayConnectionEvent,
  SlackRelayStatus,
} from './types';
import { DEFAULT_SLACK_RELAY_IDLE_TIMEOUT_HOURS } from './types';
import type { Message, ContentBlock, ServerEvent, Session } from '../../renderer/types/index';
import {
  isAutoAllowedWikiTool,
  isStrictRemoteSession,
  markStrictRemoteSession,
} from '../config/permission-rules-store';
import { getFeishuWebhookConfigError } from '../../shared/feishu-webhook-config';
import type { BackendModelInfo } from '../../shared/backend-config';
import type { UnifiedCompanyProject } from '../../shared/unified-company-projects';
import type { ActiveDivision, PersonalFolder } from '../../shared/workspace-division';
import {
  buildModelChoices,
  buildWorkspaceChoices,
  describeModel,
  describeWorkspace,
  matchChoices,
  workspaceKey,
  type SlackRelayChoice,
} from './channels/slack/slack-relay-choices';

/** Credentials and hooks the Slack relay needs from the main process. */
export interface SlackRelayProvider {
  isSlackConnected(): boolean;
  /** Slack user id of the account that connected the Slack integration. */
  getSlackUserId(): string | null;
  getSlackUserToken(): Promise<string>;
  /** Cognito id-token Authorization plus client version headers. */
  getUpgradeHeaders(): Promise<Record<string, string>>;
  /** Folders a remote session may switch into. */
  getAllowedRoots(): string[];
  notify(title: string, body: string): void;
  /** Chat model catalog, as in the desktop model picker. */
  listModels?(): Promise<BackendModelInfo[]>;
  /** The app-wide model id. */
  getCurrentModel?(): string | undefined;
  /** Display name for models outside the catalog (e.g. York LLM). */
  getCurrentModelLabel?(): string | undefined;
  /** Switch the app-wide model; returns an error message on failure. */
  selectModel?(modelId: string): Promise<string | null>;
  /** Folders and company projects for the workspace picker. */
  listWorkspaceSources?(): Promise<{
    folders: PersonalFolder[];
    projects: UnifiedCompanyProject[];
    error?: string;
  }>;
}

const SLACK_RELAY_IDLE_CHECK_MS = 5 * 60_000;
const STRICT_PERMISSION_INPUT_PREVIEW_MAX = 1_500;
const SLACK_CHAT_LIST_SIZE = 8;
const REMOTE_QUESTION_TIMEOUT_MS = 5 * 60 * 1000;
const SLACK_CHAT_TOKEN_TTL_MS = 15 * 60_000;

function opaqueId(): string {
  return randomBytes(18).toString('base64url');
}

/** One Slack-originated turn: where its status, approvals and answer go. */
interface SlackTurn {
  handle: string;
  label: string | null;
}

// Agent executor interface - exported for use in main process
export interface AgentExecutor {
  startSession(
    title: string,
    prompt: string,
    cwd?: string,
    options?: { strictRemote?: boolean; content?: ContentBlock[]; workspace?: ActiveDivision }
  ): Promise<Session>;
  continueSession(
    sessionId: string,
    prompt: string,
    content?: ContentBlock[],
    cwd?: string
  ): Promise<void>;
  stopSession(sessionId: string): Promise<void>;
  validateWorkingDirectory?(cwd: string): Promise<string | null> | string | null;
  /**
   * Optional existence probe for stale-binding detection: a channel binding may
   * outlive its actual session (deleted from the desktop UI). When provided,
   * executeAgent rebinds proactively instead of failing a turn first.
   */
  hasSession?(sessionId: string): boolean;
  /** Desktop chats, for the Slack chat picker. */
  listSessions?(): Session[];
  getSession?(sessionId: string): Session | null | undefined;
}

// Question/Permission request from agent
export interface RemoteInteraction {
  type: 'question' | 'permission';
  sessionId: string; // Actual session ID
  remoteSessionId: string; // Remote session ID (for routing back)
  ownerSenderId: string; // Sender ID of the session owner (for security verification)
  questionId?: string;
  toolUseId?: string;
  toolName?: string;
  questions?: Array<{
    question: string;
    header?: string;
    options?: Array<{ label: string; description?: string; recommended?: boolean }>;
    multiSelect?: boolean;
  }>;
  input?: Record<string, unknown>;
  createdAt: number;
  expiresAt: number;
}

type RemoteQuestionOption = {
  label: string;
  description?: string;
  recommended?: boolean;
};

type RemoteQuestionItem = {
  question: string;
  header?: string;
  options?: RemoteQuestionOption[];
  multiSelect?: boolean;
};

/**
 * Parse remote channel replies for AskUserQuestion.
 * Multi-question forms expect `Q1: A` / `Q1: 1,3` lines.
 * Single-question forms still accept bare `A` / `1` / free text.
 */
export function parseRemoteQuestionResponse(
  messageText: string,
  questions: RemoteQuestionItem[]
): string {
  const trimmed = messageText.trim();
  if (trimmed.toLowerCase() === 'skip') {
    return '{}';
  }

  const answers: Record<number, string[]> = {};
  const qLinePattern = /Q(\d+)\s*[:-]\s*(.+)/gi;
  const qLines = new Map<number, string>();
  let match: RegExpExecArray | null;
  while ((match = qLinePattern.exec(trimmed)) !== null) {
    const qNum = Number.parseInt(match[1], 10);
    if (Number.isFinite(qNum) && qNum >= 1) {
      qLines.set(qNum - 1, match[2].trim());
    }
  }

  const resolveOptionTokens = (
    tokenText: string,
    options: RemoteQuestionOption[],
    multiSelect: boolean
  ): string[] => {
    const tokens = tokenText
      .split(/[,\s]+/)
      .map((t) => t.trim())
      .filter(Boolean);
    const selected: string[] = [];

    for (const token of tokens) {
      const upper = token.toUpperCase();
      // Letter like A / B
      if (/^[A-Z]$/.test(upper)) {
        const idx = upper.charCodeAt(0) - 65;
        if (idx >= 0 && idx < options.length) {
          selected.push(options[idx].label);
          if (!multiSelect) {
            break;
          }
          continue;
        }
      }
      // Number like 1 / 2
      if (/^\d+$/.test(token)) {
        const idx = Number.parseInt(token, 10) - 1;
        if (idx >= 0 && idx < options.length) {
          selected.push(options[idx].label);
          if (!multiSelect) {
            break;
          }
          continue;
        }
      }
      // Exact label match (case-insensitive)
      const byLabel = options.find((o) => o.label.toLowerCase() === token.toLowerCase());
      if (byLabel) {
        selected.push(byLabel.label);
        if (!multiSelect) {
          break;
        }
      }
    }

    return multiSelect ? selected : selected.slice(0, 1);
  };

  questions.forEach((q, qIdx) => {
    const perQuestion = qLines.get(qIdx);
    const source =
      perQuestion ??
      (questions.length === 1 || qLines.size === 0 ? (questions.length === 1 ? trimmed : '') : '');

    if (!source) {
      return;
    }

    if (q.options && q.options.length > 0) {
      // For multi-question without Qn: lines, ignore bare digits (ambiguous)
      if (!perQuestion && questions.length > 1) {
        return;
      }
      const selected = resolveOptionTokens(source, q.options, Boolean(q.multiSelect));
      if (selected.length > 0) {
        answers[qIdx] = selected;
      }
    } else if (source) {
      answers[qIdx] = [source];
    }
  });

  return JSON.stringify(answers);
}

/** Labels per question from a resolved answer (`{"0":["A"]}`); null when unparseable. */
function answerLabels(answer: string, questionCount: number): string[][] | null {
  try {
    const parsed = JSON.parse(answer) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return null;
    return Array.from({ length: questionCount }, (_, q) => {
      const value = parsed[q];
      return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
    });
  } catch {
    return null;
  }
}

export function formatRemoteQuestionMessage(questions: RemoteQuestionItem[]): string {
  let messageText = '**Your answer is needed**\n\n';

  questions.forEach((q, qIdx) => {
    const qLabel = `Q${qIdx + 1}`;
    if (q.header) {
      messageText += `**${qLabel} · ${q.header}**\n`;
    } else {
      messageText += `**${qLabel}**\n`;
    }
    messageText += `${q.question}\n\n`;

    if (q.options && q.options.length > 0) {
      q.options.forEach((opt, optIdx) => {
        const letter = String.fromCharCode(65 + optIdx);
        messageText += `  ${letter}. ${opt.label}`;
        if (opt.recommended) {
          messageText += ' *(Recommended)*';
        }
        if (opt.description) {
          messageText += ` — ${opt.description}`;
        }
        messageText += '\n';
      });
      messageText += '\n';
      if (questions.length > 1) {
        messageText += q.multiSelect
          ? `*(Reply as \`${qLabel}: A,C\` or \`${qLabel}: 1,3\`)*\n\n`
          : `*(Reply as \`${qLabel}: A\` or \`${qLabel}: 1\`)*\n\n`;
      } else {
        messageText += q.multiSelect
          ? `*(Multiple selections allowed, e.g. A,C or 1,3)*\n\n`
          : `*(Reply with the letter or number, e.g. A or 1)*\n\n`;
      }
    } else {
      messageText +=
        questions.length > 1
          ? `*(Reply as \`${qLabel}: your answer\`)*\n\n`
          : `*(Reply with your answer directly)*\n\n`;
    }
  });

  messageText += `---\n*Reply to this message to answer, or send "Skip" to skip the question*`;
  return messageText;
}

export class RemoteManager extends EventEmitter {
  private gateway?: RemoteGateway;
  private messageRouter: MessageRouter;
  private agentExecutor?: AgentExecutor;
  private sendToRenderer?: (event: ServerEvent) => void;

  // Session state tracking
  private remoteSessionIds: Set<string> = new Set();

  // Mapping: actual session ID -> remote session ID
  private sessionIdMapping: Map<string, string> = new Map();

  // Mapping: remote session ID -> actual session ID (reverse mapping)
  private reverseSessionIdMapping: Map<string, string> = new Map();

  // Mapping: remote session ID -> channel info (for routing responses back)
  private sessionChannelMapping: Map<string, { channelType: ChannelType; channelId: string }> =
    new Map();

  // Mapping: remote session ID -> owner sender ID (for interaction security)
  private sessionOwnerMapping: Map<string, string> = new Map();

  // Pending interactions (questions/permissions) waiting for user response
  private pendingInteractions: Map<string, RemoteInteraction> = new Map();

  // Callbacks for resolving pending interactions
  private interactionResolvers: Map<string, (response: string | null) => void> = new Map();

  // Response buffer for collecting messages before sending (to avoid spam)
  private responseBuffers: Map<string, { texts: string[]; lastSent: number; toolSteps: string[] }> =
    new Map();

  // Sent message hashes to avoid duplicates
  private sentMessageHashes: Map<string, Set<string>> = new Map();

  // Debounce timers for sending buffered responses
  private sendTimers: Map<string, NodeJS.Timeout> = new Map();

  // Promise-chain mutex for synchronizing pendingInteractions access
  private lockChain: Promise<void> = Promise.resolve();

  // Default working directory for remote sessions (when cwd is not specified)
  private defaultWorkingDirectory?: string;

  // Channels under the strict remote policy (currently the Slack relay)
  private strictChannels: Set<ChannelType> = new Set();
  private slackRelayProvider?: SlackRelayProvider;
  private slackRelayChannel?: SlackRelayChannel;
  private slackRelayLastError: string | null = null;
  private slackRelayLastActivity = 0;
  private slackRelayIdleTimer: NodeJS.Timeout | null = null;
  /** Suppress disconnect log when we already recorded enabled/disabled. */
  private slackRelayQuietDisconnect = false;

  // Slack relay interactivity: actual session id -> active turn
  private slackTurns: Map<string, SlackTurn> = new Map();
  // Slack approval id (shown on the Allow/Deny card) -> toolUseId
  private slackApprovals: Map<string, string> = new Map();
  // Chat-picker tokens -> desktop session id
  private slackChatTokens: Map<string, { sessionId: string; expiresAt: number }> = new Map();
  // Model / workspace picker buttons -> what they select
  private slackPickTokens: Map<
    string,
    | { kind: 'model'; modelId: string; label: string; expiresAt: number }
    | { kind: 'workspace'; workspace: ActiveDivision; expiresAt: number }
  > = new Map();
  // Slack question id (shown on the question card) -> AskUserQuestion questionId
  private slackQuestions: Map<string, string> = new Map();

  constructor() {
    super();
    this.messageRouter = new MessageRouter();
    this.messageRouter.setAllowedRootsResolver(() => this.getAllowedRemoteRoots());
  }

  setSlackRelayProvider(provider: SlackRelayProvider): void {
    this.slackRelayProvider = provider;
  }

  private getAllowedRemoteRoots(): string[] {
    const roots = new Set<string>(this.slackRelayProvider?.getAllowedRoots() ?? []);
    const configured = remoteConfigStore.getGatewayConfig().defaultWorkingDirectory;
    if (configured) roots.add(configured);
    if (this.defaultWorkingDirectory) roots.add(this.defaultWorkingDirectory);
    return [...roots];
  }

  private isStrictChannel(channelType: ChannelType): boolean {
    return this.strictChannels.has(channelType);
  }

  private setStrictChannel(channelType: ChannelType, strict: boolean): void {
    if (strict) this.strictChannels.add(channelType);
    else this.strictChannels.delete(channelType);
    this.messageRouter.setStrictChannel(channelType, strict);
  }

  // ==========================================================================
  // Slack relay (backend-routed Slack remote control)
  // ==========================================================================

  getSlackRelayStatus(): SlackRelayStatus {
    const config = remoteConfigStore.getSlackRelayConfig();
    return {
      enabled: config.enabled,
      connected: this.slackRelayChannel?.connected ?? false,
      slackConnected: this.slackRelayProvider?.isSlackConnected() ?? false,
      lastError: this.slackRelayChannel?.lastError ?? this.slackRelayLastError,
      idleTimeoutHours: config.idleTimeoutHours ?? DEFAULT_SLACK_RELAY_IDLE_TIMEOUT_HOURS,
    };
  }

  getSlackRelayConnectionLog(): SlackRelayConnectionEvent[] {
    return remoteConfigStore.getSlackRelayConnectionLog();
  }

  clearSlackRelayConnectionLog(): void {
    remoteConfigStore.clearSlackRelayConnectionLog();
  }

  private noteSlackRelayConnectionEvent(
    kind: SlackRelayConnectionEvent['kind'],
    detail?: string
  ): void {
    remoteConfigStore.appendSlackRelayConnectionEvent(kind, detail);
  }

  private handleSlackRelayStateChange(state: {
    connected: boolean;
    lastError: string | null;
  }): void {
    if (state.connected) {
      this.slackRelayQuietDisconnect = false;
      this.slackRelayLastError = null;
      this.noteSlackRelayConnectionEvent(
        'connected',
        'Registered with Slack. You should get a Slack DM around this time.'
      );
      return;
    }

    if (this.slackRelayQuietDisconnect) {
      this.slackRelayQuietDisconnect = false;
      return;
    }

    const error = state.lastError?.trim() || null;
    if (error?.includes('took over')) {
      this.slackRelayLastError = error;
      this.noteSlackRelayConnectionEvent('replaced', error);
      return;
    }
    if (error) {
      this.slackRelayLastError = error;
      this.noteSlackRelayConnectionEvent('error', error);
      return;
    }
    this.noteSlackRelayConnectionEvent(
      'disconnected',
      'Connection dropped; will retry if still on.'
    );
  }

  /**
   * DM the owner via the GrowthOS Slack bot when Slack remote control is connected.
   * Used for new Matter opportunities and Follow-ups. No-ops when offline / outdated backend.
   */
  pushOwnerAlert(title: string, body: string): boolean {
    if (!remoteConfigStore.getSlackRelayConfig().enabled) return false;
    const channel = this.slackRelayChannel;
    if (!channel?.supportsAlerts) return false;
    const heading = title.trim();
    const detail = body.trim();
    if (!heading && !detail) return false;
    const text = [heading ? `**${heading}**` : '', detail].filter(Boolean).join('\n');
    return channel.sendAlert(text);
  }

  async setSlackRelayEnabled(enabled: boolean, disableReason?: string): Promise<SlackRelayStatus> {
    if (enabled) {
      if (
        !this.slackRelayProvider?.isSlackConnected() ||
        !this.slackRelayProvider.getSlackUserId()
      ) {
        throw new Error('Connect Slack in Settings → Apps & data first.');
      }
      remoteConfigStore.setSlackRelayConfig({
        ...remoteConfigStore.getSlackRelayConfig(),
        enabled: true,
      });
      remoteConfigStore.setEnabled(true);
      this.slackRelayLastError = null;
      this.slackRelayLastActivity = Date.now();
      this.noteSlackRelayConnectionEvent('enabled', 'Turned on from this computer.');
      await this.restart();
    } else {
      const wasEnabled = remoteConfigStore.getSlackRelayConfig().enabled;
      remoteConfigStore.setSlackRelayConfig({
        ...remoteConfigStore.getSlackRelayConfig(),
        enabled: false,
      });
      if (wasEnabled) {
        this.slackRelayQuietDisconnect = true;
        const detail = disableReason?.trim() || 'Turned off from this computer.';
        this.noteSlackRelayConnectionEvent('disabled', detail);
        this.slackRelayLastError = detail;
      }
      const config = remoteConfigStore.getAll();
      const otherChannelConfigured = Boolean(
        (config.channels.feishu?.appId && config.channels.feishu?.appSecret) ||
        config.channels.slack?.botToken
      );
      if (!otherChannelConfigured) {
        remoteConfigStore.setEnabled(false);
        await this.stop();
      } else if (this.gateway?.running) {
        await this.restart();
      }
    }
    return this.getSlackRelayStatus();
  }

  /** Immediate shutdown on Slack disconnect / sign-out. */
  async disableSlackRelay(reason: string): Promise<void> {
    if (!remoteConfigStore.getSlackRelayConfig().enabled && !this.slackRelayChannel) return;
    logWarn('[RemoteManager] Disabling Slack relay:', reason);
    await this.setSlackRelayEnabled(false, reason.trim() || 'Turned off.');
  }

  private noteSlackRelayActivity(): void {
    this.slackRelayLastActivity = Date.now();
  }

  private startSlackRelayIdleTimer(): void {
    this.stopSlackRelayIdleTimer();
    this.slackRelayIdleTimer = setInterval(() => {
      const hours =
        remoteConfigStore.getSlackRelayConfig().idleTimeoutHours ??
        DEFAULT_SLACK_RELAY_IDLE_TIMEOUT_HOURS;
      if (Date.now() - this.slackRelayLastActivity < hours * 3_600_000) return;
      void this.disableSlackRelay(`Turned off after ${hours} hours without Slack activity.`).then(
        () =>
          this.slackRelayProvider?.notify(
            'Slack remote control turned off',
            `No Slack activity for ${hours} hours. Turn it on again in Settings when you need it.`
          )
      );
    }, SLACK_RELAY_IDLE_CHECK_MS);
    this.slackRelayIdleTimer.unref?.();
  }

  private stopSlackRelayIdleTimer(): void {
    if (this.slackRelayIdleTimer) clearInterval(this.slackRelayIdleTimer);
    this.slackRelayIdleTimer = null;
  }

  /**
   * Set agent executor (called from main process)
   */
  setAgentExecutor(executor: AgentExecutor): void {
    this.agentExecutor = executor;

    // Set up message router callback
    this.messageRouter.setAgentCallback(
      async (
        sessionId,
        prompt,
        content,
        workingDirectory,
        channelType,
        channelId,
        senderId,
        onMessage,
        onPartial,
        originalMessage
      ) => {
        await this.executeAgent(
          sessionId,
          prompt,
          content,
          workingDirectory,
          channelType as ChannelType,
          channelId,
          senderId,
          onMessage,
          onPartial,
          originalMessage
        );
      }
    );

    if (executor.validateWorkingDirectory) {
      this.messageRouter.setWorkingDirectoryValidator(executor.validateWorkingDirectory);
    }

    log('[RemoteManager] Agent executor set');
  }

  /**
   * Set the default working directory for remote sessions
   */
  setDefaultWorkingDirectory(dir?: string): void {
    this.defaultWorkingDirectory = dir;
    this.messageRouter.setDefaultWorkingDirectory(dir);
    log('[RemoteManager] Default working directory set:', dir || '(none)');
  }

  /**
   * Set renderer callback (for UI updates)
   */
  setRendererCallback(callback: (event: ServerEvent) => void): void {
    this.sendToRenderer = callback;
  }

  /**
   * Initialize and start remote control
   */
  async start(): Promise<void> {
    const config = remoteConfigStore.getAll();

    if (!config.gateway.enabled) {
      log('[RemoteManager] Remote control is disabled');
      return;
    }

    log('[RemoteManager] Starting remote control system...');

    try {
      // Create gateway. The relay never needs inbound connections, so keep the local listener loopback-only.
      const relayEnabled = config.channels.slackRelay?.enabled === true;
      const gatewayConfig: GatewayConfig = relayEnabled
        ? { ...config.gateway, bind: '127.0.0.1' }
        : config.gateway;
      this.gateway = new RemoteGateway(gatewayConfig, this.messageRouter);

      // Set remote default working directory (prefer config, then global default)
      const configuredDefaultWorkingDir =
        config.gateway.defaultWorkingDirectory || this.defaultWorkingDirectory;
      if (configuredDefaultWorkingDir) {
        this.setDefaultWorkingDirectory(configuredDefaultWorkingDir);
      }

      // Set up gateway event handlers
      this.setupGatewayEvents();

      // Set up message interceptor for interaction responses
      this.gateway.setMessageInterceptor(async (message) => {
        if (await this.handleSlackRelayTextCommand(message)) return true;
        return this.handlePotentialInteractionResponse(
          message.channelType,
          message.channelId,
          message.sender.id,
          message.content.text || ''
        );
      });

      // Register configured channels
      await this.registerChannels(config);

      // Load paired users from config
      this.loadPairedUsers();

      // Start gateway
      await this.gateway.start();
      if (this.slackRelayChannel) {
        this.slackRelayLastActivity = this.slackRelayLastActivity || Date.now();
        this.startSlackRelayIdleTimer();
      }

      // Start tunnel if configured (never alongside the relay, which must stay off the public internet)
      const tunnelUrl = relayEnabled ? null : await tunnelManager.start(config.gateway.port);
      if (tunnelUrl) {
        log('[RemoteManager] Tunnel URL:', tunnelUrl);
        log('[RemoteManager] Feishu Webhook URL:', `${tunnelUrl}/webhook/feishu`);
      }

      log('[RemoteManager] Remote control system started');
      this.emitStatusUpdate();
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === 'EADDRINUSE') {
        logWarn(
          '[RemoteManager] Remote control port already in use, skipping startup for this instance'
        );
        await this.gateway?.stop();
        this.gateway = undefined;
        this.emitStatusUpdate();
        return;
      }

      logError('[RemoteManager] Failed to start remote control:', error);
      throw error;
    }
  }

  /**
   * Start in stdio mode (headless RPC).
   * Connects a StdioChannel directly to the MessageRouter without a full Gateway.
   * Returns the StdioChannel instance for direct event writing.
   */
  async startStdioMode(defaultCwd?: string): Promise<StdioChannel> {
    log('[RemoteManager] Starting in stdio mode');

    const stdioChannel = new StdioChannel();

    // Wire channel messages directly to the message router (bypass gateway auth)
    stdioChannel.onMessage((message) => {
      this.routeMessage(message);
    });
    stdioChannel.onError((error) => {
      logError('[RemoteManager] StdioChannel error:', error);
    });

    // Set response callback so errors from agentCallback reach the client
    this.messageRouter.onResponse(async (response) => {
      await stdioChannel.send(response);
    });

    if (defaultCwd) {
      this.setDefaultWorkingDirectory(defaultCwd);
    }

    await stdioChannel.start();
    log('[RemoteManager] Stdio channel started');

    return stdioChannel;
  }

  /**
   * Stop remote control
   */
  async stop(): Promise<void> {
    if (!this.gateway) {
      return;
    }

    log('[RemoteManager] Stopping remote control system...');

    // Clear all pending debounce send timers to avoid post-stop flushes
    for (const timer of this.sendTimers.values()) {
      clearTimeout(timer);
    }
    this.sendTimers.clear();

    // Stop tunnel first
    await tunnelManager.stop();
    this.stopSlackRelayIdleTimer();

    try {
      await this.gateway.stop();
      this.gateway = undefined;
      if (this.slackRelayChannel) {
        this.slackRelayLastError = this.slackRelayChannel.lastError;
        this.slackRelayChannel = undefined;
        this.setStrictChannel('slack', false);
      }
      this.slackTurns.clear();
      this.slackApprovals.clear();
      this.slackQuestions.clear();
      this.slackChatTokens.clear();
      this.slackPickTokens.clear();

      log('[RemoteManager] Remote control system stopped');
      this.emitStatusUpdate();
    } catch (error) {
      logError('[RemoteManager] Error stopping remote control:', error);
    }
  }

  /**
   * Restart remote control
   */
  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  /**
   * Get gateway status
   */
  getStatus(): GatewayStatus & { tunnel?: TunnelStatus } {
    if (!this.gateway) {
      return {
        running: false,
        channels: [],
        activeSessions: 0,
        pendingPairings: 0,
      };
    }

    return {
      ...this.gateway.getStatus(),
      tunnel: tunnelManager.getStatus(),
    };
  }

  /**
   * Get tunnel status
   */
  getTunnelStatus(): TunnelStatus {
    return tunnelManager.getStatus();
  }

  /**
   * Get Feishu webhook URL (from tunnel)
   */
  getFeishuWebhookUrl(): string | null {
    return tunnelManager.getWebhookUrl();
  }

  /**
   * Update gateway config
   */
  async updateGatewayConfig(config: Partial<GatewayConfig>): Promise<void> {
    remoteConfigStore.setGatewayConfig(config);

    // Restart if running
    if (this.gateway?.running) {
      await this.restart();
    }
  }

  /**
   * Update feishu channel config
   */
  async updateFeishuConfig(config: FeishuChannelConfig): Promise<void> {
    const webhookConfigError = getFeishuWebhookConfigError(config);
    if (webhookConfigError) {
      throw new Error(webhookConfigError);
    }

    remoteConfigStore.setFeishuConfig(config);

    // Sync Feishu DM policy to gateway auth mode so checkAuthorization() matches.
    // Note: gateway auth mode is a cross-channel setting — changing it here affects
    // authorization for all channel types (feishu, telegram, etc.), not just Feishu.
    // Skip sync if gateway is using token auth, as that would disable token protection
    // for non-Feishu channels (e.g. WebSocket).
    if (config.dm) {
      const currentGateway = remoteConfigStore.getGatewayConfig();
      const currentAuth = currentGateway.auth;

      if (currentAuth.mode === 'token' || currentAuth.token) {
        log(
          '[RemoteManager] Skipping DM policy sync: gateway uses token auth, preserving for other channels'
        );
      } else {
        switch (config.dm.policy) {
          case 'open':
            remoteConfigStore.setGatewayConfig({
              auth: { ...currentAuth, mode: 'open' },
            });
            break;
          case 'pairing':
            remoteConfigStore.setGatewayConfig({
              auth: { ...currentAuth, mode: 'pairing' },
            });
            break;
          case 'allowlist': {
            // Scope Feishu IDs and merge with existing entries (preserving other channels)
            const feishuEntries = (config.dm.allowFrom ?? []).map((id) => `feishu:${id}`);
            const nonFeishuEntries = (currentAuth.allowlist ?? []).filter(
              (entry) => !entry.startsWith('feishu:')
            );
            // Include paired Feishu users so they retain access when switching from pairing mode
            // (syncAllowlist() only populates allowlist when already in allowlist mode)
            const pairedFeishuEntries = remoteConfigStore
              .getPairedUsers()
              .filter((u) => u.channelType === 'feishu')
              .map((u) => `feishu:${u.userId}`);
            remoteConfigStore.setGatewayConfig({
              auth: {
                ...currentAuth,
                mode: 'allowlist',
                allowlist: [
                  ...new Set([...nonFeishuEntries, ...pairedFeishuEntries, ...feishuEntries]),
                ],
              },
            });
            break;
          }
        }
      }
    }

    // Restart to apply changes
    if (this.gateway?.running) {
      await this.restart();
    }
  }

  /**
   * Approve pairing request
   */
  approvePairing(channelType: ChannelType, userId: string): boolean {
    if (!this.gateway) {
      return false;
    }

    const success = this.gateway.approvePairing(channelType, userId);

    if (success) {
      // Persist to config
      remoteConfigStore.addPairedUser({
        userId,
        channelType,
        pairedAt: Date.now(),
        lastActiveAt: Date.now(),
      });

      this.emitStatusUpdate();
    }

    return success;
  }

  /**
   * Reject pairing request
   */
  rejectPairing(channelType: ChannelType, userId: string): boolean {
    if (!this.gateway) {
      return false;
    }

    const success = this.gateway.rejectPairing(channelType, userId);

    if (success) {
      this.emitStatusUpdate();
    }

    return success;
  }

  /**
   * Revoke user pairing
   */
  revokePairing(channelType: ChannelType, userId: string): boolean {
    if (!this.gateway) {
      return false;
    }

    const success = this.gateway.revokePairing(channelType, userId);

    if (success) {
      remoteConfigStore.removePairedUser(channelType, userId);
      this.emitStatusUpdate();
    }

    return success;
  }

  /**
   * Get paired users
   */
  getPairedUsers(): PairedUser[] {
    return remoteConfigStore.getPairedUsers();
  }

  /**
   * Get pending pairing requests
   */
  getPendingPairings(): PairingRequest[] {
    return this.gateway?.getPendingPairings() || [];
  }

  /**
   * Get active remote sessions
   */
  getRemoteSessions(): RemoteSessionMapping[] {
    return this.messageRouter.getAllSessionMappings();
  }

  /**
   * Route a message through the message router (public seam used by channels
   * and tests, so callers never reach into the private router).
   */
  routeMessage(message: RemoteMessage): Promise<void> {
    return this.messageRouter.routeMessage(message);
  }

  /**
   * Clear remote session
   *
   * Accepts either the router-side remote id (`remote-*`) or the actual agent
   * session id, and normalizes internally — a caller passing the "wrong" id
   * kind must not silently skip the persistent teardown (which would leave
   * remoteSessionIds populated and reintroduce the mapping leak).
   */
  async clearRemoteSession(sessionId: string): Promise<boolean> {
    let remoteSessionId = sessionId;
    let actualSessionId = this.reverseSessionIdMapping.get(sessionId);
    if (!actualSessionId && this.sessionIdMapping.has(sessionId)) {
      actualSessionId = sessionId;
      remoteSessionId = this.sessionIdMapping.get(sessionId)!;
    }
    if (actualSessionId) {
      await this.removeRemoteSession(actualSessionId);
    }
    return this.messageRouter.clearSession(remoteSessionId);
  }

  /**
   * Cascade cleanup when an actual session is deleted (desktop delete /
   * batch delete): tear down every channel binding pointing at it.
   *
   * Triggered by the SessionManager onSessionDeleted extension hook (wired in
   * index.ts). The executeAgent self-heal above is the safety net; this hook
   * closes the dangling window at the moment of deletion instead.
   */
  async handleSessionDeleted(actualSessionId: string): Promise<void> {
    const remoteSessionId = this.sessionIdMapping.get(actualSessionId);
    if (!remoteSessionId) {
      return; // Not a channel-bound session
    }
    await this.removeRemoteSession(actualSessionId);
    this.messageRouter.clearSession(remoteSessionId);
    log('[RemoteManager] Cleared channel binding for deleted session:', actualSessionId);
  }

  /**
   * Check if a session is a remote session
   */
  isRemoteSession(actualSessionId: string): boolean {
    return this.sessionIdMapping.has(actualSessionId);
  }

  /**
   * Get remote session ID from actual session ID
   */
  getRemoteSessionId(actualSessionId: string): string | undefined {
    return this.sessionIdMapping.get(actualSessionId);
  }

  /**
   * Handle question request from agent (for remote sessions)
   * Returns true if handled, false if should use normal UI
   */
  async handleQuestionRequest(
    actualSessionId: string,
    questionId: string,
    questions: Array<{
      question: string;
      header?: string;
      options?: Array<{ label: string; description?: string; recommended?: boolean }>;
      multiSelect?: boolean;
    }>
  ): Promise<string | null> {
    const remoteSessionId = this.sessionIdMapping.get(actualSessionId);
    if (!remoteSessionId) {
      return null; // Not a remote session
    }

    const channelInfo = this.sessionChannelMapping.get(remoteSessionId);
    if (!channelInfo || !this.gateway) {
      return null;
    }

    log('[RemoteManager] Handling question request for remote session:', remoteSessionId);

    const messageText = formatRemoteQuestionMessage(questions);

    // Store pending interaction
    const interaction: RemoteInteraction = {
      type: 'question',
      sessionId: actualSessionId,
      remoteSessionId,
      ownerSenderId: this.sessionOwnerMapping.get(remoteSessionId) || '',
      questionId,
      questions,
      createdAt: Date.now(),
      expiresAt: Date.now() + REMOTE_QUESTION_TIMEOUT_MS,
    };
    await this.withInteractionLock(async () => {
      this.pendingInteractions.set(questionId, interaction);
    });

    // Slack relay: button card (typed replies still work); other channels: markdown prompt.
    const slackQuestionId = this.sendSlackQuestion(actualSessionId, questionId, questions);
    if (!slackQuestionId) {
      try {
        await this.gateway.sendResponse({
          channelType: channelInfo.channelType,
          channelId: channelInfo.channelId,
          content: {
            type: 'markdown',
            markdown: messageText,
          },
        });
      } catch (err) {
        logError('[RemoteManager] Failed to send question to channel:', err);
        await this.withInteractionLock(async () => {
          this.pendingInteractions.delete(questionId);
        });
        return null;
      }
    }

    // Wait for user response
    return new Promise((resolve) => {
      const settle = (answer: string | null) => {
        if (slackQuestionId) {
          this.closeSlackQuestion(actualSessionId, slackQuestionId, questions, answer);
        }
        resolve(answer);
      };
      this.interactionResolvers.set(questionId, settle);

      // Set timeout — resolve null so the agent path cancels (not empty success)
      setTimeout(() => {
        this.withInteractionLock(async () => {
          if (this.pendingInteractions.has(questionId)) {
            log('[RemoteManager] Question timeout:', questionId);
            this.pendingInteractions.delete(questionId);
            this.interactionResolvers.delete(questionId);
            settle(null);
          }
        }).catch((err) => logError('[RemoteManager] Question timeout lock error:', err));
      }, REMOTE_QUESTION_TIMEOUT_MS);
    });
  }

  /**
   * Handle permission request from agent (for remote sessions)
   * Returns true if handled, false if should use normal UI
   */
  async handlePermissionRequest(
    actualSessionId: string,
    toolUseId: string,
    toolName: string,
    input: Record<string, unknown>
  ): Promise<{ allow: boolean; remember?: boolean } | null> {
    const remoteSessionId = this.sessionIdMapping.get(actualSessionId);
    if (!remoteSessionId) {
      return null; // Not a remote session
    }

    const channelInfo = this.sessionChannelMapping.get(remoteSessionId);
    if (!channelInfo || !this.gateway) {
      return null;
    }

    log('[RemoteManager] Handling permission request for remote session:', remoteSessionId);

    const strict =
      this.isStrictChannel(channelInfo.channelType) || isStrictRemoteSession(actualSessionId);

    // Check if auto-approve is enabled for safe tools
    const config = remoteConfigStore.getAll();
    if (!strict && config.gateway.autoApproveSafeTools) {
      const safeTools = [
        // Read-only tools
        'Read',
        'Glob',
        'Grep',
        'LS',
        'WebFetch',
        'WebSearch',
        // MCP Chrome tools (for browsing)
        'mcp__Chrome__navigate_page',
        'mcp__Chrome__take_screenshot',
        'mcp__Chrome__take_snapshot',
        'mcp__Chrome__click',
        'mcp__Chrome__fill',
        'mcp__Chrome__hover',
        'mcp__Chrome__list_pages',
        'mcp__Chrome__select_page',
        'mcp__Chrome__new_page',
        'mcp__Chrome__close_page',
        'mcp__Chrome__wait_for',
        'mcp__Chrome__press_key',
        'mcp__Chrome__evaluate_script',
        'mcp__Chrome__get_network_request',
        'mcp__Chrome__list_network_requests',
        'mcp__Chrome__list_console_messages',
        // Task tools
        'Task',
      ];

      const lowered = toolName.toLowerCase();
      const isListedSafe = safeTools.some((name) => name.toLowerCase() === lowered);
      if (isListedSafe || isAutoAllowedWikiTool(toolName)) {
        log('[RemoteManager] Auto-approving safe tool:', toolName);
        // Send notification to user
        await this.doSendToChannel(channelInfo, `🔧 Auto-running: **${toolName}**`);
        return { allow: true };
      }
    }

    // Strict sessions must expire together with the session-manager prompt (which denies),
    // otherwise a later chat message could be swallowed as an answer to a dead prompt.
    const timeoutMs = strict ? PERMISSION_AUTO_APPROVE_MS : PERMISSION_ASK_TIMEOUT_MS;

    // Build permission request message
    let inputPreview = JSON.stringify(input, null, 2) ?? '';
    if (strict && inputPreview.length > STRICT_PERMISSION_INPUT_PREVIEW_MAX) {
      inputPreview = `${inputPreview.slice(0, STRICT_PERMISSION_INPUT_PREVIEW_MAX)}\n… (truncated, review on desktop for full input)`;
    }
    let messageText = '⚠️ **Needs your authorization**\n\n';
    messageText += `Tool: **${toolName}**\n\n`;
    messageText += `Parameters:\n\`\`\`json\n${inputPreview}\n\`\`\`\n\n`;
    messageText += `---\n`;
    messageText += `Reply "Allow" or "y" to approve\n`;
    if (strict) {
      messageText += `Reply "Deny" or "n" to reject\n`;
      messageText += `No reply within ${Math.round(timeoutMs / 1000)} seconds = denied`;
    } else {
      messageText += `Reply "Deny" or "n" to reject\n`;
      messageText += `Reply "Always allow" to remember this approval`;
    }

    // Store pending interaction
    const interaction: RemoteInteraction = {
      type: 'permission',
      sessionId: actualSessionId,
      remoteSessionId,
      ownerSenderId: this.sessionOwnerMapping.get(remoteSessionId) || '',
      toolUseId,
      toolName,
      input,
      createdAt: Date.now(),
      expiresAt: Date.now() + (strict ? timeoutMs : 5 * 60 * 1000),
    };
    await this.withInteractionLock(async () => {
      this.pendingInteractions.set(toolUseId, interaction);
    });

    // Slack relay: Allow/Deny card (typed replies still work); other channels: markdown prompt.
    const slackApprovalId = this.sendSlackApproval(
      actualSessionId,
      toolUseId,
      toolName,
      input,
      inputPreview,
      timeoutMs
    );
    if (!slackApprovalId) {
      try {
        await this.gateway.sendResponse({
          channelType: channelInfo.channelType,
          channelId: channelInfo.channelId,
          content: {
            type: 'markdown',
            markdown: messageText,
          },
        });
      } catch (err) {
        logError('[RemoteManager] Failed to send permission request to channel:', err);
        await this.withInteractionLock(async () => {
          this.pendingInteractions.delete(toolUseId);
        });
        return null;
      }
    }

    // Wait for user response
    return new Promise((resolve) => {
      const settle = (
        result: { allow: boolean; remember?: boolean },
        outcome: 'allowed' | 'denied' | 'expired'
      ) => {
        if (slackApprovalId) this.closeSlackApproval(actualSessionId, slackApprovalId, outcome);
        resolve(result);
      };

      this.interactionResolvers.set(toolUseId, (response) => {
        if (response === null) {
          settle({ allow: false }, 'denied');
          return;
        }
        const lowerResponse = response.toLowerCase().trim();
        if (lowerResponse === 'allow' || lowerResponse === 'y' || lowerResponse === 'yes') {
          if (strict) {
            this.slackRelayProvider?.notify(
              'Remote action approved',
              `Running ${toolName} (approved from ${channelInfo.channelType})`
            );
          }
          settle({ allow: true }, 'allowed');
        } else if (!strict && (lowerResponse === 'always allow' || lowerResponse === 'always')) {
          settle({ allow: true, remember: true }, 'allowed');
        } else {
          settle({ allow: false }, 'denied');
        }
      });

      // Set timeout - auto deny on timeout
      setTimeout(() => {
        this.withInteractionLock(async () => {
          if (this.pendingInteractions.has(toolUseId)) {
            log('[RemoteManager] Permission timeout:', toolUseId);
            this.pendingInteractions.delete(toolUseId);
            this.interactionResolvers.delete(toolUseId);
            settle({ allow: false }, 'expired'); // Deny on timeout
          }
        }).catch((err) => logError('[RemoteManager] Permission timeout lock error:', err));
      }, timeoutMs);
    });
  }

  private async withInteractionLock<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const acquired = new Promise<void>((r) => {
      release = r;
    });
    const previous = this.lockChain;
    this.lockChain = acquired;
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * Handle incoming message that might be a response to pending interaction
   * Returns true if the message was consumed as an interaction response
   */
  async handlePotentialInteractionResponse(
    channelType: ChannelType,
    channelId: string,
    senderId: string,
    messageText: string
  ): Promise<boolean> {
    return this.withInteractionLock(async () => {
      // Find any pending interaction for this user
      let found = false;
      for (const [id, interaction] of this.pendingInteractions) {
        const channelInfo = this.sessionChannelMapping.get(interaction.remoteSessionId);
        if (!channelInfo) continue;

        if (channelInfo.channelType === channelType && channelInfo.channelId === channelId) {
          // Verify that the responder is the session owner to prevent hijacking
          if (!interaction.ownerSenderId || senderId !== interaction.ownerSenderId) {
            log('[RemoteManager] Ignoring interaction response from non-owner sender:', senderId);
            continue;
          }

          log('[RemoteManager] Found pending interaction:', id);

          // Remove from pending
          this.pendingInteractions.delete(id);

          // Resolve the interaction
          const resolver = this.interactionResolvers.get(id);
          if (resolver) {
            this.interactionResolvers.delete(id);

            if (interaction.type === 'question') {
              // Parse question response
              const response = this.parseQuestionResponse(messageText, interaction.questions || []);
              resolver(response);
            } else {
              // Pass through for permission
              resolver(messageText);
            }
          }

          found = true;
          break; // Only handle one interaction per message
        }
      }

      return found;
    });
  }

  /**
   * Parse question response from user message
   */
  private parseQuestionResponse(
    messageText: string,
    questions: Array<{
      question: string;
      options?: Array<{ label: string; description?: string; recommended?: boolean }>;
      multiSelect?: boolean;
    }>
  ): string {
    return parseRemoteQuestionResponse(messageText, questions);
  }

  /**
   * Get pending interactions count
   */
  getPendingInteractionsCount(): number {
    return this.pendingInteractions.size;
  }

  /**
   * Send agent response back to channel (with buffering to avoid spam)
   */
  async sendResponseToChannel(
    actualSessionId: string,
    text: string,
    immediate: boolean = false
  ): Promise<void> {
    const remoteSessionId = this.sessionIdMapping.get(actualSessionId);
    if (!remoteSessionId) {
      log('[RemoteManager] Not a remote session, skipping channel response:', actualSessionId);
      return;
    }

    const channelInfo = this.sessionChannelMapping.get(remoteSessionId);
    if (!channelInfo || !this.gateway) {
      logError('[RemoteManager] No channel info for remote session:', remoteSessionId);
      return;
    }

    // Check for duplicate
    const hash = this.hashText(text);
    if (!this.sentMessageHashes.has(actualSessionId)) {
      this.sentMessageHashes.set(actualSessionId, new Set());
    }
    const sentHashes = this.sentMessageHashes.get(actualSessionId)!;
    if (sentHashes.has(hash)) {
      log('[RemoteManager] Skipping duplicate message');
      return;
    }
    // Prevent unbounded growth: clear oldest entries when set exceeds 500 entries
    if (sentHashes.size >= 500) {
      sentHashes.clear();
    }
    sentHashes.add(hash);

    // Slack relay turns send one combined answer when the turn ends (see finishSlackTurn).
    if (this.slackTurns.has(actualSessionId)) {
      if (!this.responseBuffers.has(actualSessionId)) {
        this.responseBuffers.set(actualSessionId, { texts: [], lastSent: 0, toolSteps: [] });
      }
      this.responseBuffers.get(actualSessionId)!.texts.push(text);
      return;
    }

    // For immediate sends (like final result), send directly
    if (immediate) {
      await this.doSendToChannel(channelInfo, text);
      return;
    }

    // Buffer the response
    if (!this.responseBuffers.has(actualSessionId)) {
      this.responseBuffers.set(actualSessionId, { texts: [], lastSent: 0, toolSteps: [] });
    }
    const buffer = this.responseBuffers.get(actualSessionId)!;
    buffer.texts.push(text);

    // Clear existing timer
    const existingTimer = this.sendTimers.get(actualSessionId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Set debounce timer (send after 2 seconds of no new messages)
    const timer = setTimeout(() => {
      this.flushResponseBuffer(actualSessionId).catch((err) => {
        logError('[RemoteManager] Failed to flush buffer:', err);
      });
    }, 2000);
    this.sendTimers.set(actualSessionId, timer);
  }

  /**
   * Flush buffered responses and send to channel
   */
  private async flushResponseBuffer(actualSessionId: string): Promise<void> {
    const buffer = this.responseBuffers.get(actualSessionId);
    if (!buffer || buffer.texts.length === 0) return;

    const remoteSessionId = this.sessionIdMapping.get(actualSessionId);
    if (!remoteSessionId) return;

    const channelInfo = this.sessionChannelMapping.get(remoteSessionId);
    if (!channelInfo || !this.gateway) return;

    // Combine all buffered texts
    const combinedText = buffer.texts.join('\n\n');
    buffer.texts = [];
    buffer.lastSent = Date.now();

    // Clear timer
    const timer = this.sendTimers.get(actualSessionId);
    if (timer) {
      clearTimeout(timer);
      this.sendTimers.delete(actualSessionId);
    }

    await this.doSendToChannel(channelInfo, combinedText);
  }

  /**
   * Actually send message to channel
   */
  private async doSendToChannel(
    channelInfo: { channelType: ChannelType; channelId: string },
    text: string
  ): Promise<void> {
    log('[RemoteManager] Sending to channel:', {
      channelType: channelInfo.channelType,
      textLength: text.length,
    });

    try {
      await this.gateway!.sendResponse({
        channelType: channelInfo.channelType,
        channelId: channelInfo.channelId,
        content: {
          type: 'markdown',
          markdown: text,
        },
      });
    } catch (err) {
      logError('[RemoteManager] Failed to send to channel:', err);
    }
  }

  /**
   * Simple hash function for deduplication
   */
  private hashText(text: string): string {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      const char = text.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return hash.toString();
  }

  /**
   * Send tool execution progress to channel
   */
  async sendToolProgress(
    actualSessionId: string,
    toolName: string,
    status: 'running' | 'completed' | 'error',
    output?: string
  ): Promise<void> {
    const remoteSessionId = this.sessionIdMapping.get(actualSessionId);
    if (!remoteSessionId) return;

    if (this.slackTurns.has(actualSessionId)) {
      if (status === 'running') {
        this.updateSlackTurnStatus(actualSessionId, 'step', slackStatusLabelForTool(toolName));
      }
      return;
    }

    const channelInfo = this.sessionChannelMapping.get(remoteSessionId);
    if (!channelInfo || !this.gateway) return;

    // Only send notifications for interesting tools
    const notifyTools = ['Bash', 'Write', 'Edit', 'WebSearch', 'WebFetch', 'mcp__Chrome__'];
    const shouldNotify = notifyTools.some((t) => toolName.includes(t));

    if (!shouldNotify) return;

    let emoji = '🔧';
    let statusText = '';

    switch (status) {
      case 'running':
        emoji = '⏳';
        statusText = `Running **${toolName}**...`;
        break;
      case 'completed':
        emoji = '✅';
        statusText = `**${toolName}** completed`;
        if (output && output.length < 200) {
          statusText += `\n\`\`\`\n${output}\n\`\`\``;
        }
        break;
      case 'error':
        emoji = '❌';
        statusText = `**${toolName}** failed`;
        if (output) {
          statusText += `: ${output.substring(0, 100)}`;
        }
        break;
    }

    // Only send running status for long-running tools
    if (status === 'running') {
      // Add to buffer's tool steps
      if (!this.responseBuffers.has(actualSessionId)) {
        this.responseBuffers.set(actualSessionId, { texts: [], lastSent: 0, toolSteps: [] });
      }
      this.responseBuffers.get(actualSessionId)!.toolSteps.push(`${emoji} ${statusText}`);
      return;
    }

    // Send completed/error status immediately for important tools
    if (status === 'completed' && toolName.includes('mcp__Chrome__')) {
      // For Chrome MCP, send progress
      await this.doSendToChannel(channelInfo, `${emoji} ${statusText}`);
    }
  }

  /**
   * Clear session response buffer (call when session ends)
   * Flushes any pending messages before clearing
   */
  async clearSessionBuffer(
    actualSessionId: string,
    outcome: 'idle' | 'error' = 'idle'
  ): Promise<void> {
    // Slack relay turns deliver their combined answer and close the status message.
    await this.finishSlackTurn(actualSessionId, outcome);

    // First flush any pending messages
    await this.flushResponseBuffer(actualSessionId);

    // Then clear the ephemeral per-turn state only.
    //
    // IMPORTANT: This runs on every turn completion (session.status idle/error),
    // so it must NOT tear down the persistent session id mappings. Doing so left
    // `remoteSessionIds` (which is only ever added to) pointing at a session whose
    // `reverseSessionIdMapping` entry had been deleted, so the next turn saw
    // isNewSession === false but failed to resolve the actual session id and threw
    // "No actual session ID found for remote session" (issue #291). Persistent
    // mappings are torn down in removeRemoteSession(), on genuine session end.
    this.responseBuffers.delete(actualSessionId);
    this.sentMessageHashes.delete(actualSessionId);
    const timer = this.sendTimers.get(actualSessionId);
    if (timer) {
      clearTimeout(timer);
      this.sendTimers.delete(actualSessionId);
    }
  }

  /**
   * Tear down all persistent state for a remote session.
   *
   * Unlike clearSessionBuffer (per-turn), this removes the session id mappings so
   * a remote id can no longer be continued. Call it on genuine session end
   * (explicit clear), not on turn completion. Keeps remoteSessionIds and the id
   * mappings in lockstep to avoid the drift that caused issue #291.
   */
  async removeRemoteSession(actualSessionId: string): Promise<void> {
    // Flush and clear any ephemeral state first.
    await this.clearSessionBuffer(actualSessionId);

    const remoteSessionId = this.sessionIdMapping.get(actualSessionId);
    this.sessionIdMapping.delete(actualSessionId);
    if (remoteSessionId) {
      this.reverseSessionIdMapping.delete(remoteSessionId);
      this.remoteSessionIds.delete(remoteSessionId);
      this.sessionChannelMapping.delete(remoteSessionId);
      this.sessionOwnerMapping.delete(remoteSessionId);
    }
  }

  // ============================================================================
  // Slack relay interactivity (live status, approval buttons, /growth commands)
  // ============================================================================

  /** Thinking / answer-streaming progress for a Slack relay turn. Cheap per stream event. */
  noteSlackTurnActivity(actualSessionId: string, kind: 'thinking' | 'writing'): void {
    if (!this.slackTurns.has(actualSessionId)) return;
    this.updateSlackTurnStatus(
      actualSessionId,
      'thinking',
      kind === 'thinking' ? 'Thinking…' : 'Writing the answer…'
    );
  }

  /** Button clicks and slash commands relayed from Slack (owner-verified by the backend). */
  async handleSlackRelayAction(action: SlackRelayAction): Promise<void> {
    if (action.kind === 'approval') {
      await this.resolveSlackApproval(action.approvalId, action.decision);
      return;
    }
    if (action.kind === 'answer') {
      await this.resolveSlackQuestion(action.questionId, action.answers);
      return;
    }
    await this.handleSlackRelayCommand(action.name, action.arg, action.replyHandle);
  }

  private beginSlackTurn(actualSessionId: string, handle: string | null): void {
    if (!handle) return;
    const previous = this.slackTurns.get(actualSessionId);
    if (previous && previous.handle !== handle) {
      this.slackRelayChannel?.sendStatus(previous.handle, 'done');
    }
    this.slackTurns.set(actualSessionId, { handle, label: null });
  }

  private updateSlackTurnStatus(
    actualSessionId: string,
    phase: 'thinking' | 'step',
    label: string
  ): void {
    const turn = this.slackTurns.get(actualSessionId);
    if (!turn || !this.slackRelayChannel) return;
    // Repeated steps still count (e.g. several reads); repeated thinking labels are noise.
    if (phase === 'thinking' && turn.label === label) return;
    turn.label = label;
    this.slackRelayChannel.sendStatus(turn.handle, phase, label);
  }

  /** Send the turn's combined answer with the chat footer, then close the status message. */
  private async finishSlackTurn(actualSessionId: string, outcome: 'idle' | 'error'): Promise<void> {
    const turn = this.slackTurns.get(actualSessionId);
    if (!turn) return;
    this.slackTurns.delete(actualSessionId);

    const buffer = this.responseBuffers.get(actualSessionId);
    const text = buffer ? buffer.texts.join('\n\n').trim() : '';
    if (buffer) buffer.texts = [];

    const channel = this.slackRelayChannel;
    if (!channel) return;
    if (text) {
      const title = this.agentExecutor?.getSession?.(actualSessionId)?.title;
      try {
        await channel.sendReply(turn.handle, text, formatAnswerFooter(title));
      } catch (err) {
        logError('[RemoteManager] Failed to send Slack answer:', err);
      }
    }
    channel.sendStatus(turn.handle, outcome === 'error' ? 'error' : 'done');
  }

  /** Post an Allow/Deny card for a Slack relay session. Returns the approval id, or null to fall back to text. */
  private sendSlackApproval(
    actualSessionId: string,
    toolUseId: string,
    toolName: string,
    input: Record<string, unknown>,
    inputPreview: string,
    timeoutMs: number
  ): string | null {
    const channel = this.slackRelayChannel;
    const remoteSessionId = this.sessionIdMapping.get(actualSessionId);
    const channelInfo = remoteSessionId ? this.sessionChannelMapping.get(remoteSessionId) : null;
    if (!channel?.connected || channelInfo?.channelType !== 'slack') return null;
    const handle = this.slackTurns.get(actualSessionId)?.handle ?? channel.latestHandle;
    if (!handle) return null;

    const approvalId = opaqueId();
    const sent = channel.sendApproval(handle, {
      approvalId,
      toolName,
      summary: summarizeToolInput(toolName, input),
      ...(inputPreview && inputPreview !== '{}' ? { detail: inputPreview } : {}),
      expiresInSec: Math.min(900, Math.max(5, Math.round(timeoutMs / 1000))),
    });
    if (!sent) return null;
    this.slackApprovals.set(approvalId, toolUseId);
    this.updateSlackTurnStatus(actualSessionId, 'thinking', 'Waiting for your approval…');
    return approvalId;
  }

  private closeSlackApproval(
    actualSessionId: string,
    approvalId: string,
    outcome: 'allowed' | 'denied' | 'expired'
  ): void {
    this.slackApprovals.delete(approvalId);
    this.slackRelayChannel?.closeApproval(approvalId, outcome);
    if (outcome === 'allowed')
      this.updateSlackTurnStatus(actualSessionId, 'thinking', 'Continuing…');
  }

  /** Post a question card for a Slack relay session. Returns its id, or null to fall back to text. */
  private sendSlackQuestion(
    actualSessionId: string,
    questionId: string,
    questions: RemoteQuestionItem[]
  ): string | null {
    const channel = this.slackRelayChannel;
    const remoteSessionId = this.sessionIdMapping.get(actualSessionId);
    const channelInfo = remoteSessionId ? this.sessionChannelMapping.get(remoteSessionId) : null;
    if (!channel?.supportsQuestions || channelInfo?.channelType !== 'slack') return null;
    if (
      questions.length === 0 ||
      questions.length > SLACK_RELAY_QUESTION_LIMITS.questions ||
      questions.some((q) => (q.options?.length ?? 0) > SLACK_RELAY_QUESTION_LIMITS.options)
    ) {
      return null;
    }
    const handle = this.slackTurns.get(actualSessionId)?.handle ?? channel.latestHandle;
    if (!handle) return null;

    const slackQuestionId = opaqueId();
    const sent = channel.sendQuestion(handle, {
      questionId: slackQuestionId,
      expiresInSec: Math.round(REMOTE_QUESTION_TIMEOUT_MS / 1000),
      questions: questions.map((q) => ({
        question: q.question,
        ...(q.header ? { header: q.header } : {}),
        ...(q.multiSelect ? { multiSelect: true } : {}),
        options: (q.options ?? []).map((o) => ({
          label: o.label,
          ...(o.description ? { description: o.description } : {}),
          ...(o.recommended ? { recommended: true } : {}),
        })),
      })),
    });
    if (!sent) return null;
    this.slackQuestions.set(slackQuestionId, questionId);
    this.updateSlackTurnStatus(actualSessionId, 'thinking', 'Waiting for your answer…');
    return slackQuestionId;
  }

  private closeSlackQuestion(
    actualSessionId: string,
    slackQuestionId: string,
    questions: RemoteQuestionItem[],
    answer: string | null
  ): void {
    this.slackQuestions.delete(slackQuestionId);
    const channel = this.slackRelayChannel;
    if (!channel) return;
    if (answer === null) {
      channel.closeQuestion(slackQuestionId, 'expired');
      return;
    }
    const labels = answerLabels(answer, questions.length);
    if (!labels || labels.every((l) => l.length === 0)) {
      channel.closeQuestion(slackQuestionId, 'skipped');
    } else {
      channel.closeQuestion(slackQuestionId, 'answered', labels);
    }
    this.updateSlackTurnStatus(actualSessionId, 'thinking', 'Continuing…');
  }

  private async resolveSlackQuestion(
    slackQuestionId: string,
    picks: number[][] | null
  ): Promise<void> {
    const questionId = this.slackQuestions.get(slackQuestionId);
    const pending = await this.withInteractionLock(async () => {
      const interaction = questionId ? this.pendingInteractions.get(questionId) : undefined;
      if (!questionId || !interaction) return null;
      this.pendingInteractions.delete(questionId);
      const resolver = this.interactionResolvers.get(questionId) ?? null;
      this.interactionResolvers.delete(questionId);
      return resolver ? { resolver, questions: interaction.questions ?? [] } : null;
    });
    if (!pending) {
      this.slackQuestions.delete(slackQuestionId);
      this.slackRelayChannel?.closeQuestion(slackQuestionId, 'expired');
      return;
    }
    const answers: Record<number, string[]> = {};
    picks?.forEach((indexes, q) => {
      const options = pending.questions[q]?.options ?? [];
      const labels = indexes.map((o) => options[o]?.label).filter((l): l is string => !!l);
      if (labels.length > 0) answers[q] = labels;
    });
    pending.resolver(JSON.stringify(answers));
  }

  private async resolveSlackApproval(
    approvalId: string,
    decision: 'allow' | 'deny'
  ): Promise<void> {
    const toolUseId = this.slackApprovals.get(approvalId);
    const resolver = await this.withInteractionLock(async () => {
      if (!toolUseId || !this.pendingInteractions.has(toolUseId)) return null;
      this.pendingInteractions.delete(toolUseId);
      const pending = this.interactionResolvers.get(toolUseId) ?? null;
      this.interactionResolvers.delete(toolUseId);
      return pending;
    });
    if (!resolver) {
      // Already answered or timed out: make sure the card doesn't stay on "Allowing…".
      this.slackApprovals.delete(approvalId);
      this.slackRelayChannel?.closeApproval(approvalId, 'expired');
      return;
    }
    resolver(decision === 'allow' ? 'allow' : 'deny');
  }

  /** `help` or `/growth …` sent as an ordinary DM. Returns true when handled. */
  async handleSlackRelayTextCommand(message: RemoteMessage): Promise<boolean> {
    if (message.channelType !== 'slack' || message.channelId !== SLACK_RELAY_CHANNEL_ID) {
      return false;
    }
    const handle = slackRelayReplyHandleOf(message);
    const ownerId = this.slackRelayProvider?.getSlackUserId();
    if (!handle || !ownerId || message.sender.id !== ownerId) return false;
    const command = parseSlackTextCommand(message.content.text || '');
    if (!command) return false;
    await this.handleSlackRelayCommand(command.name, command.arg, handle);
    return true;
  }

  private async handleSlackRelayCommand(
    name: SlackRelayCommandName,
    arg: string | undefined,
    handle: string
  ): Promise<void> {
    const channel = this.slackRelayChannel;
    const ownerId = this.slackRelayProvider?.getSlackUserId();
    if (!channel || !ownerId) return;
    log('[RemoteManager] Slack relay command:', name);
    try {
      switch (name) {
        case 'new':
          await this.slackNewChat(ownerId, handle, arg);
          return;
        case 'chats':
          this.slackListChats(ownerId, handle);
          return;
        case 'model':
          await this.slackModel(handle, arg);
          return;
        case 'workspace':
          await this.slackWorkspace(ownerId, handle, arg);
          return;
        case 'pick':
          await this.slackPick(ownerId, handle, arg);
          return;
        case 'open':
          await this.slackOpenChat(ownerId, handle, arg);
          return;
        case 'stop':
          await this.slackStopChat(ownerId, handle);
          return;
        case 'status':
          this.slackChatStatus(ownerId, handle);
          return;
        case 'help':
          channel.sendNotice(handle, slackRelayHelpText());
          return;
      }
    } catch (error) {
      logError('[RemoteManager] Slack relay command failed:', error);
      channel.sendNotice(
        handle,
        'Something went wrong handling that command. Check York IE GrowthOS on your computer.'
      );
    }
  }

  private currentSlackBinding(ownerId: string): {
    remoteSessionId: string;
    actualSessionId?: string;
    workingDirectory?: string;
  } | null {
    const mapping = this.messageRouter.getSessionMapping('slack', SLACK_RELAY_CHANNEL_ID, ownerId);
    if (!mapping) return null;
    return {
      remoteSessionId: mapping.sessionId,
      actualSessionId: this.reverseSessionIdMapping.get(mapping.sessionId),
      workingDirectory: mapping.workingDirectory,
    };
  }

  /** Unbind the Slack DM from its chat (the desktop chat itself is untouched). Returns its folder. */
  private async detachSlackBinding(ownerId: string): Promise<string | undefined> {
    const current = this.currentSlackBinding(ownerId);
    if (!current) return undefined;
    if (current.actualSessionId) await this.removeRemoteSession(current.actualSessionId);
    this.messageRouter.clearSession(current.remoteSessionId);
    return current.workingDirectory;
  }

  private async slackNewChat(ownerId: string, handle: string, prompt?: string): Promise<void> {
    const workingDirectory = await this.detachSlackBinding(ownerId);
    this.messageRouter.bindDmSession('slack', SLACK_RELAY_CHANNEL_ID, ownerId, {
      workingDirectory,
    });
    if (prompt) {
      await this.routeMessage({
        id: `slack-cmd-${opaqueId()}`,
        channelType: 'slack',
        channelId: SLACK_RELAY_CHANNEL_ID,
        sender: { id: ownerId, isBot: false },
        content: { type: 'text', text: prompt },
        timestamp: Date.now(),
        isGroup: false,
        isMentioned: true,
        raw: { replyHandle: handle },
      });
      return;
    }
    this.slackRelayChannel?.sendNotice(handle, 'Started a new chat. Send a message to begin.');
  }

  private slackListChats(ownerId: string, handle: string): void {
    const now = Date.now();
    for (const [token, entry] of this.slackChatTokens) {
      if (entry.expiresAt <= now) this.slackChatTokens.delete(token);
    }
    const current = this.currentSlackBinding(ownerId)?.actualSessionId;
    const sessions = (this.agentExecutor?.listSessions?.() ?? [])
      .filter((session) => Boolean(session?.id))
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      .slice(0, SLACK_CHAT_LIST_SIZE);

    const chats: SlackRelayChatEntry[] = sessions.map((session) => {
      const token = opaqueId();
      this.slackChatTokens.set(token, {
        sessionId: session.id,
        expiresAt: now + SLACK_CHAT_TOKEN_TTL_MS,
      });
      const updated = formatUpdatedLabel(session.updatedAt ?? now, now);
      return {
        token,
        title: session.title || 'Untitled chat',
        updatedLabel: session.status === 'running' ? `${updated}  ·  working` : updated,
        current: session.id === current,
      };
    });
    this.slackRelayChannel?.sendChatList(handle, chats);
  }

  private async slackOpenChat(ownerId: string, handle: string, token?: string): Promise<void> {
    const channel = this.slackRelayChannel;
    const notice = (text: string) => channel?.sendNotice(handle, text);
    const entry = token ? this.slackChatTokens.get(token) : undefined;
    if (!entry || entry.expiresAt <= Date.now()) {
      notice(`That chat list has expired. Run \`${SLACK_RELAY_SLASH_COMMAND} chats\` again.`);
      return;
    }
    const target = entry.sessionId;
    if (this.agentExecutor?.hasSession && !this.agentExecutor.hasSession(target)) {
      notice('That chat no longer exists.');
      return;
    }
    const session = this.agentExecutor?.getSession?.(target);
    const title = session?.title || 'Untitled chat';
    if (this.currentSlackBinding(ownerId)?.actualSessionId === target) {
      notice(`You're already in "${title}".`);
      return;
    }

    const existingRemote = this.sessionIdMapping.get(target);
    if (existingRemote) {
      const info = this.sessionChannelMapping.get(existingRemote);
      if (info && (info.channelType !== 'slack' || info.channelId !== SLACK_RELAY_CHANNEL_ID)) {
        notice('That chat is connected to another remote channel.');
        return;
      }
    }
    // Remote control stays confined to the allowed folders, also for existing chats.
    if (session?.cwd && !(await this.messageRouter.isWithinAllowedRoots(session.cwd))) {
      notice(
        "That chat's folder isn't allowed for remote control. Open it on your computer instead."
      );
      return;
    }

    await this.detachSlackBinding(ownerId);
    const mapping = this.messageRouter.bindDmSession('slack', SLACK_RELAY_CHANNEL_ID, ownerId, {
      sessionId: existingRemote,
      workingDirectory: session?.cwd,
    });
    if (!existingRemote) {
      this.remoteSessionIds.add(mapping.sessionId);
      this.sessionIdMapping.set(target, mapping.sessionId);
      this.reverseSessionIdMapping.set(mapping.sessionId, target);
      this.sessionChannelMapping.set(mapping.sessionId, {
        channelType: 'slack',
        channelId: SLACK_RELAY_CHANNEL_ID,
      });
      this.sessionOwnerMapping.set(mapping.sessionId, ownerId);
    }
    markStrictRemoteSession(target);
    notice(`Switched to "${title}". Your next message continues this chat.`);
    this.slackRelayProvider?.notify(
      'Slack switched chats',
      `Slack messages now continue "${title}". Every action still needs your approval in Slack.`
    );
  }

  private async slackStopChat(ownerId: string, handle: string): Promise<void> {
    const actualSessionId = this.currentSlackBinding(ownerId)?.actualSessionId;
    const session = actualSessionId ? this.agentExecutor?.getSession?.(actualSessionId) : null;
    if (!actualSessionId || (session && session.status !== 'running')) {
      this.slackRelayChannel?.sendNotice(handle, 'Nothing is running right now.');
      return;
    }
    await this.agentExecutor?.stopSession(actualSessionId);
    this.slackRelayChannel?.sendNotice(handle, 'Stopped.');
  }

  private describeSlackCurrentModel(models: BackendModelInfo[]): string {
    const provider = this.slackRelayProvider;
    return (
      provider?.getCurrentModelLabel?.() || describeModel(provider?.getCurrentModel?.(), models)
    );
  }

  private slackChatStatus(ownerId: string, handle: string): void {
    const settings = [
      `Model: ${this.describeSlackCurrentModel([])}`,
      `Workspace: ${describeWorkspace(remoteConfigStore.getSlackRelayWorkspace())}`,
    ];
    const binding = this.currentSlackBinding(ownerId);
    if (!binding?.actualSessionId) {
      this.slackRelayChannel?.sendNotice(
        handle,
        [
          `No chat yet. Send a message to start one, or run ${SLACK_RELAY_SLASH_COMMAND} chats to pick one.`,
          ...settings,
        ].join('\n')
      );
      return;
    }
    const session = this.agentExecutor?.getSession?.(binding.actualSessionId);
    const folder = binding.workingDirectory || session?.cwd || this.defaultWorkingDirectory;
    const lines = [
      `Current chat: ${session?.title || 'Untitled chat'}`,
      `Status: ${session?.status === 'running' ? 'working on it' : 'idle'}`,
      ...settings,
      ...(folder ? [`Folder: ${folder}`] : []),
    ];
    this.slackRelayChannel?.sendNotice(handle, lines.join('\n'));
  }

  /** Model / workspace list as buttons, or as text when the backend predates pickers. */
  private sendSlackPicker<T>(
    handle: string,
    kind: SlackRelayPickerKind,
    choices: SlackRelayChoice<T>[],
    currentKey: string | undefined,
    note: string,
    select: (
      choice: SlackRelayChoice<T>
    ) =>
      | { kind: 'model'; modelId: string; label: string }
      | { kind: 'workspace'; workspace: ActiveDivision }
  ): void {
    const channel = this.slackRelayChannel;
    if (!channel) return;
    const now = Date.now();
    for (const [token, entry] of this.slackPickTokens) {
      if (entry.expiresAt <= now) this.slackPickTokens.delete(token);
    }
    const shown = choices.slice(0, SLACK_RELAY_PICKER_MAX_ITEMS);
    if (channel.supportsPickers) {
      const items = shown.map((choice) => {
        const token = opaqueId();
        const current = choice.key === currentKey;
        if (!current) {
          this.slackPickTokens.set(token, {
            ...select(choice),
            expiresAt: now + SLACK_CHAT_TOKEN_TTL_MS,
          });
        }
        return { token, label: choice.label, detail: choice.detail, current };
      });
      channel.sendPicker(handle, { kind, items, ...(note ? { note } : {}) });
      return;
    }
    const lines = shown.map(
      (choice) =>
        `• *${choice.label}*${choice.detail ? ` (${choice.detail})` : ''}${
          choice.key === currentKey ? ' – current' : ''
        }`
    );
    channel.sendNotice(
      handle,
      [note, ...lines, `Type \`${SLACK_RELAY_SLASH_COMMAND} ${kind} <name>\` to switch.`]
        .filter(Boolean)
        .join('\n')
    );
  }

  private async slackModel(handle: string, query?: string): Promise<void> {
    const provider = this.slackRelayProvider;
    const notice = (text: string) => this.slackRelayChannel?.sendNotice(handle, text);
    if (!provider?.listModels || !provider.selectModel) {
      notice("Changing the model from Slack isn't available in this version.");
      return;
    }
    const models = await provider.listModels();
    const choices = buildModelChoices(models);
    const current = provider.getCurrentModel?.();
    const currentNote = `Current model: ${this.describeSlackCurrentModel(models)}.`;
    const pick = (choice: SlackRelayChoice<string>) => ({
      kind: 'model' as const,
      modelId: choice.value,
      label: choice.label,
    });

    if (!query) {
      this.sendSlackPicker(handle, 'model', choices, current, currentNote, pick);
      return;
    }
    const matches = matchChoices(choices, query);
    if (matches.length === 1) {
      await this.applySlackModel(handle, matches[0].value, matches[0].label);
      return;
    }
    const note =
      matches.length === 0
        ? `No model matches "${query}". ${currentNote}`
        : `Several models match "${query}". Pick one.`;
    this.sendSlackPicker(handle, 'model', matches.length ? matches : choices, current, note, pick);
  }

  private async applySlackModel(handle: string, modelId: string, label: string): Promise<void> {
    const provider = this.slackRelayProvider;
    const notice = (text: string) => this.slackRelayChannel?.sendNotice(handle, text);
    if (!provider?.selectModel) return;
    if (provider.getCurrentModel?.() === modelId) {
      notice(`Already using ${label}.`);
      return;
    }
    const error = await provider.selectModel(modelId);
    if (error) {
      notice(`Couldn't switch the model: ${error}`);
      return;
    }
    notice(`Model switched to ${label}. This also applies on your computer.`);
    provider.notify('Slack changed the model', `York IE GrowthOS now uses ${label}.`);
  }

  private async slackWorkspace(ownerId: string, handle: string, query?: string): Promise<void> {
    const provider = this.slackRelayProvider;
    const notice = (text: string) => this.slackRelayChannel?.sendNotice(handle, text);
    if (!provider?.listWorkspaceSources) {
      notice("Changing the workspace from Slack isn't available in this version.");
      return;
    }
    const sources = await provider.listWorkspaceSources();
    const choices = buildWorkspaceChoices(sources.folders, sources.projects);
    const current = remoteConfigStore.getSlackRelayWorkspace();
    const currentKey = workspaceKey(current);
    const currentNote = `Current workspace: ${describeWorkspace(current)}.`;
    const loadNote = sources.error ? ` Some projects couldn't load: ${sources.error}` : '';
    const pick = (choice: SlackRelayChoice<ActiveDivision>) => ({
      kind: 'workspace' as const,
      workspace: choice.value,
    });

    if (!query) {
      const more =
        choices.length > SLACK_RELAY_PICKER_MAX_ITEMS
          ? ` Showing ${SLACK_RELAY_PICKER_MAX_ITEMS} of ${choices.length}; type \`${SLACK_RELAY_SLASH_COMMAND} workspace <name>\` to find others.`
          : '';
      this.sendSlackPicker(
        handle,
        'workspace',
        choices,
        currentKey,
        `${currentNote}${more}${loadNote}`,
        pick
      );
      return;
    }
    const matches = matchChoices(choices, query);
    if (matches.length === 1) {
      await this.applySlackWorkspace(ownerId, handle, matches[0].value);
      return;
    }
    if (matches.length === 0) {
      notice(`No workspace matches "${query}". ${currentNote}${loadNote}`);
      return;
    }
    this.sendSlackPicker(
      handle,
      'workspace',
      matches,
      currentKey,
      `Several workspaces match "${query}". Pick one.`,
      pick
    );
  }

  /** New Slack chats start in this workspace; the DM moves to a fresh chat there. */
  private async applySlackWorkspace(
    ownerId: string,
    handle: string,
    workspace: ActiveDivision
  ): Promise<void> {
    const label = describeWorkspace(workspace);
    if (workspaceKey(workspace) === workspaceKey(remoteConfigStore.getSlackRelayWorkspace())) {
      this.slackRelayChannel?.sendNotice(handle, `Already in ${label}.`);
      return;
    }
    remoteConfigStore.setSlackRelayWorkspace(workspace.kind === 'general' ? null : workspace);
    const workingDirectory = await this.detachSlackBinding(ownerId);
    this.messageRouter.bindDmSession('slack', SLACK_RELAY_CHANNEL_ID, ownerId, {
      workingDirectory,
    });
    this.slackRelayChannel?.sendNotice(
      handle,
      `Switched to the ${label} workspace. Your next message starts a new chat there.`
    );
    this.slackRelayProvider?.notify(
      'Slack switched workspace',
      `New Slack chats now start in ${label}.`
    );
  }

  private async slackPick(ownerId: string, handle: string, token?: string): Promise<void> {
    const entry = token ? this.slackPickTokens.get(token) : undefined;
    if (!token || !entry || entry.expiresAt <= Date.now()) {
      this.slackRelayChannel?.sendNotice(
        handle,
        `That list has expired. Run \`${SLACK_RELAY_SLASH_COMMAND} model\` or \`${SLACK_RELAY_SLASH_COMMAND} workspace\` again.`
      );
      return;
    }
    this.slackPickTokens.delete(token);
    if (entry.kind === 'model') {
      await this.applySlackModel(handle, entry.modelId, entry.label);
    } else {
      await this.applySlackWorkspace(ownerId, handle, entry.workspace);
    }
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * Set up gateway event handlers
   */
  private setupGatewayEvents(): void {
    if (!this.gateway) return;

    this.gateway.on('event', (event) => {
      this.emit('event', event);
    });

    this.gateway.on('gateway.pairing_request', (data) => {
      log('[RemoteManager] New pairing request:', data);
      this.emitToRenderer({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        type: 'remote.pairing_request' as any,
        payload: data,
      });
    });

    this.gateway.on('gateway.started', () => {
      this.emitStatusUpdate();
    });

    this.gateway.on('gateway.stopped', () => {
      this.emitStatusUpdate();
    });
  }

  /**
   * Register configured channels
   */
  private async registerChannels(config: RemoteConfig): Promise<void> {
    if (!this.gateway) return;

    // Register Feishu channel if configured
    const feishuConfig = config.channels.feishu;
    if (feishuConfig && feishuConfig.appId && feishuConfig.appSecret) {
      const feishuChannel = new FeishuChannel(feishuConfig);
      this.gateway.registerChannel(feishuChannel);

      // Set up webhook handler
      this.gateway.on(
        'webhook:feishu',
        (data: {
          headers: Record<string, string>;
          body: string;
          respond: (status: number, responseData: unknown) => void;
        }) => {
          const result = feishuChannel.handleWebhook(data.headers, data.body);
          data.respond(result.status, result.data);
        }
      );

      log('[RemoteManager] Feishu channel registered');
    }

    // Slack relay (platform bot via York backend) takes precedence over manual Slack tokens.
    const provider = this.slackRelayProvider;
    const slackUserId = provider?.getSlackUserId() ?? null;
    if (config.channels.slackRelay?.enabled && provider && slackUserId) {
      if (!provider.isSlackConnected()) {
        this.slackRelayLastError = 'Slack is not connected.';
      } else {
        const relayChannel = new SlackRelayChannel({
          getUpgradeHeaders: () => provider.getUpgradeHeaders(),
          getSlackUserToken: () => provider.getSlackUserToken(),
          expectedSlackUserId: slackUserId,
          onActivity: () => this.noteSlackRelayActivity(),
          onStateChange: (state) => this.handleSlackRelayStateChange(state),
        });
        relayChannel.onAction((action) => {
          this.handleSlackRelayAction(action).catch((err) =>
            logError('[RemoteManager] Slack relay action failed:', err)
          );
        });
        this.slackRelayChannel = relayChannel;
        this.setStrictChannel('slack', true);
        this.gateway.addOwnerIdentity('slack', slackUserId);
        this.gateway.registerChannel(relayChannel);
        log('[RemoteManager] Slack relay channel registered');
        return;
      }
    }
    this.setStrictChannel('slack', false);

    // Register Slack channel if configured
    const slackConfig = config.channels.slack;
    if (slackConfig && slackConfig.botToken) {
      const slackChannel = new SlackChannel(slackConfig);
      this.gateway.registerChannel(slackChannel);

      // Set up webhook handler for webhook mode
      this.gateway.on(
        'webhook:slack',
        (data: {
          headers: Record<string, string>;
          body: string;
          respond: (status: number, responseData: unknown) => void;
        }) => {
          const result = slackChannel.handleWebhook(data.headers, data.body);
          data.respond(result.status, result.data);
        }
      );

      log('[RemoteManager] Slack channel registered');
    }

    // TODO: Register other channels (WeChat, Telegram, DingTalk)
  }

  /**
   * Load paired users from config
   */
  private loadPairedUsers(): void {
    if (!this.gateway) return;
    const users = remoteConfigStore.getPairedUsers();

    for (const user of users) {
      this.gateway.restorePairedUser(user);
      log('[RemoteManager] Loaded paired user:', user.userId);
    }
  }

  /**
   * Execute agent for remote message
   */
  private async executeAgent(
    sessionId: string,
    prompt: string,
    content: ContentBlock[],
    workingDirectory: string | undefined,
    channelType: ChannelType,
    channelId: string,
    senderId: string,
    _onMessage: (message: Message) => void,
    _onPartial: (delta: string) => void,
    originalMessage?: RemoteMessage
  ): Promise<void> {
    const slackHandle =
      channelType === 'slack' && this.slackRelayChannel && originalMessage
        ? slackRelayReplyHandleOf(originalMessage)
        : null;
    // Immediate feedback in Slack before any agent work starts.
    if (slackHandle) this.slackRelayChannel?.sendStatus(slackHandle, 'start');
    try {
      await this.runAgentTurn(
        sessionId,
        prompt,
        content,
        workingDirectory,
        channelType,
        channelId,
        senderId,
        slackHandle
      );
    } catch (error) {
      if (slackHandle) this.slackRelayChannel?.sendStatus(slackHandle, 'error');
      throw error;
    }
  }

  private async runAgentTurn(
    sessionId: string,
    prompt: string,
    content: ContentBlock[],
    workingDirectory: string | undefined,
    channelType: ChannelType,
    channelId: string,
    senderId: string,
    slackHandle: string | null
  ): Promise<void> {
    if (!this.agentExecutor) {
      throw new Error('Agent executor not set');
    }

    log('[RemoteManager] Executing agent for session:', sessionId);
    log('[RemoteManager] Working directory:', workingDirectory || '(default)');

    // Check if this is a new remote session
    let isNewSession = !this.remoteSessionIds.has(sessionId);

    if (!isNewSession) {
      // Continue existing session - use actual session ID
      const actualSessionId = this.reverseSessionIdMapping.get(sessionId);
      if (!actualSessionId) {
        throw new Error(`No actual session ID found for remote session: ${sessionId}`);
      }

      // Proactive stale-binding probe: when the actual session was deleted from
      // the desktop UI, rebind BEFORE emitting the user message, so renderer /
      // stdio consumers never see a user turn aimed at a dead session.
      if (this.agentExecutor.hasSession && !this.agentExecutor.hasSession(actualSessionId)) {
        logWarn('[RemoteManager] Stale binding detected (session deleted), rebinding:', {
          remoteSessionId: sessionId,
          staleSessionId: actualSessionId,
        });
        await this.removeRemoteSession(actualSessionId);
        isNewSession = true;
      } else {
        log('[RemoteManager] Continuing session:', actualSessionId, 'for remote:', sessionId);
        if (this.isStrictChannel(channelType)) {
          markStrictRemoteSession(actualSessionId);
        }
        this.beginSlackTurn(actualSessionId, slackHandle);
        try {
          this.emitRemoteUserMessage(actualSessionId, content, prompt);
          await this.agentExecutor.continueSession(
            actualSessionId,
            prompt,
            content,
            workingDirectory
          );
          return;
        } catch (error) {
          // Safety net for the probe→continue race and for executors without
          // hasSession. Typed match first; the string fallback (anchored and
          // case-sensitive, matching SessionManager's exact prefix) only covers
          // executors that predate SessionNotFoundError. Any other error is
          // rethrown untouched — only a deleted session justifies a rebuild.
          const isSessionGone =
            error instanceof SessionNotFoundError ||
            (error instanceof Error && /^Session not found:/.test(error.message));
          if (!isSessionGone) {
            throw error;
          }
          logWarn('[RemoteManager] Stale binding detected, recreating session:', {
            remoteSessionId: sessionId,
            staleSessionId: actualSessionId,
          });
          await this.removeRemoteSession(actualSessionId);
          isNewSession = true;
        }
      }
    }

    if (isNewSession) {
      // Create new session with working directory
      const strict = this.isStrictChannel(channelType);
      const workspace = slackHandle ? remoteConfigStore.getSlackRelayWorkspace() : null;
      const newSession = await this.agentExecutor.startSession(
        buildRemoteSessionTitle(prompt),
        prompt,
        workingDirectory,
        {
          ...(strict ? { strictRemote: true } : {}),
          ...(content.some((block) => block.type === 'image') ? { content } : {}),
          ...(workspace ? { workspace } : {}),
        }
      );
      if (strict) {
        this.slackRelayProvider?.notify(
          'Remote session started',
          `A ${channelType} message started "${newSession.title}". Every action will need your approval in ${channelType}.`
        );
      }

      // Map remote session ID to actual session ID
      this.remoteSessionIds.add(sessionId);

      // Store bidirectional mapping
      this.sessionIdMapping.set(newSession.id, sessionId);
      this.reverseSessionIdMapping.set(sessionId, newSession.id);

      // Store channel info for routing responses back
      this.sessionChannelMapping.set(sessionId, { channelType, channelId });

      // Store session owner for interaction security verification
      this.sessionOwnerMapping.set(sessionId, senderId);
      this.beginSlackTurn(newSession.id, slackHandle);

      log(
        '[RemoteManager] Created new session:',
        newSession.id,
        'for remote:',
        sessionId,
        'cwd:',
        workingDirectory
      );
      log('[RemoteManager] Session mapping stored:', newSession.id, '<->', sessionId);
      log('[RemoteManager] Emitting session update to renderer for:', newSession.id);

      this.emitToRenderer({
        type: 'session.update',
        payload: { sessionId: newSession.id, updates: newSession },
      });

      this.emitRemoteUserMessage(newSession.id, content, prompt);
    }

    // Note: The actual response handling is done through the session manager
    // and agent runner callbacks. This is a simplified implementation.
    // In a full implementation, we would:
    // 1. Hook into the agent runner's streaming output
    // 2. Call onMessage and onPartial as the agent produces output
    // 3. Handle errors and timeouts
  }

  /**
   * Emit status update to renderer
   */
  private emitStatusUpdate(): void {
    // Type assertion needed because remote.status is not in ServerEvent union yet
    this.emitToRenderer({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      type: 'remote.status' as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      payload: this.getStatus() as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
  }

  /**
   * Emit event to renderer
   */
  private emitToRenderer(event: ServerEvent): void {
    if (this.sendToRenderer) {
      this.sendToRenderer(event);
    }
    this.emit('renderer-event', event);
  }

  /**
   * Send a remote user message to the local UI (remote sessions only)
   */
  private emitRemoteUserMessage(
    actualSessionId: string,
    content: ContentBlock[],
    prompt: string
  ): void {
    if (!this.sendToRenderer) return;

    const messageContent: ContentBlock[] =
      content && content.length > 0 ? content : [{ type: 'text', text: prompt }];

    const userMessage: Message = {
      id: uuidv4(),
      sessionId: actualSessionId,
      role: 'user',
      content: messageContent,
      timestamp: Date.now(),
    };

    this.sendToRenderer({
      type: 'stream.message',
      payload: { sessionId: actualSessionId, message: userMessage },
    });
  }
}

// Singleton instance
export const remoteManager = new RemoteManager();
