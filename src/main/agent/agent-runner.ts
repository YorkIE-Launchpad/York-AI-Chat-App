/**
 * @module main/agent/agent-runner
 *
 * AI query execution engine (1514 lines).
 *
 * Responsibilities:
 * - Runs AI conversations via the York IE agent SDK (createAgentSession)
 * - Routes providers via pi-ai SDK for model resolution
 * - Bridges MCP tools into SDK ToolDefinition format
 * - Streams responses back as ServerEvents (stream.message, stream.partial, trace.step)
 * - Skills injection, system prompt assembly, permission handling
 *
 * Dependencies: session-manager, mcp-manager, config-store, skills-manager
 */
import {
  createAgentSession,
  SessionManager as PiSessionManager,
  SettingsManager as PiSettingsManager,
  createCodingTools,
  type BashToolOptions,
  type AgentSession as PiAgentSession,
  type ToolDefinition,
} from '@mariozechner/pi-coding-agent';
import { Type, type TSchema } from '@sinclair/typebox';
import { getSharedAuthStorage, ModelRegistry } from './shared-auth';
import type { Session, Message, TraceStep, ServerEvent, ContentBlock } from '../../renderer/types';
import { v4 as uuidv4 } from 'uuid';
import { decidePermission, rememberAlwaysAllow } from '../config/permission-rules-store';
import {
  MCP_WRITE_DISABLED_MESSAGE,
  isMcpWriteAccessDenied,
} from '../config/mcp-write-access-store';
import { PathResolver } from '../sandbox/path-resolver';
import { MCPManager } from '../mcp/mcp-manager';
import { mcpConfigStore } from '../mcp/mcp-config-store';
import {
  log,
  logWarn,
  logError,
  logCtx,
  logCtxWarn,
  logCtxError,
  logTiming,
} from '../utils/logger';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { execFileSync, spawn } from 'child_process';
import { app } from 'electron';
import { setMaxListeners } from 'node:events';
import { getSandboxAdapter } from '../sandbox/sandbox-adapter';
import { pathConverter } from '../sandbox/wsl-bridge';
import { SandboxSync } from '../sandbox/sandbox-sync';
import { extractArtifactsFromText, buildArtifactTraceSteps } from '../utils/artifact-parser';
import { getDefaultShell } from '../utils/shell-resolver';
import { PluginRuntimeService } from '../skills/plugin-runtime-service';
import type { SkillsAdapter } from '../skills/skills-adapter';
import {
  expandLaunchPadSkillIntent,
  expandYorkOsSkillIntent,
} from '../skills/skill-intent-expand';
import {
  discoverSkillsFromPaths,
  expandAtSkillMentions,
  expandSlashSkillPrompt,
} from '../skills/slash-skill-expand';
import { AgentRuntimeExtensionManager } from '../extensions/agent-runtime-extension-manager';
import { configStore } from '../config/config-store';
import { getClientAppVersion, resolveBackendClientApiKey } from '../config/backend-auth';
import { normalizeOpenAICompatibleBaseUrl } from '../config/auth-utils';
import { buildThinkingModePromptSection, resolveThinkingLevel } from '../../shared/thinking-mode';
import { withThinkToolIfEnabled } from '../tools/think-tool';
import {
  applyBackendManagedCredentials,
  isBackendManagedProvider,
} from '../../shared/backend-config';
import { withAppVersionHeader } from '../../shared/client-version';
import {
  filterModelsForOpenRouterKey,
  resolveYorkPaidEcoFallback,
} from '../../shared/openrouter-fallback';
import {
  isOpenRouterAccountLimitError,
  openRouterKeyRequiredMessage,
  openRouterLimitUserMessage,
} from '../../shared/openrouter-limit';
import {
  OPENROUTER_LIMIT_FALLBACK_NOTE,
  hasOpenRouterUserApiKey,
  withOpenRouterUserKeyHeader,
} from '../../shared/openrouter-user-key';
import { fetchBackendModels } from '../config/backend-client';
import { reportHubGovernanceUsageFromCompletion } from '../hub/hub-ai-governance';
import {
  buildTerminalErrorEmissionDetails,
  buildTerminalErrorMessage,
  isSdkRecoverableContextOverflowError,
  resolveAbortDisposition,
  resolveAssistantStreamErrorText,
  resolveMessageEndPayload,
  shouldPreserveExistingTrace,
  toUserFacingErrorText,
} from './agent-runner-message-end';
import {
  applyPiModelRuntimeOverrides,
  buildSyntheticPiModel,
  resolvePiRegistryModel,
  resolvePiRouteProtocol,
  resolveSyntheticPiModelFallback,
} from './pi-model-resolution';
import { formatAutoRouteLabel, resolveAutoModelIfNeeded } from './auto-model-resolve';
import { AUTO_MODEL_ID } from '../../shared/auto-model';
import {
  buildDivisionActiveProjectContext,
  buildDivisionSystemPrompt,
  filterMcpToolsForDivision,
  filterModelsForDivision,
  generalWorkspaceOpenRouterOnlyMessage,
  isProviderAllowedInDivision,
  normalizeSessionDivision,
  type SessionDivisionFields,
} from '../../shared/workspace-division';
import { applyProjectScopedMcpResultFilter } from '../../shared/project-mcp-scope';
import { prepareCompanyProjectScopedMcpArgs as prepareProjectScopedMcpArgs } from '../../shared/company-project-mcp-scope';
import type { OnProjectScopeViolation } from '../../shared/project-mcp-scope';
import {
  createProjectScopeViolationReporter,
  emitProjectScopeBlock,
} from './project-scope-violation';
import { buildPiSessionRuntimeSignature } from './pi-session-runtime';
import { buildProfileInstructionsBlock } from './profile-instructions';
import { buildWorkspaceTopLevelListing } from '../utils/workspace-snapshot';
import { createFolderManager } from '../folders/folder-manager';
import { initDatabase } from '../db/database';
import {
  LoopGuard,
  buildAbortUserMessage,
  buildHaltSteerMessage,
  buildWarnSteerMessage,
  type LoopGuardDecision,
  type ToolCallDescriptor,
} from './agent-runner-loop-guard';
import {
  normalizeMcpToolResultForModel,
  normalizeToolExecutionResultForUi,
} from './tool-result-utils';
import {
  augmentMcpToolDescription,
  compressToolResultTextForModel,
  leanMcpToolArgs,
} from './mcp-tool-payload';
import {
  MCP_CALL_TOOL_NAME,
  MCP_SEARCH_TOOLS_NAME,
  selectCustomToolsForModel,
  type McpToolExposureMode,
} from './mcp-tool-budget';
import {
  MULTI_STEER_INCOMPLETE_REASONS,
  INCOMPLETE_TURN_MULTI_STEER_MAX,
  buildIncompleteTurnSteerMessage,
  detectIncompleteTurn,
  incompleteTurnFailureMessage,
  summarizeContentBlocks,
  type TurnContentSummary,
} from './incomplete-turn';
import {
  LaunchPadTurnProgress,
  isLaunchPadPollToolForLoopGuard,
  type OnLaunchPadProgressRecord,
} from './launchpad-turn-progress';
import { fetchOllamaModelInfo } from '../config/ollama-api';
import { createWindowsBashOperations } from './windows-bash-operations';
import { createCompactionExtensionFactory } from './compaction-extension';
import { remapCoworkVirtualPath, remapCoworkVirtualPathsInCommand } from './cowork-path-remap';

// Virtual workspace path shown to the model (hides real sandbox path)
const VIRTUAL_WORKSPACE_PATH = '/workspace';

/**
 * Estimate chars-per-token ratio based on content language.
 * CJK characters tokenize at ~1.5 chars/token vs ~4 for English.
 */
function estimateCharsPerToken(sampleText: string): number {
  if (!sampleText || sampleText.length === 0) return 4;
  const sample = sampleText.substring(0, 500);
  const cjkCount = (sample.match(/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g) || [])
    .length;
  const cjkRatio = cjkCount / sample.length;
  return 4 - cjkRatio * 2.5; // Range: 1.5 (pure CJK) ~ 4 (pure English)
}

// Escape characters that would break the cold-start `<conversation_history>`
// envelope when interpolated into XML tag bodies or attribute values. Raw user
// text blocks are intentionally not escaped (preserves legacy compatibility);
// only the new wrapper tags (`<thinking>`, `<tool_use>`, `<tool_result>`) and
// their attributes pass through these.
//
// Attribute values additionally need `"` escaped because attributes are
// double-quoted. Tag bodies do not (keeping `"` keeps JSON input legible to
// the model).
function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeXmlText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Serialize a message's content blocks into the XML representation used inside the
 * cold-start `<conversation_history>` preamble.
 *
 * Why this exists: when the cached pi-coding-agent SDK session is disposed (cwd
 * change or runtime-signature change), agent-runner rebuilds history from
 * DB-persisted messages. The previous implementation only kept `text` blocks,
 * which silently dropped `thinking`, `tool_use`, and `tool_result` blocks.
 * Providers that require previous reasoning/tool-call replay (e.g. DeepSeek V4
 * Flash) then fail with 400 on the next turn, and every other thinking-capable
 * model loses its reasoning trace across cwd switches (issue #162 \u2014 Bug B).
 *
 * Blocks handled:
 *   - text          \u2192 raw text (matches the legacy serializer's output)
 *   - thinking      \u2192 `<thinking>\u2026</thinking>`
 *   - tool_use      \u2192 `<tool_use name="\u2026" id="\u2026">{json input}</tool_use>`
 *   - tool_result   \u2192 `<tool_result tool_use_id="\u2026"[ is_error="true"]>\u2026</tool_result>`
 *   - image         \u2192 skipped (binary, cannot live inside an XML text preamble)
 *   - file_attachment \u2192 skipped (large, would bloat the prompt)
 */
export function serializeMessageContentForHistory(content: ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of content) {
    switch (block.type) {
      case 'text': {
        const text = block.text ?? '';
        if (text.length > 0) parts.push(text);
        break;
      }
      case 'thinking': {
        const thinking = block.thinking ?? '';
        if (thinking.length > 0) parts.push(`<thinking>${escapeXmlText(thinking)}</thinking>`);
        break;
      }
      case 'tool_use': {
        const name = block.name ?? 'unknown';
        const id = block.id ?? '';
        let inputStr: string;
        try {
          inputStr = JSON.stringify(block.input ?? {});
        } catch {
          inputStr = '{}';
        }
        parts.push(
          `<tool_use name="${escapeXmlAttr(name)}" id="${escapeXmlAttr(id)}">${escapeXmlText(inputStr)}</tool_use>`
        );
        break;
      }
      case 'tool_result': {
        const id = block.toolUseId ?? '';
        const errAttr = block.isError ? ' is_error="true"' : '';
        // Local type says `content: string`, but Anthropic-style payloads
        // from older message rows or third-party providers may store an
        // array of content blocks. Flatten defensively so we never serialize
        // "[object Object]".
        const rawContent = (block as { content: unknown }).content;
        let text: string;
        if (typeof rawContent === 'string') {
          text = rawContent;
        } else if (Array.isArray(rawContent)) {
          text = rawContent
            .map((c) =>
              c && typeof c === 'object' && 'text' in c
                ? String((c as { text: unknown }).text ?? '')
                : ''
            )
            .join('\n');
        } else {
          text = '';
        }
        // Compress JSON tool dumps (TOON / spillover) so cold-start history
        // cannot re-inject multi-MB Hub analytics payloads into the prompt.
        text = compressToolResultTextForModel(text);
        parts.push(
          `<tool_result tool_use_id="${escapeXmlAttr(id)}"${errAttr}>${escapeXmlText(text)}</tool_result>`
        );
        break;
      }
      case 'image':
      case 'file_attachment':
        // Skip — not representable as XML text in a history preamble.
        break;
      case 'meeting_attachment': {
        const title = (block as { title?: string }).title || 'Meeting';
        const id = (block as { meetingId?: string }).meetingId || '';
        parts.push(`[Attached meeting: ${title}${id ? ` (${id})` : ''}]`);
        break;
      }
    }
  }
  return parts.join('\n');
}

// Bundled node/npx paths never change at runtime — resolve once.
let cachedBundledNodePaths: { node: string; npx: string } | null | undefined = undefined;

function getBundledNodePaths(): { node: string; npx: string } | null {
  if (cachedBundledNodePaths !== undefined) {
    return cachedBundledNodePaths;
  }
  const platform = process.platform;
  const arch = process.arch;
  let resourcesPath: string;
  if (!app.isPackaged) {
    const projectRoot = path.join(__dirname, '..', '..');
    resourcesPath = path.join(projectRoot, 'resources', 'node', `${platform}-${arch}`);
  } else {
    resourcesPath = path.join(process.resourcesPath, 'node');
  }
  const binDir = platform === 'win32' ? resourcesPath : path.join(resourcesPath, 'bin');
  const nodePath = path.join(binDir, platform === 'win32' ? 'node.exe' : 'node');
  const npxPath = path.join(binDir, platform === 'win32' ? 'npx.cmd' : 'npx');
  cachedBundledNodePaths =
    fs.existsSync(nodePath) && fs.existsSync(npxPath) ? { node: nodePath, npx: npxPath } : null;
  return cachedBundledNodePaths;
}

/**
 * Resolve bundled Python bin directory path (if available).
 * Checks packaged and dev layouts, returns the bin dir containing python3.
 */
function resolveBundledPythonBinDir(): string | null {
  const platform = process.platform;
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';

  const candidates: string[] = [];
  if (!app.isPackaged) {
    const projectRoot = path.join(__dirname, '..', '..');
    if (platform === 'darwin') {
      candidates.push(path.join(projectRoot, 'resources', 'python', `darwin-${arch}`, 'bin'));
    }
    candidates.push(path.join(projectRoot, 'resources', 'python', 'bin'));
  } else {
    // Packaged layout: Resources/python/bin/python3
    candidates.push(path.join(process.resourcesPath, 'python', 'bin'));
  }

  const pythonExe = platform === 'win32' ? 'python.exe' : 'python3';
  for (const binDir of candidates) {
    if (fs.existsSync(path.join(binDir, pythonExe))) return binDir;
  }
  return null;
}

/**
 * Resolve bundled tools directory (cliclick etc., macOS only).
 */
function resolveBundledToolsBinDir(): string | null {
  if (process.platform !== 'darwin') return null;
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';

  const candidates: string[] = [];
  if (!app.isPackaged) {
    const projectRoot = path.join(__dirname, '..', '..');
    candidates.push(path.join(projectRoot, 'resources', 'tools', `darwin-${arch}`, 'bin'));
    candidates.push(path.join(projectRoot, 'resources', 'tools', 'bin'));
  } else {
    candidates.push(path.join(process.resourcesPath, 'tools', `darwin-${arch}`, 'bin'));
    candidates.push(path.join(process.resourcesPath, 'tools', 'bin'));
  }

  for (const binDir of candidates) {
    if (fs.existsSync(binDir)) return binDir;
  }
  return null;
}

/**
 * One-time enrichment of process.env.PATH for build (production) mode.
 *
 * In dev mode, Electron inherits the user's full shell PATH, so Skill commands
 * like `python3` and `node` just work. In build mode, `process.env.PATH` is
 * minimal (often just `/usr/bin:/bin`).
 *
 * This function:
 * 1. Restores the user's login-shell PATH (safe: uses execFileSync, not execSync)
 * 2. Prepends bundled Node, Python, and tools bin dirs (highest priority)
 * 3. Deduplicates all entries
 * 4. Writes the result back to `process.env.PATH`
 *
 * Called once before the first `createCodingTools()` — subsequent calls are no-ops.
 */
let pathEnriched = false;

async function enrichProcessPathForBuild(): Promise<void> {
  if (pathEnriched) return;
  pathEnriched = true;

  if (!app.isPackaged) {
    log('[CoworkAgentRunner] Dev mode — skipping PATH enrichment');
    return;
  }

  const platform = process.platform;
  const delimiter = platform === 'win32' ? ';' : ':';
  const currentPaths = (process.env.PATH || '').split(delimiter).filter((p: string) => p.trim());

  // 1. Restore user's login-shell PATH
  let shellPaths: string[] = [];
  if (platform === 'darwin' || platform === 'linux') {
    try {
      const shell = getDefaultShell();
      const output = (
        execFileSync(shell, ['-l', '-c', 'echo $PATH'], {
          encoding: 'utf-8',
          timeout: 5000,
          env: { ...process.env, HOME: os.homedir() },
        }) as string
      ).trim();
      if (output) {
        shellPaths = output.split(':').filter((p: string) => p.trim());
        log(`[CoworkAgentRunner] Restored ${shellPaths.length} paths from login shell`);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logWarn(`[CoworkAgentRunner] Could not restore shell PATH: ${message}`);
    }
  } else if (platform === 'win32') {
    try {
      const output = (
        execFileSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-Command',
            "[Environment]::GetEnvironmentVariable('Path', 'User') + ';' + [Environment]::GetEnvironmentVariable('Path', 'Machine')",
          ],
          { encoding: 'utf-8', timeout: 5000 }
        ) as string
      ).trim();
      if (output) {
        shellPaths = output.split(';').filter((p: string) => p.trim());
        log(`[CoworkAgentRunner] Restored ${shellPaths.length} paths from Windows registry`);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logWarn(`[CoworkAgentRunner] Could not restore Windows PATH: ${message}`);
    }
  }

  // 2. Collect bundled bin directories (highest priority)
  const bundledDirs: string[] = [];

  const nodePaths = getBundledNodePaths();
  if (nodePaths) {
    bundledDirs.push(path.dirname(nodePaths.node));
  }

  const pythonBinDir = resolveBundledPythonBinDir();
  if (pythonBinDir) {
    bundledDirs.push(pythonBinDir);
  }

  const toolsBinDir = resolveBundledToolsBinDir();
  if (toolsBinDir) {
    bundledDirs.push(toolsBinDir);
  }

  // 3. Merge: bundled (highest) → shell → current process, deduplicate
  const seen = new Set<string>();
  const merged: string[] = [];

  for (const p of [...bundledDirs, ...shellPaths, ...currentPaths]) {
    const normalized = platform === 'win32' ? p.toLowerCase() : p;
    if (!seen.has(normalized)) {
      seen.add(normalized);
      merged.push(p);
    }
  }

  process.env.PATH = merged.join(delimiter);
  log(
    `[CoworkAgentRunner] Enriched process.env.PATH for build mode: ${bundledDirs.length} bundled + ${shellPaths.length} shell + ${currentPaths.length} process → ${merged.length} total`
  );
}

// Shared pi-ai auth storage — created once, reused across sessions.

/**
 * Bridge MCP tools from MCPManager into ToolDefinition[] format for the agent SDK.
 * Each MCP tool becomes a customTool whose execute() delegates to mcpManager.callTool().
 */
function buildMcpCustomTools(
  mcpManager: MCPManager,
  division?: Partial<SessionDivisionFields> | null,
  onProjectScopeViolation?: OnProjectScopeViolation | null,
  sessionId?: string | null,
  onLaunchPadProgress?: OnLaunchPadProgressRecord | null
): ToolDefinition[] {
  const mcpTools = mcpManager.getTools();
  return mcpTools.map((mcpTool) => {
    // Wrap the raw JSON Schema inputSchema as a TypeBox TSchema
    const parameters = Type.Unsafe<Record<string, unknown>>(
      mcpTool.inputSchema as Record<string, unknown>
    );

    const baseDescription = mcpTool.description || `MCP tool from ${mcpTool.serverName}`;
    const toolDef: ToolDefinition<TSchema, unknown> = {
      name: mcpTool.name,
      label: `${mcpTool.serverName} → ${mcpTool.originalName || mcpTool.name}`,
      description: augmentMcpToolDescription(mcpTool.name, baseDescription),
      parameters,
      async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
        try {
          const leanArgs = leanMcpToolArgs(params as Record<string, unknown>, mcpTool.inputSchema);
          const prepared = prepareProjectScopedMcpArgs(mcpTool.name, leanArgs, division);
          if (prepared.kind === 'block') {
            emitProjectScopeBlock(
              onProjectScopeViolation,
              prepared,
              mcpTool.name,
              division,
              sessionId
            );
            onLaunchPadProgress?.({
              toolName: mcpTool.name,
              args: leanArgs,
              resultText: prepared.message,
              isError: true,
            });
            return {
              content: [{ type: 'text' as const, text: prepared.message }],
              details: undefined,
            };
          }
          const result = await mcpManager.callTool(mcpTool.name, prepared.args);
          const normalizedResult = normalizeMcpToolResultForModel(result, {
            compress: !prepared.filterResult,
          });
          const text = prepared.filterResult
            ? compressToolResultTextForModel(
                applyProjectScopedMcpResultFilter(mcpTool.name, normalizedResult.text, division)
              )
            : normalizedResult.text;
          onLaunchPadProgress?.({
            toolName: mcpTool.name,
            args: prepared.args,
            resultText: text,
            isError: false,
          });
          return {
            content: [{ type: 'text' as const, text }],
            details:
              normalizedResult.images.length > 0
                ? { openCoworkImages: normalizedResult.images }
                : undefined,
          };
        } catch (err: unknown) {
          logError(`[CoworkAgentRunner] MCP tool ${mcpTool.name} failed:`, err);
          onLaunchPadProgress?.({
            toolName: mcpTool.name,
            args: params as Record<string, unknown>,
            resultText: err instanceof Error ? err.message : String(err),
            isError: true,
          });
          throw err instanceof Error ? err : new Error(String(err));
        }
      },
    };
    return toolDef;
  });
}

/**
 * Get shell environment with proper PATH (including node, npm, etc.)
 * GUI apps on macOS don't inherit shell PATH, so we need to extract it
 */

function safeStringify(value: unknown, space = 0): string {
  try {
    return JSON.stringify(value, null, space);
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    return `[Unserializable: ${details}]`;
  }
}

function summarizeMessageForLog(message: unknown): Record<string, unknown> {
  if (!message || typeof message !== 'object') {
    return { present: false };
  }

  const typedMessage = message as {
    role?: unknown;
    stopReason?: unknown;
    content?: unknown[];
    usage?: unknown;
  };
  const content = Array.isArray(typedMessage.content) ? typedMessage.content : [];

  return {
    present: true,
    role: typeof typedMessage.role === 'string' ? typedMessage.role : undefined,
    stopReason: typedMessage.stopReason ?? undefined,
    contentBlocks: content.length,
    contentTypes: content.slice(0, 8).map((block) => {
      if (!block || typeof block !== 'object') {
        return typeof block;
      }
      const type = (block as { type?: unknown }).type;
      return typeof type === 'string' ? type : 'unknown';
    }),
    usage: normalizeTokenUsage(typedMessage.usage),
  };
}

function toErrorText(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  if (error && typeof error === 'object') {
    const maybeMessage = (error as { message?: unknown }).message;
    if (typeof maybeMessage === 'string' && maybeMessage.trim()) {
      return maybeMessage;
    }
  }
  const serialized = safeStringify(error);
  if (serialized.startsWith('[Unserializable:')) {
    return String(error);
  }
  return serialized;
}

function normalizeTokenUsage(usage: unknown): Message['tokenUsage'] | undefined {
  if (!usage || typeof usage !== 'object') {
    return undefined;
  }

  const raw = usage as {
    input?: unknown;
    output?: unknown;
    input_tokens?: unknown;
    output_tokens?: unknown;
    inputTokens?: unknown;
    outputTokens?: unknown;
  };

  const input = raw.input ?? raw.input_tokens ?? raw.inputTokens;
  const output = raw.output ?? raw.output_tokens ?? raw.outputTokens;

  if (typeof input !== 'number' || typeof output !== 'number') {
    return undefined;
  }

  return { input, output };
}

interface AgentRunnerOptions {
  sendToRenderer: (event: ServerEvent) => void;
  saveMessage?: (message: Message) => void;
  requestSudoPassword?: (
    sessionId: string,
    toolUseId: string,
    command: string
  ) => Promise<string | null>;
  requestPermission?: (
    sessionId: string,
    toolUseId: string,
    toolName: string,
    input: Record<string, unknown>
  ) => Promise<'allow' | 'deny' | 'allow_always'>;
}

interface CachedPiSession {
  session: PiAgentSession;
  modelId: string;
  thinkingLevel: string;
  runtimeSignature: string;
  skillsSignature?: string;
  toolsSignature?: string;
  ollamaNumCtx?: { value: number };
  /** Whether SDK auto-compaction is enabled for overflow recovery. */
  compactionEnabled: boolean;
}

/**
 * CoworkAgentRunner - Uses @mariozechner/pi-coding-agent SDK
 *
 * Environment variables should be set before running:
 *   ANTHROPIC_BASE_URL=https://openrouter.ai/api
 *   ANTHROPIC_AUTH_TOKEN=your_openrouter_api_key
 *   ANTHROPIC_API_KEY="" (must be empty)
 */
export class CoworkAgentRunner {
  private sendToRenderer: (event: ServerEvent) => void;
  private saveMessage?: (message: Message) => void;
  private requestSudoPassword?: (
    sessionId: string,
    toolUseId: string,
    command: string
  ) => Promise<string | null>;
  private requestPermission?: (
    sessionId: string,
    toolUseId: string,
    toolName: string,
    input: Record<string, unknown>
  ) => Promise<'allow' | 'deny' | 'allow_always'>;
  private pathResolver: PathResolver;
  private mcpManager?: MCPManager;
  private _pluginRuntimeService?: PluginRuntimeService;
  private _skillsAdapter?: SkillsAdapter;
  private extensionManager?: AgentRuntimeExtensionManager;
  private activeControllers: Map<string, AbortController> = new Map();
  private piSessions: Map<string, CachedPiSession> = new Map();
  private toolDisplayNameCache: Map<string, string> = new Map();
  /** Per-session LaunchPad MCP progress for the active prompt turn (wait/continue). */
  private launchPadProgressBySession: Map<string, LaunchPadTurnProgress> = new Map();
  private static readonly MAX_CACHED_SESSIONS = 50;

  // Per-instance caches — invalidated when the underlying config changes.
  private _mcpServersCache: { fingerprint: string; servers: Record<string, unknown> } | null = null;
  private _skillsSetupDone = false;

  /**
   * Start a fresh LaunchPad progress tracker for this session turn.
   * Tool wrappers call the returned recorder; it always targets the current progress instance.
   */
  private beginLaunchPadProgress(sessionId: string): OnLaunchPadProgressRecord {
    this.launchPadProgressBySession.set(sessionId, new LaunchPadTurnProgress());
    return (record) => {
      this.launchPadProgressBySession.get(sessionId)?.record(record);
    };
  }

  private getLaunchPadProgressSnapshot(sessionId: string, userPrompt: string) {
    return this.launchPadProgressBySession.get(sessionId)?.snapshot(userPrompt) ?? null;
  }

  /**
   * Clear SDK session cache for a session
   * Called when session's cwd changes - SDK sessions are bound to cwd
   */
  clearSdkSession(sessionId: string): void {
    const cached = this.piSessions.get(sessionId);
    if (cached) {
      try {
        cached.session.dispose();
      } catch (e) {
        logWarn('[CoworkAgentRunner] dispose error:', e);
      }
      this.piSessions.delete(sessionId);
      log('[CoworkAgentRunner] Disposed pi session for:', sessionId);
    }
    this.launchPadProgressBySession.delete(sessionId);
  }

  clearAllSdkSessions(): void {
    for (const sessionId of Array.from(this.piSessions.keys())) {
      this.clearSdkSession(sessionId);
    }
  }

  /** Call after the user installs / removes a skill so the next query re-links everything. */
  invalidateSkillsSetup(): void {
    this._skillsSetupDone = false;
  }

  /** Call after the user changes MCP server config so the next query rebuilds mcpServers. */
  invalidateMcpServersCache(): void {
    this._mcpServersCache = null;
    // Sessions stay alive — MCP tools are rebuilt each query via buildMcpCustomTools()
    log('[CoworkAgentRunner] MCP servers cache invalidated — tools will rebuild on next query');
  }

  // TODO: Credentials should be served via a secure MCP tool or IPC channel,
  // not injected as plaintext into the system prompt. The getCredentialsPrompt()
  // method was removed to eliminate credential leakage risk.

  /**
   * Generate bundled executable path hints for production mode system prompt.
   * In dev mode returns empty string (user PATH already works).
   * This is a defense-in-depth layer — even if PATH enrichment works, explicit
   * paths help the model avoid ambiguity when Skills reference bare commands.
   */
  private getBundledPathHints(): string {
    if (!app.isPackaged) return '';

    const hints: string[] = [];

    const nodePaths = getBundledNodePaths();
    if (nodePaths) {
      hints.push(`- node: ${nodePaths.node}`);
      hints.push(`- npx: ${nodePaths.npx}`);
    }

    const pythonBinDir = resolveBundledPythonBinDir();
    if (pythonBinDir) {
      const pythonExe = process.platform === 'win32' ? 'python.exe' : 'python3';
      const pipExe = process.platform === 'win32' ? 'pip.exe' : 'pip3';
      hints.push(`- python3: ${path.join(pythonBinDir, pythonExe)}`);
      if (fs.existsSync(path.join(pythonBinDir, pipExe))) {
        hints.push(`- pip3: ${path.join(pythonBinDir, pipExe)}`);
      }
    }

    if (hints.length === 0) return '';

    return `<bundled_executables>
This application bundles its own executables. When executing commands, prefer these absolute paths:
${hints.join('\n')}
</bundled_executables>`;
  }

  /** Fallback skill path resolution when SkillsAdapter is not provided. */
  private legacySkillPaths(): string[] {
    const paths: string[] = [];
    const builtin = this.getBuiltinSkillsPath();
    if (builtin && fs.existsSync(builtin)) paths.push(builtin);
    const global = this.getConfiguredGlobalSkillsDir();
    if (global && fs.existsSync(global)) paths.push(global);
    return paths;
  }

  private async resolveSkillPaths(sessionId?: string): Promise<string[]> {
    const basePaths = this._skillsAdapter
      ? this._skillsAdapter.getSkillPaths()
      : this.legacySkillPaths();
    const mergedPaths = new Set(
      basePaths.filter((item): item is string => Boolean(item && fs.existsSync(item)))
    );
    const appliedPlugins: Array<{ name: string; path: string }> = [];

    if (this._pluginRuntimeService) {
      try {
        const runtimePlugins = await this._pluginRuntimeService.getEnabledRuntimePlugins();
        for (const plugin of runtimePlugins) {
          if (!plugin.componentsEnabled.skills || plugin.componentCounts.skills <= 0) {
            continue;
          }
          const runtimeSkillsPath = path.join(plugin.runtimePath, 'skills');
          if (!fs.existsSync(runtimeSkillsPath)) {
            continue;
          }
          mergedPaths.add(runtimeSkillsPath);
          appliedPlugins.push({ name: plugin.name, path: runtimeSkillsPath });
        }
      } catch (error) {
        logWarn('[CoworkAgentRunner] Failed to resolve runtime plugin skill paths:', error);
      }
    }

    if (sessionId && appliedPlugins.length > 0) {
      this.sendToRenderer({
        type: 'plugins.runtimeApplied',
        payload: { sessionId, plugins: appliedPlugins },
      });
    }

    return Array.from(mergedPaths);
  }

  /**
   * Get the built-in skills directory (shipped with the app)
   */
  private getBuiltinSkillsPath(): string {
    // In development, skills are in the project's .claude/skills directory
    // In production, they're extracted via extraResources to resources/skills
    const appPath = app.getAppPath();
    const unpackedPath = appPath.replace(/\.asar$/, '.asar.unpacked');

    const possiblePaths = [
      // Development: relative to this file
      path.join(__dirname, '..', '..', '..', '.claude', 'skills'),
      // Production: extraResources extracts .claude/skills → resources/skills
      // This is the preferred production path (real directory, no asar issues)
      path.join(process.resourcesPath || '', 'skills'),
      // Legacy: in app.asar.unpacked (for older builds with asarUnpack)
      ...(this.physicalDirExists(path.join(unpackedPath, '.claude', 'skills'))
        ? [path.join(unpackedPath, '.claude', 'skills')]
        : []),
      // Last resort: read from inside the asar archive (Electron intercepts this)
      path.join(appPath, '.claude', 'skills'),
    ];

    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        log('[CoworkAgentRunner] Found built-in skills at:', p);
        return p;
      }
    }

    logWarn('[CoworkAgentRunner] No built-in skills directory found');
    return '';
  }

  /**
   * Check if a directory physically exists on disk, bypassing Electron's
   * asar interception.
   */
  private physicalDirExists(dirPath: string): boolean {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const originalFs = require('original-fs') as typeof import('fs');
      return originalFs.existsSync(dirPath) && originalFs.statSync(dirPath).isDirectory();
    } catch {
      return false;
    }
  }

  private getAppAgentDir(): string {
    return path.join(app.getPath('userData'), 'claude');
  }

  private getRuntimeSkillsDir(): string {
    return path.join(this.getAppAgentDir(), 'skills');
  }

  private getConfiguredGlobalSkillsDir(): string {
    const configuredPath = (configStore.get('globalSkillsPath') || '').trim();
    if (!configuredPath) {
      return this.getRuntimeSkillsDir();
    }

    const resolvedPath = path.resolve(configuredPath);
    try {
      if (!fs.existsSync(resolvedPath)) {
        fs.mkdirSync(resolvedPath, { recursive: true });
      }
      if (fs.statSync(resolvedPath).isDirectory()) {
        return resolvedPath;
      }
      logWarn(
        '[CoworkAgentRunner] Configured skills path is not a directory, fallback to runtime path:',
        resolvedPath
      );
    } catch (error) {
      logWarn(
        '[CoworkAgentRunner] Configured skills path is unavailable, fallback to runtime path:',
        resolvedPath,
        error
      );
    }

    return this.getRuntimeSkillsDir();
  }

  private getUserSkillsDir(): string {
    return path.join(app.getPath('home'), '.claude', 'skills');
  }

  private syncUserSkillsToAppDir(appSkillsDir: string): void {
    const userSkillsDir = this.getUserSkillsDir();
    if (!fs.existsSync(userSkillsDir)) {
      return;
    }

    const entries = fs.readdirSync(userSkillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const sourcePath = path.join(userSkillsDir, entry.name);
      const targetPath = path.join(appSkillsDir, entry.name);

      if (fs.existsSync(targetPath)) {
        try {
          const stat = fs.lstatSync(targetPath);
          if (!stat.isSymbolicLink()) {
            continue;
          }
          fs.unlinkSync(targetPath);
        } catch {
          continue;
        }
      }

      try {
        fs.symlinkSync(sourcePath, targetPath, 'dir');
      } catch (err) {
        try {
          this.copyDirectorySync(sourcePath, targetPath);
        } catch (copyErr) {
          logWarn('[CoworkAgentRunner] Failed to import user skill:', entry.name, copyErr);
        }
      }
    }
  }

  private syncConfiguredSkillsToRuntimeDir(runtimeSkillsDir: string): void {
    const configuredSkillsDir = this.getConfiguredGlobalSkillsDir();
    if (configuredSkillsDir === runtimeSkillsDir) {
      return;
    }
    if (!fs.existsSync(configuredSkillsDir) || !fs.statSync(configuredSkillsDir).isDirectory()) {
      return;
    }

    const entries = fs.readdirSync(configuredSkillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const sourcePath = path.join(configuredSkillsDir, entry.name);
      const targetPath = path.join(runtimeSkillsDir, entry.name);
      try {
        if (fs.existsSync(targetPath)) {
          // Use lstatSync so we don't follow symlinks — check the entry itself
          const stat = fs.lstatSync(targetPath);
          if (stat.isSymbolicLink()) {
            fs.unlinkSync(targetPath);
          } else {
            fs.rmSync(targetPath, { recursive: true, force: true });
          }
        }
        fs.symlinkSync(sourcePath, targetPath, 'dir');
      } catch (err) {
        try {
          this.copyDirectorySync(sourcePath, targetPath);
        } catch (copyErr) {
          logWarn('[CoworkAgentRunner] Failed to sync configured skill:', entry.name, copyErr);
        }
      }
    }
  }

  private copyDirectorySync(source: string, target: string): void {
    if (!fs.existsSync(target)) {
      fs.mkdirSync(target, { recursive: true });
    }

    const entries = fs.readdirSync(source);
    for (const entry of entries) {
      const sourcePath = path.join(source, entry);
      const targetPath = path.join(target, entry);
      const stat = fs.statSync(sourcePath);

      if (stat.isDirectory()) {
        this.copyDirectorySync(sourcePath, targetPath);
      } else {
        fs.copyFileSync(sourcePath, targetPath);
      }
    }
  }

  constructor(
    options: AgentRunnerOptions,
    pathResolver: PathResolver,
    mcpManager?: MCPManager,
    pluginRuntimeService?: PluginRuntimeService,
    skillsAdapter?: SkillsAdapter,
    extensionManager?: AgentRuntimeExtensionManager
  ) {
    this.sendToRenderer = options.sendToRenderer;
    this.saveMessage = options.saveMessage;
    this.requestSudoPassword = options.requestSudoPassword;
    this.requestPermission = options.requestPermission;
    this.pathResolver = pathResolver;
    this.mcpManager = mcpManager;
    this._pluginRuntimeService = pluginRuntimeService;
    this._skillsAdapter = skillsAdapter;
    this.extensionManager = extensionManager;

    log('[CoworkAgentRunner] Initialized with York IE agent SDK');
    log('[CoworkAgentRunner] Skills enabled: settingSources=[user, project], Skill tool enabled');
    if (mcpManager) {
      log('[CoworkAgentRunner] MCP support enabled');
    }
  }

  /**
   * Install a permission-gating hook on the pi-coding-agent session via
   * `agent.setBeforeToolCall`. This is the only interception point that
   * fires for built-in tools (read, bash, edit, write) — the SDK ignores
   * wrapped `execute` functions on built-in tools passed via `options.tools`.
   *
   * The hook consults `decidePermission` from the main-process rules cache:
   *  - 'allow' → delegate to SDK's original hook (proceeds normally)
   *  - 'deny'  → return { block: true, reason } (SDK treats as tool error)
   *  - 'ask'   → await requestPermission() IPC round-trip to PermissionDialog
   *
   * Known limitation: the async requestPermission wait (user dialog) causes
   * the renderer to miss UI update events. The tool executes correctly on
   * the backend, but the renderer's loading spinner may not clear. This is
   * a renderer-side issue tracked as a follow-up.
   */
  private installPermissionHook(piSession: PiAgentSession, sessionId: string): void {
    if (!this.requestPermission) {
      log('[CoworkAgentRunner] No requestPermission callback — skipping permission hook');
      return;
    }

    // Access the Agent instance (public readonly property on AgentSession)
    // and wrap its beforeToolCall hook with our permission gate.
    //
    // We must chain to the SDK's original beforeToolCall hook because it
    // fires extension tool_call events and manages the _agentEventQueue.
    // Without chaining, the renderer misses completion events.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const agent = (piSession as any).agent;
    if (!agent || typeof agent.setBeforeToolCall !== 'function') {
      logWarn(
        '[CoworkAgentRunner] Cannot access agent.setBeforeToolCall — skipping permission hook'
      );
      return;
    }

    // Capture the SDK's hook before we overwrite it
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sdkBeforeToolCall: ((ctx: any, signal?: AbortSignal) => Promise<any>) | undefined =
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (agent as any)._beforeToolCall;

    const requestPermission = this.requestPermission;
    const getDisplayName = (name: string): string => this.getToolDisplayName(name);

    agent.setBeforeToolCall(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (ctx: any, signal?: AbortSignal): Promise<any> => {
        const toolName: string = ctx.toolCall?.name ?? '';
        const input: Record<string, unknown> = ctx.args ?? {};

        const decision = decidePermission(sessionId, toolName, input);
        // Human-readable name for prompts/messages (e.g. MCP sanitized
        // 'mcp__chrome__chrome_screenshot__ab12' → 'chrome_screenshot').
        // Rule matching and rememberAlwaysAllow still use the canonical
        // `toolName` so allow-once decisions stay stable across calls.
        const displayName = getDisplayName(toolName);

        if (decision === 'deny') {
          const reason = isMcpWriteAccessDenied(toolName)
            ? MCP_WRITE_DISABLED_MESSAGE
            : `Tool '${displayName}' is denied by your permission rules.`;
          log(`[CoworkAgentRunner] Tool '${toolName}' denied: ${reason}`);
          return {
            block: true,
            reason,
          };
        }

        if (decision === 'ask') {
          const toolUseId = `${ctx.toolCall?.id ?? 'unknown'}-perm-${uuidv4().slice(0, 8)}`;
          let result: 'allow' | 'deny' | 'allow_always';
          try {
            // Send the display name to the renderer so the dialog shows a
            // human-readable tool name; canonical `toolName` is still used
            // for rule matching above and "always allow" memory below.
            result = await requestPermission(sessionId, toolUseId, displayName, input);
          } catch (permErr) {
            logError(
              `[CoworkAgentRunner] Permission request failed for '${toolName}' — failing closed`,
              permErr
            );
            return {
              block: true,
              reason: `Permission request failed for '${displayName}'; tool not executed.`,
            };
          }

          if (result === 'deny') {
            log(`[CoworkAgentRunner] Tool '${toolName}' denied by user`);
            return { block: true, reason: `User denied permission for '${displayName}'.` };
          }

          if (result === 'allow_always') {
            rememberAlwaysAllow(sessionId, toolName);
          }
        }

        // Allowed — delegate to SDK's original hook for event pipeline
        return sdkBeforeToolCall ? sdkBeforeToolCall(ctx, signal) : undefined;
      }
    );

    log(
      `[CoworkAgentRunner] Permission hook installed on session ${sessionId} via agent.setBeforeToolCall`
    );
  }

  /**
   * Check if a command contains sudo
   */
  private static isSudoCommand(command: string): boolean {
    return /\bsudo\b/.test(command);
  }

  private getToolDisplayName(toolName: string): string {
    const cached = this.toolDisplayNameCache.get(toolName);
    if (cached) {
      return cached;
    }

    let displayName = toolName;
    if (!toolName.startsWith('mcp__')) {
      this.toolDisplayNameCache.set(toolName, displayName);
      return displayName;
    }

    const mcpTool = this.mcpManager?.getTool(toolName);
    if (mcpTool?.originalName) {
      displayName = mcpTool.originalName;
    } else {
      const match = toolName.match(/^mcp__(.+?)__(.+)$/);
      displayName = match?.[2] || toolName;
    }

    this.toolDisplayNameCache.set(toolName, displayName);
    return displayName;
  }

  /**
   * Wrap the bash tool in the coding tools array to intercept sudo commands.
   * When a sudo command is detected, prompts the user for a password,
   * then rewrites the command to pipe the password into sudo -S.
   */
  private wrapBashToolForSudo(
    tools: ToolDefinition[],
    sessionId: string,
    effectiveCwd: string
  ): ToolDefinition[] {
    if (!this.requestSudoPassword) return tools;

    const requestSudoPassword = this.requestSudoPassword;

    return tools.map((tool) => {
      if (tool.name !== 'bash') return tool;

      const originalExecute = tool.execute;
      return {
        ...tool,
        execute: async (
          toolCallId: string,
          params: { command: string; timeout?: number },
          signal: AbortSignal | undefined,
          onUpdate: ((update: unknown) => void) | undefined,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ctx: any
        ) => {
          const command = params.command;

          if (CoworkAgentRunner.isSudoCommand(command)) {
            log('[CoworkAgentRunner] Sudo command detected, requesting password');
            const password = await requestSudoPassword(sessionId, toolCallId, command);

            if (!password) {
              log('[CoworkAgentRunner] Sudo password cancelled by user');
              return {
                content: [
                  { type: 'text' as const, text: 'Command cancelled: user denied sudo password.' },
                ],
                details: undefined as unknown,
              };
            }

            // Add -S flag to sudo invocations that don't already have it
            const rewrittenCommand = command.replace(/\bsudo\b(?!\s+-S)/g, 'sudo -S');

            // Pass password via stdin pipe so it never appears in process args
            // or environment variables. Uses async spawn with stdio: 'pipe'.
            log(
              '[CoworkAgentRunner] Executing sudo command with password injection (via stdin pipe)'
            );
            try {
              const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
              const shellArgs =
                process.platform === 'win32' ? ['/c', rewrittenCommand] : ['-c', rewrittenCommand];
              const timeoutMs = (params.timeout ?? 120) * 1000;
              const output = await new Promise<string>((resolve, reject) => {
                const child = spawn(shell, shellArgs, {
                  stdio: ['pipe', 'pipe', 'pipe'],
                  cwd: effectiveCwd,
                });
                let stdout = '';
                let stderr = '';
                const timer = setTimeout(() => {
                  child.kill('SIGKILL');
                  reject(new Error(`Sudo command timed out after ${timeoutMs}ms`));
                }, timeoutMs);
                child.stdout.on('data', (chunk: Buffer) => {
                  stdout += chunk.toString();
                });
                child.stderr.on('data', (chunk: Buffer) => {
                  stderr += chunk.toString();
                });
                child.on('error', (err) => {
                  clearTimeout(timer);
                  reject(err);
                });
                child.on('close', () => {
                  clearTimeout(timer);
                  resolve(stdout + stderr);
                });
                child.stdin.write(password + '\n');
                child.stdin.end();
              });
              return {
                content: [{ type: 'text' as const, text: output || '(no output)' }],
                details: undefined as unknown,
              };
            } catch (sudoErr) {
              logError('[CoworkAgentRunner] Sudo command failed:', sudoErr);
              throw sudoErr instanceof Error ? sudoErr : new Error(String(sudoErr));
            }
          }

          return originalExecute(toolCallId, params, signal, onUpdate, ctx);
        },
      } as ToolDefinition;
    });
  }

  /**
   * Remap virtual roots (`/mnt/user-data`, `/mnt/workspace`, `/workspace`) onto
   * the session workspace so skill-driven doc generation writes into the same folder.
   */
  private static wrapToolsForCoworkPathRemap(
    tools: ToolDefinition[],
    workspaceRoot: string
  ): ToolDefinition[] {
    if (!workspaceRoot) return tools;

    return tools.map((tool) => {
      const originalExecute = tool.execute;

      const toolName = tool.name.toLowerCase();

      if (toolName === 'bash') {
        return {
          ...tool,
          execute: async (
            toolCallId: string,
            params: { command: string; timeout?: number },
            signal: AbortSignal | undefined,
            onUpdate: ((update: unknown) => void) | undefined,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ctx: any
          ) => {
            const command = remapCoworkVirtualPathsInCommand(params.command, workspaceRoot);
            const nextParams = command === params.command ? params : { ...params, command };
            return originalExecute(toolCallId, nextParams, signal, onUpdate, ctx);
          },
        } as ToolDefinition;
      }

      if (toolName === 'write' || toolName === 'edit' || toolName === 'read') {
        return {
          ...tool,
          execute: async (
            toolCallId: string,
            params: { path?: string; [key: string]: unknown },
            signal: AbortSignal | undefined,
            onUpdate: ((update: unknown) => void) | undefined,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ctx: any
          ) => {
            if (typeof params.path !== 'string') {
              return originalExecute(toolCallId, params, signal, onUpdate, ctx);
            }
            const remapped = remapCoworkVirtualPath(params.path, workspaceRoot);
            const nextParams = remapped === params.path ? params : { ...params, path: remapped };
            return originalExecute(toolCallId, nextParams, signal, onUpdate, ctx);
          },
        } as ToolDefinition;
      }

      return tool;
    });
  }

  private static wrapBashToolWithDefaultTimeout(tools: ToolDefinition[]): ToolDefinition[] {
    const DEFAULT_BASH_TIMEOUT_SECONDS = 120;

    return tools.map((tool) => {
      if (tool.name !== 'bash') return tool;

      const originalExecute = tool.execute;
      return {
        ...tool,
        execute: async (
          toolCallId: string,
          params: { command: string; timeout?: number },
          signal: AbortSignal | undefined,
          onUpdate: ((update: unknown) => void) | undefined,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ctx: any
        ) => {
          const effectiveParams =
            params.timeout != null ? params : { ...params, timeout: DEFAULT_BASH_TIMEOUT_SECONDS };
          return originalExecute(toolCallId, effectiveParams, signal, onUpdate, ctx);
        },
      } as ToolDefinition;
    });
  }

  /**
   * Resolve current model string from runtime config.
   */
  private getCurrentModelString(preferredModel?: string): string {
    const routeModel = preferredModel?.trim();
    const configuredModel = configStore.get('model')?.trim();
    const model = routeModel || configuredModel || AUTO_MODEL_ID;
    logCtx('[CoworkAgentRunner] Current model:', model);
    logCtx(
      '[CoworkAgentRunner] Model source:',
      routeModel ? 'runtimeRoute.model' : configuredModel ? 'configStore.model' : 'default'
    );
    return model;
  }

  async run(session: Session, prompt: string, existingMessages: Message[]): Promise<void> {
    const runStartTime = Date.now();
    logCtx('[CoworkAgentRunner] run() started');

    let controller = new AbortController();
    try {
      // The SDK attaches many listeners on the same AbortSignal; raise the limit to avoid noisy warnings while debugging.
      setMaxListeners(0, controller.signal);
    } catch {
      // Older runtimes that cannot adjust EventTarget listener limits can be ignored.
    }
    this.activeControllers.set(session.id, controller);

    // Sandbox isolation state (defined outside try for finally access)
    let sandboxPath: string | null = null;
    let useSandboxIsolation = false;

    // Helper to convert real sandbox paths back to virtual workspace paths in output
    // Cache the compiled regex to avoid recompilation on every call
    let sandboxPathRegex: RegExp | null = null;
    const sanitizeOutputPaths = (content: string): string => {
      if (!sandboxPath || !useSandboxIsolation) return content;
      if (!sandboxPathRegex) {
        sandboxPathRegex = new RegExp(sandboxPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
      }
      // Replace real sandbox path with virtual workspace path
      return content.replace(sandboxPathRegex, VIRTUAL_WORKSPACE_PATH);
    };

    const thinkingStepId = uuidv4();
    let abortedByTimeout = false;
    // Set to true when the loop-guard unilaterally aborts (hash_abort / freq_abort).
    // The catch block consults this flag to avoid overwriting the 'error' trace
    // status that handleLoopGuardDecision has already published.
    let abortedByLoopGuard = false;
    // Set to true when the provider emits a terminal stream error mid-turn.
    // The catch block consults this flag to avoid overwriting the published
    // 'Request failed' trace state with a generic 'Cancelled' update.
    let abortedByStreamError = false;
    // OpenRouter account limits are key-wide — one hit → single York eco retry.
    const openRouterLimitRetry = {
      pending: false,
      done: false,
      rawError: '',
    };

    try {
      this.pathResolver.registerSession(session.id, session.mountedPaths);
      logTiming('pathResolver.registerSession', runStartTime);

      // Note: User message is now added by the frontend immediately for better UX
      // No need to send it again from backend

      // Send initial thinking trace
      this.sendTraceStep(session.id, {
        id: thinkingStepId,
        type: 'thinking',
        status: 'running',
        title: 'Processing request...',
        timestamp: Date.now(),
      });
      logTiming('sendTraceStep (thinking)', runStartTime);

      // Use session's cwd - each session has its own working directory
      const workingDir = session.cwd || undefined;
      logCtx('[CoworkAgentRunner] Working directory:', workingDir || '(none)');

      // Initialize sandbox sync if WSL mode is active
      const sandbox = getSandboxAdapter();

      if (sandbox.isWSL && sandbox.wslStatus?.distro && workingDir) {
        log('[CoworkAgentRunner] WSL mode active, initializing sandbox sync...');

        // Only show sync UI for new sessions (first message)
        const isNewSession = !SandboxSync.hasSession(session.id);

        if (isNewSession) {
          // Notify UI: syncing files (only for new sessions)
          this.sendToRenderer({
            type: 'sandbox.sync',
            payload: {
              sessionId: session.id,
              phase: 'syncing_files',
              message: 'Syncing files to sandbox...',
              detail: 'Copying project files to isolated WSL environment',
            },
          });
        }

        const syncResult = await SandboxSync.initSync(
          workingDir,
          session.id,
          sandbox.wslStatus.distro
        );

        if (syncResult.success) {
          sandboxPath = syncResult.sandboxPath;
          useSandboxIsolation = true;
          log(`[CoworkAgentRunner] Sandbox initialized: ${sandboxPath}`);
          log(
            `[CoworkAgentRunner]   Files: ${syncResult.fileCount}, Size: ${syncResult.totalSize} bytes`
          );

          if (isNewSession) {
            // Update UI with file count (only for new sessions)
            this.sendToRenderer({
              type: 'sandbox.sync',
              payload: {
                sessionId: session.id,
                phase: 'syncing_skills',
                message: 'Configuring skills...',
                detail: 'Copying built-in skills to sandbox',
                fileCount: syncResult.fileCount,
                totalSize: syncResult.totalSize,
              },
            });
          }

          // Copy skills to sandbox ~/.claude/skills/
          const builtinSkillsPath = this.getBuiltinSkillsPath();
          try {
            const distro = sandbox.wslStatus!.distro!;
            const sandboxSkillsPath = `${sandboxPath}/.claude/skills`;

            // Create .claude/skills directory in sandbox
            execFileSync('wsl', ['-d', distro, '-e', 'mkdir', '-p', sandboxSkillsPath], {
              encoding: 'utf-8',
              timeout: 10000,
            });

            if (builtinSkillsPath && fs.existsSync(builtinSkillsPath)) {
              // Use rsync via execFileSync with array args to avoid shell injection
              const wslSourcePath = pathConverter.toWSL(builtinSkillsPath);
              log(
                `[CoworkAgentRunner] Copying skills with rsync: ${wslSourcePath}/ -> ${sandboxSkillsPath}/`
              );

              execFileSync(
                'wsl',
                ['-d', distro, '-e', 'rsync', '-av', wslSourcePath + '/', sandboxSkillsPath + '/'],
                {
                  encoding: 'utf-8',
                  timeout: 120000, // 2 min timeout for large skill directories
                }
              );
            }

            const appSkillsDir = this.getRuntimeSkillsDir();
            if (!fs.existsSync(appSkillsDir)) {
              fs.mkdirSync(appSkillsDir, { recursive: true });
            }
            this.syncUserSkillsToAppDir(appSkillsDir);
            this.syncConfiguredSkillsToRuntimeDir(appSkillsDir);

            if (fs.existsSync(appSkillsDir)) {
              const wslSourcePath = pathConverter.toWSL(appSkillsDir);
              log(
                `[CoworkAgentRunner] Copying app skills with rsync: ${wslSourcePath}/ -> ${sandboxSkillsPath}/`
              );

              execFileSync(
                'wsl',
                ['-d', distro, '-e', 'rsync', '-avL', wslSourcePath + '/', sandboxSkillsPath + '/'],
                {
                  encoding: 'utf-8',
                  timeout: 120000, // 2 min timeout for large skill directories
                }
              );
            }

            // List copied skills for verification
            const copiedSkills = execFileSync(
              'wsl',
              ['-d', distro, '-e', 'ls', sandboxSkillsPath],
              {
                encoding: 'utf-8',
                timeout: 10000,
              }
            )
              .trim()
              .split(/\r?\n/)
              .filter(Boolean);

            log(`[CoworkAgentRunner] Skills copied to sandbox: ${sandboxSkillsPath}`);
            log(`[CoworkAgentRunner]   Skills: ${copiedSkills.join(', ')}`);
          } catch (error) {
            logError('[CoworkAgentRunner] Failed to copy skills to sandbox:', error);
          }

          if (isNewSession) {
            // Notify UI: sync complete (only for new sessions)
            this.sendToRenderer({
              type: 'sandbox.sync',
              payload: {
                sessionId: session.id,
                phase: 'ready',
                message: 'Sandbox ready',
                detail: `Synced ${syncResult.fileCount} files`,
                fileCount: syncResult.fileCount,
                totalSize: syncResult.totalSize,
              },
            });
          }
        } else {
          logError('[CoworkAgentRunner] Sandbox sync failed:', syncResult.error);
          log('[CoworkAgentRunner] Falling back to /mnt/ access (less secure)');

          if (isNewSession) {
            // Notify UI: error (only for new sessions)
            this.sendToRenderer({
              type: 'sandbox.sync',
              payload: {
                sessionId: session.id,
                phase: 'error',
                message: 'Sandbox file sync failed, falling back to direct access mode',
                detail: 'Falling back to direct access mode (less secure)',
              },
            });
          }
        }
      }

      // Initialize sandbox sync if Lima mode is active
      if (sandbox.isLima && sandbox.limaStatus?.instanceRunning && workingDir) {
        log('[CoworkAgentRunner] Lima mode active, initializing sandbox sync...');

        const { LimaSync } = await import('../sandbox/lima-sync');

        // Only show sync UI for new sessions (first message)
        const isNewLimaSession = !LimaSync.hasSession(session.id);

        if (isNewLimaSession) {
          // Notify UI: syncing files (only for new sessions)
          this.sendToRenderer({
            type: 'sandbox.sync',
            payload: {
              sessionId: session.id,
              phase: 'syncing_files',
              message: 'Syncing files to sandbox...',
              detail: 'Copying project files to isolated Lima environment',
            },
          });
        }

        const syncResult = await LimaSync.initSync(workingDir, session.id);

        if (syncResult.success) {
          sandboxPath = syncResult.sandboxPath;
          useSandboxIsolation = true;
          log(`[CoworkAgentRunner] Sandbox initialized: ${sandboxPath}`);
          log(
            `[CoworkAgentRunner]   Files: ${syncResult.fileCount}, Size: ${syncResult.totalSize} bytes`
          );

          if (isNewLimaSession) {
            // Update UI with file count (only for new sessions)
            this.sendToRenderer({
              type: 'sandbox.sync',
              payload: {
                sessionId: session.id,
                phase: 'syncing_skills',
                message: 'Configuring skills...',
                detail: 'Copying built-in skills to sandbox',
                fileCount: syncResult.fileCount,
                totalSize: syncResult.totalSize,
              },
            });
          }

          // Copy skills to sandbox ~/.claude/skills/
          const builtinSkillsPath = this.getBuiltinSkillsPath();
          try {
            const sandboxSkillsPath = `${sandboxPath}/.claude/skills`;

            // Create .claude/skills directory in sandbox
            execFileSync(
              'limactl',
              ['shell', 'claude-sandbox', '--', 'mkdir', '-p', sandboxSkillsPath],
              {
                encoding: 'utf-8',
                timeout: 10000,
              }
            );

            if (builtinSkillsPath && fs.existsSync(builtinSkillsPath)) {
              // Use rsync via execFileSync with array args to avoid shell injection
              // Lima mounts /Users directly, so paths are the same
              log(
                `[CoworkAgentRunner] Copying skills with rsync: ${builtinSkillsPath}/ -> ${sandboxSkillsPath}/`
              );

              execFileSync(
                'limactl',
                [
                  'shell',
                  'claude-sandbox',
                  '--',
                  'rsync',
                  '-av',
                  builtinSkillsPath + '/',
                  sandboxSkillsPath + '/',
                ],
                {
                  encoding: 'utf-8',
                  timeout: 120000, // 2 min timeout for large skill directories
                }
              );
            }

            const appSkillsDir = this.getRuntimeSkillsDir();
            if (!fs.existsSync(appSkillsDir)) {
              fs.mkdirSync(appSkillsDir, { recursive: true });
            }
            this.syncUserSkillsToAppDir(appSkillsDir);
            this.syncConfiguredSkillsToRuntimeDir(appSkillsDir);

            if (fs.existsSync(appSkillsDir)) {
              log(
                `[CoworkAgentRunner] Copying app skills with rsync: ${appSkillsDir}/ -> ${sandboxSkillsPath}/`
              );

              execFileSync(
                'limactl',
                [
                  'shell',
                  'claude-sandbox',
                  '--',
                  'rsync',
                  '-avL',
                  appSkillsDir + '/',
                  sandboxSkillsPath + '/',
                ],
                {
                  encoding: 'utf-8',
                  timeout: 120000, // 2 min timeout for large skill directories
                }
              );
            }

            // List copied skills for verification
            const copiedSkills = execFileSync(
              'limactl',
              ['shell', 'claude-sandbox', '--', 'ls', sandboxSkillsPath],
              {
                encoding: 'utf-8',
                timeout: 10000,
              }
            )
              .trim()
              .split(/\r?\n/)
              .filter(Boolean);

            log(`[CoworkAgentRunner] Skills copied to sandbox: ${sandboxSkillsPath}`);
            log(`[CoworkAgentRunner]   Skills: ${copiedSkills.join(', ')}`);
          } catch (error) {
            logError('[CoworkAgentRunner] Failed to copy skills to sandbox:', error);
          }

          if (isNewLimaSession) {
            // Notify UI: sync complete (only for new sessions)
            this.sendToRenderer({
              type: 'sandbox.sync',
              payload: {
                sessionId: session.id,
                phase: 'ready',
                message: 'Sandbox ready',
                detail: `Synced ${syncResult.fileCount} files`,
                fileCount: syncResult.fileCount,
                totalSize: syncResult.totalSize,
              },
            });
          }
        } else {
          logError('[CoworkAgentRunner] Sandbox sync failed:', syncResult.error);
          log('[CoworkAgentRunner] Falling back to direct access (less secure)');

          if (isNewLimaSession) {
            // Notify UI: error (only for new sessions)
            this.sendToRenderer({
              type: 'sandbox.sync',
              payload: {
                sessionId: session.id,
                phase: 'error',
                message: 'Sandbox file sync failed, falling back to direct access mode',
                detail: 'Falling back to direct access mode (less secure)',
              },
            });
          }
        }
      }

      // Check if current user message includes images
      const lastUserMessage =
        existingMessages.length > 0 ? existingMessages[existingMessages.length - 1] : null;

      logCtx('[CoworkAgentRunner] Total messages:', existingMessages.length);

      const hasImages =
        lastUserMessage?.content.some((c) => (c as { type?: string }).type === 'image') || false;
      if (hasImages) {
        log('[CoworkAgentRunner] User message contains images');
      }

      logTiming('before pi-ai model resolution', runStartTime);

      // Resolve model via pi-ai
      const runtimeConfig = configStore.getAll();
      if (session.modelLocked && session.model?.trim()) {
        runtimeConfig.model = session.model.trim();
        if (session.provider?.trim()) {
          runtimeConfig.provider = session.provider.trim() as typeof runtimeConfig.provider;
          runtimeConfig.activeProfileKey =
            session.provider.trim() as typeof runtimeConfig.activeProfileKey;
          runtimeConfig.customProtocol =
            session.provider === 'gemini'
              ? 'gemini'
              : session.provider === 'openai' || session.provider === 'openrouter'
                ? 'openai'
                : 'anthropic';
          if (isBackendManagedProvider(session.provider)) {
            const creds = applyBackendManagedCredentials({
              provider: session.provider,
              apiKey: '',
              baseUrl: '',
            });
            runtimeConfig.apiKey = creds.apiKey || runtimeConfig.apiKey;
            runtimeConfig.baseUrl = creds.baseUrl || runtimeConfig.baseUrl;
          }
        }
        logCtx(
          '[CoworkAgentRunner] Using locked session model:',
          runtimeConfig.provider,
          runtimeConfig.model
        );
      }
      let modelString = this.getCurrentModelString(runtimeConfig.model);
      let resolvedProvider = runtimeConfig.provider;
      let resolvedCustomProtocol = runtimeConfig.customProtocol;
      let resolvedApiKey = runtimeConfig.apiKey;

      // Extract prompt text for Auto routing heuristics
      const promptTextForAuto =
        typeof prompt === 'string'
          ? prompt
          : lastUserMessage?.content
              ?.map((block) => {
                const b = block as { type?: string; text?: string };
                return b.type === 'text' && typeof b.text === 'string' ? b.text : '';
              })
              .filter(Boolean)
              .join('\n') || '';

      const contextChars = existingMessages.reduce((sum, msg) => {
        for (const block of msg.content || []) {
          const b = block as { type?: string; text?: string };
          if (b.type === 'text' && typeof b.text === 'string') sum += b.text.length;
        }
        return sum;
      }, 0);

      const autoRoute = await resolveAutoModelIfNeeded({
        model: modelString,
        preference: runtimeConfig.autoModelPreference,
        promptText: promptTextForAuto,
        hasImages,
        messageCount: existingMessages.length,
        contextChars,
        division: session,
      });

      if (autoRoute.usedAuto && autoRoute.pick) {
        modelString = autoRoute.modelId;
        resolvedProvider = autoRoute.provider;
        resolvedCustomProtocol = autoRoute.customProtocol;
        resolvedApiKey = autoRoute.apiKey || runtimeConfig.apiKey;
        runtimeConfig.provider = autoRoute.provider;
        runtimeConfig.customProtocol = autoRoute.customProtocol;
        runtimeConfig.baseUrl = autoRoute.baseUrl;
        runtimeConfig.apiKey = resolvedApiKey;
        runtimeConfig.model = autoRoute.modelId;

        const routedLabel = formatAutoRouteLabel(autoRoute.pick);
        this.sendToRenderer({
          type: 'session.autoRoute',
          payload: {
            sessionId: session.id,
            provider: autoRoute.pick.provider,
            modelId: autoRoute.pick.modelId,
            tier: autoRoute.pick.tier,
            score: autoRoute.pick.score,
            reason: autoRoute.pick.reason,
          },
        });
        this.sendToRenderer({
          type: 'session.update',
          payload: {
            sessionId: session.id,
            updates: { model: routedLabel },
          },
        });
      }

      // Provider must be set (OpenRouter BYOK / York proxy gating is FE-owned).
      if (!isProviderAllowedInDivision(resolvedProvider, session)) {
        const msg = generalWorkspaceOpenRouterOnlyMessage();
        this.sendMessage(session.id, {
          id: uuidv4(),
          sessionId: session.id,
          role: 'assistant',
          content: [{ type: 'text', text: `**Error**: ${msg}` }],
          timestamp: Date.now(),
        });
        this.sendTraceUpdate(session.id, thinkingStepId, {
          status: 'error',
          title: 'Model provider unavailable',
        });
        return;
      }

      const configProtocol = resolvePiRouteProtocol(resolvedProvider, resolvedCustomProtocol);

      // Normalize base URL for OpenAI-compatible providers (strips copy-pasted endpoint suffixes)
      const rawBaseUrl = runtimeConfig.baseUrl?.trim() || undefined;
      const effectiveBaseUrl =
        configProtocol === 'openai' && resolvedProvider !== 'ollama'
          ? normalizeOpenAICompatibleBaseUrl(rawBaseUrl) || rawBaseUrl
          : rawBaseUrl;

      let usedSyntheticModel = false;
      let piModel = resolvePiRegistryModel(modelString, {
        configProvider: configProtocol,
        customBaseUrl: effectiveBaseUrl,
        rawProvider: resolvedProvider,
        customProtocol: resolvedCustomProtocol,
      });

      if (!piModel) {
        usedSyntheticModel = true;
        // Synthetic fallback: construct a Model for unknown/custom models
        const synthetic = resolveSyntheticPiModelFallback({
          rawModel: modelString,
          resolvedModelString: modelString,
          rawProvider: resolvedProvider,
          routeProtocol: configProtocol,
          baseUrl: effectiveBaseUrl,
        });
        piModel = buildSyntheticPiModel(
          synthetic.modelId,
          synthetic.provider,
          configProtocol,
          effectiveBaseUrl,
          undefined,
          undefined,
          runtimeConfig.contextWindow,
          runtimeConfig.maxTokens
        );
        // Apply the same runtime overrides (developer role compat, base URL, API downgrade)
        // that resolvePiRegistryModel applies to registry models
        piModel = applyPiModelRuntimeOverrides(piModel, {
          configProvider: configProtocol,
          customBaseUrl: effectiveBaseUrl,
          rawProvider: resolvedProvider,
          customProtocol: resolvedCustomProtocol,
        });
        logCtxWarn(
          '[CoworkAgentRunner] Model not in pi-ai registry, using synthetic model:',
          modelString,
          '→',
          piModel.api
        );
      }
      logCtx('[CoworkAgentRunner] Resolved pi-ai model:', piModel.provider, piModel.id);

      if (resolvedProvider === 'openrouter') {
        const userKey = runtimeConfig.openRouterUserApiKey?.trim();
        if (!hasOpenRouterUserApiKey(userKey)) {
          const msg = openRouterKeyRequiredMessage();
          this.sendMessage(session.id, {
            id: uuidv4(),
            sessionId: session.id,
            role: 'assistant',
            content: [{ type: 'text', text: `**Error**: ${msg}` }],
            timestamp: Date.now(),
          });
          this.sendTraceUpdate(session.id, thinkingStepId, {
            status: 'error',
            title: 'OpenRouter key required',
          });
          return;
        }
        piModel = withOpenRouterUserKeyHeader(piModel, userKey);
      }

      // Definite model for the rest of this run (including York eco limit fallback).
      if (!piModel) {
        throw new Error('Failed to resolve pi-ai model');
      }
      if (isBackendManagedProvider(resolvedProvider)) {
        piModel = withAppVersionHeader(piModel, getClientAppVersion());
      }
      let activePiModel = piModel;

      // For Ollama: query actual context window from /api/show if user hasn't configured one
      const provider = resolvedProvider || 'anthropic';
      if (provider === 'ollama' && !runtimeConfig.contextWindow) {
        const ollamaBaseUrl =
          activePiModel.baseUrl || runtimeConfig.baseUrl || 'http://localhost:11434/v1';
        const ollamaInfo = await fetchOllamaModelInfo({
          baseUrl: ollamaBaseUrl,
          model: activePiModel.id,
          apiKey: runtimeConfig.apiKey,
        });
        if (ollamaInfo.contextWindow) {
          log(
            '[CoworkAgentRunner] Ollama /api/show reported contextWindow:',
            ollamaInfo.contextWindow,
            '(was:',
            activePiModel.contextWindow,
            ')'
          );
          activePiModel = { ...activePiModel, contextWindow: ollamaInfo.contextWindow };
        }
      }

      // Send context window info to renderer for UI display
      this.sendToRenderer({
        type: 'session.contextInfo',
        payload: {
          sessionId: session.id,
          contextWindow: activePiModel.contextWindow || 128000,
        },
      });

      // Set up API keys via AuthStorage (Cognito JWT for backend-managed proxy providers)
      const authStorage = getSharedAuthStorage();
      const apiKey = (
        await resolveBackendClientApiKey({
          provider,
          apiKey: runtimeConfig.apiKey,
        })
      ).trim();
      if (apiKey) {
        // Map our config provider to pi-ai provider name
        const piProvider =
          provider === 'custom' ? runtimeConfig.customProtocol || 'anthropic' : provider;
        authStorage.setRuntimeApiKey(piProvider, apiKey);
        // Also set the key for the model's native provider (e.g., when using
        // google/gemini via openrouter, pi-ai looks up "google" not "openrouter")
        if (activePiModel.provider !== piProvider) {
          authStorage.setRuntimeApiKey(activePiModel.provider, apiKey);
          log(
            '[CoworkAgentRunner] Set runtime API key for model provider:',
            activePiModel.provider
          );
        }
        log('[CoworkAgentRunner] Set runtime API key for config provider:', piProvider);
      } else {
        if (provider === 'ollama') {
          log(
            '[CoworkAgentRunner] Ollama configured without explicit API key; relying on OpenAI-compatible placeholder/env auth path',
            safeStringify({
              provider,
              modelProvider: activePiModel.provider,
              modelId: activePiModel.id,
              baseUrl: activePiModel.baseUrl || runtimeConfig.baseUrl || '',
            })
          );
        } else {
          logWarn('[CoworkAgentRunner] No API key configured for provider:', provider);
        }
      }

      // baseUrl is now embedded in the model object via resolvePiModel()
      logCtx(
        '[CoworkAgentRunner] Model baseUrl:',
        activePiModel.baseUrl,
        'api:',
        activePiModel.api
      );

      logTiming('after pi-ai model resolution', runStartTime);

      // the agent SDK handles path sandboxing via its own tools
      const imageCapable = true; // pi-ai models generally support images; let the model handle unsupported cases
      const effectiveCwd =
        useSandboxIsolation && sandboxPath ? sandboxPath : workingDir || process.cwd();

      // Use app-specific Claude config directory to avoid conflicts with user settings
      // SDK uses CLAUDE_CONFIG_DIR to locate skills
      const userAgentDir = this.getAppAgentDir();

      // Skills directory setup: only run on the first query per runner instance.
      // Symlinks and directories are stable across queries; re-running every time
      // wastes ~10-30 syscalls per query for no benefit. Call invalidateSkillsSetup()
      // to force a re-run after the user installs or removes a skill.
      if (!this._skillsSetupDone) {
        // Set flag at start to prevent re-entrant calls from concurrent queries
        this._skillsSetupDone = true;

        // Ensure app Claude config directory exists
        if (!fs.existsSync(userAgentDir)) {
          fs.mkdirSync(userAgentDir, { recursive: true });
        }

        // Ensure app Claude skills directory exists
        const appSkillsDir = this.getRuntimeSkillsDir();
        if (!fs.existsSync(appSkillsDir)) {
          fs.mkdirSync(appSkillsDir, { recursive: true });
        }

        // Copy built-in skills to app Claude skills directory if they don't exist
        const builtinSkillsPath = this.getBuiltinSkillsPath();
        if (builtinSkillsPath && fs.existsSync(builtinSkillsPath)) {
          // Symlinks into .asar archives don't work at the OS level (ENOTDIR),
          // so always copy when the source is inside an asar archive.
          // Use regex to match .asar/ but NOT .asar.unpacked/ (which is a real directory).
          const sourceInsideAsar = /\.asar[/\\]/.test(builtinSkillsPath);
          const builtinSkills = fs.readdirSync(builtinSkillsPath);
          for (const skillName of builtinSkills) {
            const builtinSkillPath = path.join(builtinSkillsPath, skillName);
            const userSkillPath = path.join(appSkillsDir, skillName);

            // Clean up broken symlinks pointing into .asar from previous versions
            try {
              const lstat = fs.lstatSync(userSkillPath);
              if (lstat.isSymbolicLink()) {
                const linkTarget = fs.readlinkSync(userSkillPath);
                if (/\.asar[/\\]/.test(linkTarget)) {
                  fs.unlinkSync(userSkillPath);
                  log(`[CoworkAgentRunner] Removed broken asar symlink: ${userSkillPath}`);
                }
              }
            } catch {
              // Path doesn't exist — fine, we'll create it below
            }

            // Only set up if it's a directory and doesn't exist in app directory
            if (fs.statSync(builtinSkillPath).isDirectory() && !fs.existsSync(userSkillPath)) {
              if (sourceInsideAsar) {
                // Source is inside .asar — must copy (symlinks to asar paths fail at OS level)
                this.copyDirectorySync(builtinSkillPath, userSkillPath);
                log(`[CoworkAgentRunner] Copied built-in skill from asar: ${skillName}`);
              } else {
                // Source is a real directory — symlink for space efficiency
                try {
                  fs.symlinkSync(builtinSkillPath, userSkillPath, 'dir');
                  log(`[CoworkAgentRunner] Linked built-in skill: ${skillName}`);
                } catch (err) {
                  logWarn(
                    `[CoworkAgentRunner] Failed to symlink ${skillName}, copying instead:`,
                    err
                  );
                  this.copyDirectorySync(builtinSkillPath, userSkillPath);
                }
              }
            }
          }
        }

        this.syncUserSkillsToAppDir(appSkillsDir);
        this.syncConfiguredSkillsToRuntimeDir(appSkillsDir);
      }

      // Build available skills section dynamically — now handled by pi's DefaultResourceLoader
      // via additionalSkillPaths. No custom prompt building needed.

      log('[CoworkAgentRunner] App agent dir:', userAgentDir);
      log('[CoworkAgentRunner] User working directory:', workingDir);

      logTiming('before building conversation context', runStartTime);

      // pi-ai handles auth and model routing natively — no proxy, no env overrides needed.
      logCtx(
        '[CoworkAgentRunner] Using pi-ai native routing for:',
        activePiModel.provider,
        activePiModel.id
      );

      // Resolve thinking level early — needed for session reuse check below
      const enableThinking = configStore.get('enableThinking') ?? false;
      logCtx('[CoworkAgentRunner] Enable thinking mode:', enableThinking);
      const thinkingLevel = resolveThinkingLevel(enableThinking);
      const thinkingModePrompt = buildThinkingModePromptSection(enableThinking);
      const sessionRuntimeSignature = buildPiSessionRuntimeSignature({
        configProvider: runtimeConfig.provider,
        customProtocol: runtimeConfig.customProtocol,
        modelProvider: activePiModel.provider,
        modelApi: activePiModel.api,
        modelBaseUrl: activePiModel.baseUrl,
        effectiveCwd,
        apiKey,
        profileDosPrompt: runtimeConfig.profileDosPrompt,
        profileDontsPrompt: runtimeConfig.profileDontsPrompt,
        profileCustomPrompt: runtimeConfig.profileCustomPrompt,
      });
      const skillPaths = await this.resolveSkillPaths(session.id);
      const skillsSignature = JSON.stringify(skillPaths);
      log('[CoworkAgentRunner] Skill paths for pi ResourceLoader:', skillPaths);

      // Build contextual prompt — if reusing an existing SDK session, the SDK
      // already has conversation history so we only pass the new prompt.
      // For cold starts (new SDK session with existing DB history), we inject
      // a token-budgeted summary of recent history as a preamble.
      let cachedSession = this.piSessions.get(session.id);
      if (cachedSession && cachedSession.runtimeSignature !== sessionRuntimeSignature) {
        logCtx('[CoworkAgentRunner] Runtime changed, recreating cached pi session:', session.id);
        try {
          cachedSession.session.dispose();
        } catch (disposeError) {
          logWarn('[CoworkAgentRunner] dispose error while recreating pi session:', disposeError);
        }
        this.piSessions.delete(session.id);
        cachedSession = undefined;
      }
      if (cachedSession && cachedSession.skillsSignature !== skillsSignature) {
        logCtx('[CoworkAgentRunner] Skills changed, recreating cached pi session:', session.id);
        try {
          cachedSession.session.dispose();
        } catch (disposeError) {
          logWarn(
            '[CoworkAgentRunner] dispose error while recreating pi session for skills:',
            disposeError
          );
        }
        this.piSessions.delete(session.id);
        cachedSession = undefined;
      }

      const extensionResult = this.extensionManager
        ? await this.extensionManager.beforeSessionRun({
            session,
            prompt,
            existingMessages,
            isColdStart: !cachedSession,
          })
        : { promptPrefix: undefined, customTools: [] };

      // Bridge MCP tools and apply OpenAI 128-tool budget before session reuse /
      // cold-start history injection so a toolsSignature miss recreates correctly.
      const onProjectScopeViolation = createProjectScopeViolationReporter({
        sessionId: session.id,
        division: session,
        sendToRenderer: this.sendToRenderer,
      });
      // Fresh progress each prompt; tool execute closures look up by session id.
      const onLaunchPadProgress = this.beginLaunchPadProgress(session.id);
      const mcpCustomTools = this.mcpManager
        ? filterMcpToolsForDivision(
            buildMcpCustomTools(
              this.mcpManager,
              session,
              onProjectScopeViolation,
              session.id,
              onLaunchPadProgress
            ),
            session
          )
        : [];
      const extensionCustomTools = extensionResult.customTools || [];
      // Coding tools are read/bash/edit/write (4). Wrappers preserve length; we
      // re-check with the real wrapped count before createAgentSession below.
      const toolSelection = selectCustomToolsForModel({
        api: activePiModel.api,
        builtInToolCount: 4,
        mcpManager: this.mcpManager ?? null,
        mcpTools: mcpCustomTools,
        extensionTools: extensionCustomTools,
        useSearchCallMeta: true,
        division: session,
        onProjectScopeViolation,
        sessionId: session.id,
        onLaunchPadProgress,
      });
      const withThink = withThinkToolIfEnabled(
        enableThinking,
        toolSelection.customTools,
        toolSelection.toolsSignature
      );
      let customTools = withThink.customTools;
      let mcpToolMode: McpToolExposureMode = toolSelection.mode;
      const toolsSignature = withThink.toolsSignature;

      if (cachedSession && cachedSession.toolsSignature !== toolsSignature) {
        logCtx('[CoworkAgentRunner] MCP tools changed, recreating cached pi session:', session.id);
        try {
          cachedSession.session.dispose();
        } catch (disposeError) {
          logWarn(
            '[CoworkAgentRunner] dispose error while recreating pi session for tools:',
            disposeError
          );
        }
        this.piSessions.delete(session.id);
        cachedSession = undefined;
      }

      if (mcpCustomTools.length > 0) {
        log(
          `[CoworkAgentRunner] MCP tools available (${mcpCustomTools.length}), exposure mode=${mcpToolMode}:`,
          mcpToolMode === 'meta'
            ? `${MCP_SEARCH_TOOLS_NAME}, ${MCP_CALL_TOOL_NAME}`
            : mcpCustomTools.map((t) => t.name).join(', ')
        );
      }
      if (extensionCustomTools.length > 0) {
        log(
          `[CoworkAgentRunner] Registered ${extensionCustomTools.length} extension tools as customTools:`,
          extensionCustomTools.map((t) => t.name).join(', ')
        );
      }

      // Expand /skill-name, /skill:name, or @skill-name mentions BEFORE history /
      // promptPrefix are prepended — pi only expands when the full string starts
      // with `/skill:`. Also auto-inject LaunchPad skill: always in Project
      // workspace (mandatory), otherwise on NL delivery intent so weaker models
      // cannot skip loading the playbook.
      let expandedUserPrompt = prompt;
      try {
        const expandableSkills = discoverSkillsFromPaths(skillPaths);
        const expansion = expandSlashSkillPrompt(prompt, expandableSkills);
        if (expansion.expanded) {
          expandedUserPrompt = expansion.text;
          log(`[CoworkAgentRunner] Expanded slash skill /${expansion.skillName} before preamble`);
        } else {
          const atExpansion = expandAtSkillMentions(prompt, expandableSkills);
          if (atExpansion.expanded) {
            expandedUserPrompt = atExpansion.text;
            log(
              `[CoworkAgentRunner] Expanded @skill mentions (${atExpansion.skillNames.join(', ')}) before preamble`
            );
          } else {
            const forceLaunchpadSkill =
              normalizeSessionDivision(session).division === 'project';
            const launchpadExpansion = expandLaunchPadSkillIntent(prompt, expandableSkills, {
              force: forceLaunchpadSkill,
            });
            if (launchpadExpansion.expanded) {
              expandedUserPrompt = launchpadExpansion.text;
              const why =
                launchpadExpansion.reason === 'force'
                  ? 'project workspace (mandatory)'
                  : 'delivery intent';
              log(
                `[CoworkAgentRunner] Auto-injected LaunchPad skill /${launchpadExpansion.skillName} for ${why}`
              );
            } else {
              const yorkOsExpansion = expandYorkOsSkillIntent(prompt, expandableSkills);
              if (yorkOsExpansion.expanded) {
                expandedUserPrompt = yorkOsExpansion.text;
                log(
                  `[CoworkAgentRunner] Auto-injected York OS skill /${yorkOsExpansion.skillName} for Confluence/wiki document intent`
                );
              }
            }
          }
        }
      } catch (error) {
        logWarn('[CoworkAgentRunner] Failed to expand skill prompt:', error);
      }

      // Stamp selected Hub/LaunchPad project onto every user turn (after skill
      // expansion so leading /skill: still expands). Not shown in saved chat UI.
      const activeProjectContext = buildDivisionActiveProjectContext(session);
      if (activeProjectContext) {
        expandedUserPrompt = `${expandedUserPrompt}\n\n${activeProjectContext}`;
      }

      let contextualPrompt = expandedUserPrompt;
      if (!cachedSession) {
        // Cold start: inject recent history into prompt if available
        const conversationMessages = existingMessages.filter(
          (msg) => msg.role === 'user' || msg.role === 'assistant'
        );
        // Filter out messages that contain images (images can't be serialized into text preamble)
        const textOnlyMessages = conversationMessages.filter(
          (msg) => !msg.content.some((c) => (c as { type?: string }).type === 'image')
        );
        const historyMessages =
          textOnlyMessages.length > 0 &&
          textOnlyMessages[textOnlyMessages.length - 1]?.role === 'user'
            ? textOnlyMessages.slice(0, -1)
            : textOnlyMessages;

        if (historyMessages.length > 0) {
          // Content-aware chars-per-token estimation (CJK text uses ~1.5 chars/token vs ~4 for English)
          const contextWindow = activePiModel.contextWindow || 128000;
          const historyBudgetRatio = provider === 'ollama' && contextWindow < 16384 ? 0.15 : 0.3;
          const historyTokenBudget = Math.floor(contextWindow * historyBudgetRatio);

          // Sample recent messages to estimate chars-per-token ratio. Sampling the
          // full serialized form (text + thinking + tool blocks) gives a better CJK
          // ratio estimate than sampling text only.
          const sampleText = historyMessages
            .slice(-3)
            .map((m) => serializeMessageContentForHistory(m.content))
            .join('');
          const charsPerToken = estimateCharsPerToken(sampleText);
          const historyCharBudget = Math.floor(historyTokenBudget * charsPerToken);

          const historyItems: string[] = [];
          let charCount = 0;
          // Build from newest to oldest, then reverse. We preserve thinking and
          // tool blocks (not just text) so providers requiring reasoning/tool-call
          // replay (DeepSeek V4 Flash, and any thinking-capable model after a
          // cwd switch) continue to function after a cold start. See #162 Bug B.
          for (let i = historyMessages.length - 1; i >= 0; i--) {
            const msg = historyMessages[i];
            const serialized = serializeMessageContentForHistory(msg.content);
            if (serialized.length === 0) continue;
            const roleTag = msg.role === 'user' ? 'user' : 'assistant';
            const entry = `<turn role="${roleTag}">${serialized}</turn>`;
            if (charCount + entry.length > historyCharBudget) break;
            charCount += entry.length;
            historyItems.unshift(entry);
          }

          if (historyItems.length > 0) {
            const trimmedCount = historyMessages.length - historyItems.length;
            const historyNote =
              trimmedCount > 0 ? `[${trimmedCount} older messages omitted]\n` : '';
            const preamble = `<conversation_history>\n${historyNote}${historyItems.join('\n')}\n</conversation_history>`;
            contextualPrompt = `${preamble}\n\n${expandedUserPrompt}`;
            log(
              '[CoworkAgentRunner] Cold start: injecting',
              historyItems.length,
              'of',
              historyMessages.length,
              'history messages (budget:',
              historyCharBudget,
              'chars, used:',
              charCount,
              ', charsPerToken:',
              charsPerToken.toFixed(2),
              ')'
            );
          }
        }
      } else {
        // Reusing session — SDK already has the full conversation context
        logCtx('[CoworkAgentRunner] Reusing existing SDK session for:', session.id);
      }
      if (extensionResult.promptPrefix?.trim()) {
        contextualPrompt = `${extensionResult.promptPrefix.trim()}\n\n${contextualPrompt}`;
      }

      logTiming('before building MCP servers config', runStartTime);

      // Build MCP servers configuration for SDK
      // IMPORTANT: SDK uses tool names in format: mcp__<ServerKey>__<toolName>
      const mcpServers: Record<string, unknown> = {};
      if (this.mcpManager) {
        const serverStatuses = this.mcpManager.getServerStatus();
        const connectedServers = serverStatuses.filter((s) => s.connected);
        log('[CoworkAgentRunner] MCP server statuses:', safeStringify(serverStatuses));
        log('[CoworkAgentRunner] Connected MCP servers:', connectedServers.length);

        let allConfigs: ReturnType<typeof mcpConfigStore.getEnabledServers> = [];
        try {
          allConfigs = mcpConfigStore.getEnabledServers();
          log(
            '[CoworkAgentRunner] Enabled MCP configs:',
            allConfigs.map((c) => c.name)
          );
        } catch (error) {
          logWarn(
            '[CoworkAgentRunner] Failed to read enabled MCP configs; MCP tools will be unavailable this query',
            error
          );
          allConfigs = [];
        }

        // Cache key: serialized config list + imageCapable flag.  The bundled node
        // paths are stable for the lifetime of the process so they don't need to be
        // part of the fingerprint.
        const mcpFingerprint = JSON.stringify(allConfigs) + String(imageCapable);
        if (this._mcpServersCache?.fingerprint === mcpFingerprint) {
          Object.assign(mcpServers, this._mcpServersCache.servers);
          log('[CoworkAgentRunner] MCP servers config reused from cache');
        } else {
          // Use the module-level memoized helper — no more per-query fs.existsSync calls.
          const bundledNodePaths = getBundledNodePaths();
          const bundledNpx = bundledNodePaths?.npx ?? null;

          for (const config of allConfigs) {
            try {
              // Use a simpler key without spaces to avoid issues
              const serverKey = config.name;

              if (config.type === 'stdio') {
                // Prefer bundled paths when the command is npx or node
                const command =
                  config.command === 'npx' && bundledNpx
                    ? bundledNpx
                    : config.command === 'node' && bundledNodePaths
                      ? bundledNodePaths.node
                      : config.command;

                // When using bundled npx/node, inject the bundled node bin into PATH
                const serverEnv = { ...config.env };
                if (bundledNodePaths && (config.command === 'npx' || config.command === 'node')) {
                  const nodeBinDir = path.dirname(bundledNodePaths.node);
                  const currentPath = process.env.PATH || '';
                  // Prepend bundled node bin to PATH so npx can find node
                  serverEnv.PATH = `${nodeBinDir}${path.delimiter}${currentPath}`;
                  log(`[CoworkAgentRunner]   Added bundled node bin to PATH: ${nodeBinDir}`);
                }

                if (!imageCapable) {
                  serverEnv.YORK_IE_DISABLE_IMAGE_TOOL_OUTPUT = '1';
                }

                // Resolve path placeholders for presets
                let resolvedArgs = config.args || [];

                // Check if any args contain placeholders that need resolving
                const hasPlaceholders = resolvedArgs.some(
                  (arg) =>
                    arg.includes('{SOFTWARE_DEV_SERVER_PATH}') ||
                    arg.includes('{GUI_OPERATE_SERVER_PATH}')
                );

                if (hasPlaceholders) {
                  // Get the appropriate preset based on config name
                  let presetKey: string | null = null;
                  if (
                    config.name === 'Software_Development' ||
                    config.name === 'Software Development'
                  ) {
                    presetKey = 'software-development';
                  } else if (config.name === 'GUI_Operate' || config.name === 'GUI Operate') {
                    presetKey = 'gui-operate';
                  }

                  if (presetKey) {
                    const preset = mcpConfigStore.createFromPreset(presetKey, true);
                    if (preset && preset.args) {
                      resolvedArgs = preset.args;
                    }
                  }
                }

                mcpServers[serverKey] = {
                  type: 'stdio',
                  command,
                  args: resolvedArgs,
                  env: serverEnv,
                };
                log(`[CoworkAgentRunner] Added STDIO MCP server: ${serverKey}`);
                log(`[CoworkAgentRunner]   Command: ${command} ${resolvedArgs.join(' ')}`);
                log(`[CoworkAgentRunner]   Tools will be named: mcp__${serverKey}__<toolName>`);
              } else if (config.type === 'sse') {
                mcpServers[serverKey] = {
                  type: 'sse',
                  url: config.url,
                  headers: config.headers || {},
                };
                log(`[CoworkAgentRunner] Added SSE MCP server: ${serverKey}`);
              }
            } catch (error) {
              logError('[CoworkAgentRunner] Failed to prepare MCP server config, skipping server', {
                serverId: config.id,
                serverName: config.name,
                error: toErrorText(error),
              });
            }
          }

          // Store in cache for subsequent queries
          this._mcpServersCache = { fingerprint: mcpFingerprint, servers: { ...mcpServers } };
        }

        const mcpServersSummary = Object.entries(mcpServers).map(([name, serverConfig]) => {
          const typedServerConfig = serverConfig as {
            type?: string;
            command?: string;
            args?: unknown[];
            env?: Record<string, unknown>;
          };
          return {
            name,
            type: typedServerConfig.type ?? 'unknown',
            command: typedServerConfig.command ?? '',
            argsCount: Array.isArray(typedServerConfig.args) ? typedServerConfig.args.length : 0,
            envKeys: typedServerConfig.env ? Object.keys(typedServerConfig.env).length : 0,
          };
        });
        log('[CoworkAgentRunner] Final mcpServers summary:', safeStringify(mcpServersSummary, 2));
        if (process.env.YORK_IE_LOG_SDK_MESSAGES_FULL === '1') {
          log('[CoworkAgentRunner] Final mcpServers config:', safeStringify(mcpServers, 2));
        }
      }
      logTiming('after building MCP servers config', runStartTime);

      const workspaceListing =
        workingDir && !(useSandboxIsolation && sandboxPath)
          ? buildWorkspaceTopLevelListing(workingDir)
          : useSandboxIsolation && sandboxPath
            ? buildWorkspaceTopLevelListing(sandboxPath)
            : '';

      const workspaceInfoPrompt =
        useSandboxIsolation && sandboxPath
          ? `<workspace_info>
Your current workspace is located at: ${VIRTUAL_WORKSPACE_PATH}
This is an isolated sandbox environment. Use ${VIRTUAL_WORKSPACE_PATH} as the root path for local file operations.
Prefer relative paths under this workspace (e.g. outputs/my-file.md). Do not invent other absolute roots outside ${VIRTUAL_WORKSPACE_PATH}.
Do not write to /mnt/user-data or other absolute mount paths — save generated documents under this workspace (e.g. outputs/).
This folder is for local files only. LaunchPad implement/preview and other remote connector work use MCP tools — not this folder — and do not require a separate "implementation workspace".
${workspaceListing ? `\nTop-level entries in the workspace:\n${workspaceListing}\nUse this listing when deciding relative paths for read/write/edit/bash. If you need deeper structure, list or read paths under this root.` : ''}
</workspace_info>`
          : workingDir
            ? `<workspace_info>
Your current workspace is: ${workingDir}
Use this folder (or relative paths under it) for local file reads and writes. Prefer relative paths like outputs/my-file.md.
Do NOT use /workspace, /mnt/user-data, /mnt/workspace, or any other absolute virtual roots — they are not the workspace. Do not invent absolute directories outside this folder.
This folder is for local files only. LaunchPad implement/preview and other remote connector work use MCP tools — not this folder — and do not require a separate "implementation workspace".
${workspaceListing ? `\nTop-level entries in the workspace:\n${workspaceListing}\nUse this listing when deciding relative paths for read/write/edit/bash. If you need deeper structure, list or read paths under this root.` : ''}
</workspace_info>`
            : '';

      // Build a concise summary of the agent's own runtime configuration.
      // Intentionally excludes API keys, base URLs, and any other sensitive data.
      const configSummaryPrompt = `<your_configuration>
- Model: ${activePiModel.id}
- Provider: ${provider}
- Context Window: ${activePiModel.contextWindow || 'unknown'} tokens
- Max Output Tokens: ${activePiModel.maxTokens || 'default'}
- Thinking: ${enableThinking ? `enabled (${thinkingLevel})` : 'disabled'}
- Sandbox: ${runtimeConfig.sandboxEnabled ? 'enabled' : 'disabled'}
- Memory: ${runtimeConfig.memoryEnabled ? 'enabled' : 'disabled'}
</your_configuration>`;

      const divisionKind =
        session.division === 'hub' ||
        session.division === 'project' ||
        session.division === 'folder'
          ? session.division
          : 'general';
      const workspaceScopeRule =
        divisionKind === 'hub' || divisionKind === 'project'
          ? '\n13. Workspace scope: if the request is personal, general, or outside this workspace, refuse and tell the user to switch workspace in the sidebar. Do not execute off-scope tools.'
          : '';

      const profileInstructionsPrompt = buildProfileInstructionsBlock(runtimeConfig);

      let folderInstructions: string | null = null;
      if (session.division === 'folder' && session.folderId) {
        try {
          folderInstructions =
            createFolderManager(initDatabase()).get(session.folderId)?.instructions ?? null;
        } catch (error) {
          logWarn('[CoworkAgentRunner] Failed to load folder instructions:', error);
        }
      }

      const coworkAppendPrompt = [
        'You are a York IE VECOS assistant. Be concise, accurate, and tool-capable.',
        buildDivisionSystemPrompt(session, { folderInstructions }),
        thinkingModePrompt,
        `CRITICAL BEHAVIORAL RULES:
1. CHAT FIRST: By default, respond to the user in plain text within the conversation. Do NOT create, write, or edit local files unless the user explicitly asks you to (e.g., "create a file", "write this to...", "edit the code", "save as...", mentions a specific file path, or describes code changes they want applied locally). For questions, summaries, explanations, analysis, and general conversation — always reply directly in chat text. CHAT FIRST does NOT block MCP tool calls (Hub, LaunchPad, Slack, Gmail, Calendar, etc.). When the user asks to implement, build, fix, or preview via LaunchPad, use LaunchPad MCP tools immediately.
2. NEVER ask clarification questions in plain text. When a request is actionable, proceed immediately with reasonable assumptions. If you truly cannot proceed without user input, you MUST use the AskUserQuestion tool — never write questions as regular assistant text.
3. For relative time windows like "within two days" in browsing or research tasks, assume the most recent two relevant publication days unless the user explicitly defines another date range.
4. For bracketed placeholders like [Agent], [Topic], etc., treat the word inside brackets as the literal search keyword unless the user says otherwise.
5. When given a task, START DOING IT. Do not restate the task, do not list what you will do, do not ask for confirmation. Just execute.
6. York IE people named in the request: resolve via Hub (list_employees / search_organization) before asking. Do not ask the user for their company email when Hub can resolve the name.
7. Never use AskUserQuestion for meta permission ("can I ask…", "may I proceed…", "should I look up…"). Ask only for a concrete missing detail that would make the next action wrong.
8. Google Calendar create/update/delete: call the tool when available (approval UI may prompt). Do not refuse and hand the user a copy-paste invite instead.
9. York company/work asks (meetings, agendas/prep, people, leave, client or project status, delivery, promises/follow-ups): load the york-os skill and use connected connectors as it directs. Do not answer from a single connector when the ask implies prep, brief, status, or enrich.
10. Multi-source company asks: form a short tool-call plan (phases + cross-tool join keys such as emails, clientId, projectId, eventId), then execute; chain ids/emails from one tool into the next; never re-ask the user for values tools already returned. In mcp_search_tools meta mode, search narrowly by connector/keyword and call mcp_call_tool immediately after discovery.
11. HTML-FIRST CREATIONS: When the user asks to create a presentation, deck, one-pager, report page, dashboard mock, landing page, interactive handout, or similar visual deliverable — and they have NOT explicitly requested an Office/PDF format (pptx, docx, xlsx, pdf, PowerPoint, Word, Excel) or a Confluence/wiki/Atlassian page — write a self-contained HTML file under outputs/ (e.g. outputs/client-update.html). Load the html-artifact skill. After writing, emit a compact \`\`\`artifact block with JSON {"path":"outputs/...html","name":"...","type":"html"} so the in-app preview can open. Do not default to pptx/docx/xlsx/pdf skills unless the user named those formats. When the user names Confluence, wiki, or Atlassian, do NOT default to HTML — use Confluence MCP (createConfluencePage / updateConfluencePage) per york-os on the first actionable turn.
12. LAUNCHPAD DELIVERY: In Project workspace, the rnd-launchpad-mcp-sdlc skill is mandatory every turn (auto-injected). Elsewhere: on LaunchPad implement / preview / release / feature / bug / QA asks, follow that skill and use LaunchPad MCP tools. "On preview" / LaunchPad preview ⇒ start_scope_implement with target platform (never development or Backend Code unless the user explicitly names that surface). After any start tool, keep polling status tools until terminal — do not stop mid-job or ask the user to wait. On terminal implement for a preview ask, call start_preview next; after lock settles, seed the new active. Never claim a local "implementation workspace" is missing — platform work is MCP-remote. Call tools (mcp_call_tool immediately after mcp_search_tools in meta mode).
13. GOAL LOOPS: When the message is a goal tick ("Continue working toward this goal"), mentions GOAL_STATUS, or the user asks to keep going until done / finish a goal, load the goal-runner skill. Auto-detect goal type (including launchpad for LaunchPad release/migrate/preview/fidelity), take concrete next steps, and end every such reply with exactly GOAL_STATUS: complete or GOAL_STATUS: in_progress. Only complete with evidence; never mark complete for a plan alone. After any start tool, keep the turn alive and poll to terminal (same as rule 12 for LaunchPad) — do not park solely because a job "started" or wait for the next goal interval. If forced to park mid long job, emit RESUME: projectId=… releaseId=… … step=… next=<status_tool> before in_progress. Resume RESUME: lines on the next tick first. LaunchPad domain work must also load rnd-launchpad-mcp-sdlc.${workspaceScopeRule}`,
        profileInstructionsPrompt,
        configSummaryPrompt,
        workspaceInfoPrompt,
        `<citation_requirements>
When your answer uses data from MCP tools (or other linkable tool results), you MUST end with a "Sources:" section.
Format:
Sources:
- [Title](https://example.com/real-url-from-tool)
Rules:
- Use real URLs from tool payloads (html_link, web_view_link, permalink, issue/page URLs, etc.).
- Prefer standard Markdown links: [Title](https://...).
- For Jira: never cite REST/API self links (.../rest/api/.../issue/...). Use https://{site}.atlassian.net/browse/{KEY} (from the issue key). Same for Confluence — prefer the page URL, not /wiki/rest/api/... .
- For memory_search / memory_read hits, cite with the tool's cite value: [Title](memory:{id}). Never invent http URLs for memory.
- If a hit has no URL and is not memory, cite the connector and identifier as plain text (e.g. "York Hub — employee Jane Doe"). Never invent URLs.
- Only list sources that tools actually returned. Do not invent sources.
</citation_requirements>`,
        `<tool_behavior>
AskUserQuestion:
- ONLY use AskUserQuestion when you absolutely cannot proceed without user input AND the missing detail would make the next action likely wrong.
- Prefer assumptions when safe. Never ask for confirmation or write "before I start" preambles in plain text.
- Never ask meta questions (permission to ask, permission to look up, permission to proceed).
- For named York IE people: Hub-resolve email first; do not AskUserQuestion for their email if Hub matched.
- When asking: provide 2–4 options (A/B/C/D) and mark exactly one option with recommended: true.
- Ask once when necessary. A second ask is allowed only if the first answer still leaves a critical fork.
- Bundle related decisions into a single AskUserQuestion call (multi-question form), not a chain of asks.
- After answers (or after the 2nd ask / ask budget exhausted), START DOING THE WORK — never re-ask the same decision.

${
  mcpToolMode === 'meta'
    ? `MCP tool access (budget mode):
- Connected MCP servers expose too many tools to list directly for this model API.
- Use mcp_search_tools to find tools by keyword and/or server, then mcp_call_tool with the exact tool name and arguments.
- After mcp_search_tools returns matches, you MUST immediately call mcp_call_tool in the same turn with the exact name and arguments. Do not end the turn with only a plan or thinking after discovery.
- Prefer a tight query and/or server filter, and a small limit, so search results stay short.
- Prefer webfetch for reading http/https page content; use Chrome MCP only for interactive browser work.`
    : `Tool routing:
- Prefer webfetch for reading or fetching http/https page content (no browser window).
- Prefer Chrome MCP tools (mcp__Chrome__*) only when the user asks for interactive browser work (navigate, click, screenshot, login flows).`
}
</tool_behavior>`,
        this.getBundledPathHints(),
      ]
        .filter((section): section is string => Boolean(section && section.trim()))
        .join('\n\n');

      logTiming('before agent session creation', runStartTime);

      // Enrich process.env.PATH for build mode — ensures Skill commands (python3, node)
      // executed via Pi SDK's Bash tool can find bundled and user-installed executables.
      await enrichProcessPathForBuild();

      const bashOptions: BashToolOptions | undefined =
        process.platform === 'win32' ? { operations: createWindowsBashOperations() } : undefined;
      const codingTools = createCodingTools(
        effectiveCwd,
        bashOptions ? { bash: bashOptions } : undefined
      );

      // Remap Cowork virtual roots onto the session workspace before other wrappers
      const withCoworkPaths = CoworkAgentRunner.wrapToolsForCoworkPathRemap(
        codingTools as ToolDefinition[],
        effectiveCwd
      );

      // Inject a default 120s timeout for bash commands when the model omits one
      const withTimeout = CoworkAgentRunner.wrapBashToolWithDefaultTimeout(withCoworkPaths);

      // Wrap the bash tool to intercept sudo commands and request passwords
      // Note: wrapBashToolForSudo returns ToolDefinition[] (5-param execute) but
      // createAgentSession.tools expects Tool[] (4-param execute). The extra ctx
      // parameter is simply not passed by the session runner — safe to cast.
      const wrappedTools = this.wrapBashToolForSudo(withTimeout, session.id, effectiveCwd);

      // Re-select with the real built-in count in case wrappers ever diverge from 4.
      let effectiveToolsSignature = toolsSignature;
      if (wrappedTools.length !== 4) {
        const adjusted = selectCustomToolsForModel({
          api: activePiModel.api,
          builtInToolCount: wrappedTools.length,
          mcpManager: this.mcpManager ?? null,
          mcpTools: mcpCustomTools,
          extensionTools: extensionCustomTools,
          useSearchCallMeta: true,
          division: session,
          onProjectScopeViolation,
          sessionId: session.id,
          onLaunchPadProgress,
        });
        const adjustedWithThink = withThinkToolIfEnabled(
          enableThinking,
          adjusted.customTools,
          adjusted.toolsSignature
        );
        customTools = adjustedWithThink.customTools;
        mcpToolMode = adjusted.mode;
        effectiveToolsSignature = adjustedWithThink.toolsSignature;
      }

      // Diagnostic: log tools being passed to SDK (helps debug Ollama tool use)
      logCtx(`[CoworkAgentRunner] Session reuse check: cached=${!!cachedSession}`);
      logCtx(`[CoworkAgentRunner] Model=${activePiModel.id}, thinkingLevel=${thinkingLevel}`);
      log(
        `[CoworkAgentRunner] Built-in tools (${wrappedTools.length}): ${wrappedTools.map((t: { name?: string; type?: string }) => t.name || t.type).join(', ')}`
      );
      log(
        `[CoworkAgentRunner] Custom tools (${customTools.length}, mode=${mcpToolMode}): ${customTools.map((t) => t.name).join(', ')}`
      );

      let piSession: PiAgentSession;
      if (cachedSession) {
        // Reuse existing session — SDK retains full conversation history and handles compaction
        piSession = cachedSession.session;

        // Hot-swap model/thinking if changed — SDK supports this natively
        if (cachedSession.modelId !== activePiModel.id) {
          logCtx(
            '[CoworkAgentRunner] Model changed, hot-swapping:',
            cachedSession.modelId,
            '→',
            activePiModel.id
          );
          await piSession.setModel(activePiModel);
          cachedSession.modelId = activePiModel.id;
          // Update Ollama num_ctx ref if present
          if (cachedSession.ollamaNumCtx) {
            cachedSession.ollamaNumCtx.value = activePiModel.contextWindow || 128000;
            log(
              '[CoworkAgentRunner] Updated Ollama num_ctx on hot-swap:',
              cachedSession.ollamaNumCtx.value
            );
          }
        }
        if (cachedSession.thinkingLevel !== thinkingLevel) {
          logCtx(
            '[CoworkAgentRunner] Thinking level changed, hot-swapping:',
            cachedSession.thinkingLevel,
            '→',
            thinkingLevel
          );
          piSession.setThinkingLevel(thinkingLevel);
          cachedSession.thinkingLevel = thinkingLevel;
        }

        logCtx('[CoworkAgentRunner] Reusing cached pi session for:', session.id);
        logTiming('agent session reused', runStartTime);
      } else {
        // First query in this session — create new agent session
        // ResourceLoader + ModelRegistry only needed for session creation — skip on reuse
        const { DefaultResourceLoader } = await import('@mariozechner/pi-coding-agent');

        // Per-session compaction instructions (from session metadata if present).
        // Capped at 2000 chars to limit prompt injection surface — this field
        // is only set programmatically (not from external user input).
        let sessionCompactInstructions: string | undefined =
          'compactInstructions' in session &&
          typeof (session as Record<string, unknown>).compactInstructions === 'string'
            ? ((session as Record<string, unknown>).compactInstructions as string)
            : undefined;
        if (sessionCompactInstructions && sessionCompactInstructions.length > 2000) {
          sessionCompactInstructions = sessionCompactInstructions.slice(0, 2000);
        }

        const resourceLoader = new DefaultResourceLoader({
          cwd: effectiveCwd,
          additionalSkillPaths: skillPaths,
          appendSystemPrompt: coworkAppendPrompt,
          extensionFactories: [
            createCompactionExtensionFactory({
              customInstructions: sessionCompactInstructions,
              pruneToolOutputAbove: 500,
              keepRecentToolResults: 3,
            }),
          ],
        });
        await resourceLoader.reload();

        const modelRegistry = new ModelRegistry(authStorage);

        // Ollama-specific compaction tuning based on actual context window
        const contextWindow = activePiModel.contextWindow || 128000;
        let compactionSettings: {
          enabled: boolean;
          reserveTokens?: number;
          keepRecentTokens?: number;
        };
        if (provider === 'ollama' && contextWindow < 16384) {
          // Very small context: disable compaction (weak models produce unreliable summaries)
          compactionSettings = { enabled: false };
          log(
            '[CoworkAgentRunner] Ollama small context model, disabling auto-compaction (contextWindow:',
            contextWindow,
            ')'
          );
        } else if (provider === 'ollama' && contextWindow < 65536) {
          // Medium context: scale reserves proportionally
          compactionSettings = {
            enabled: true,
            reserveTokens: Math.floor(contextWindow * 0.15),
            keepRecentTokens: Math.floor(contextWindow * 0.25),
          };
          log(
            '[CoworkAgentRunner] Ollama medium context, scaled compaction:',
            JSON.stringify(compactionSettings)
          );
        } else {
          compactionSettings = { enabled: true };
        }

        const { session: newPiSession } = await createAgentSession({
          model: activePiModel,
          thinkingLevel,
          authStorage,
          modelRegistry,
          tools: wrappedTools as unknown as ReturnType<typeof createCodingTools>,
          customTools,
          sessionManager: PiSessionManager.inMemory(),
          settingsManager: PiSettingsManager.inMemory({
            compaction: compactionSettings,
            retry: { enabled: true, maxRetries: 2 },
          }),
          resourceLoader,
          cwd: effectiveCwd,
        });
        piSession = newPiSession;

        // Install permission-gating hook via the SDK's tool_call extension event.
        // This must happen once per new session — the hook persists across reuses.
        this.installPermissionHook(piSession, session.id);

        // Store session for reuse — evict oldest if cache is full
        if (this.piSessions.size >= CoworkAgentRunner.MAX_CACHED_SESSIONS) {
          const oldestKey = this.piSessions.keys().next().value;
          if (oldestKey) {
            const oldest = this.piSessions.get(oldestKey);
            if (oldest) {
              try {
                oldest.session.dispose();
              } catch (e) {
                logWarn('[CoworkAgentRunner] dispose error on eviction:', e);
              }
            }
            this.piSessions.delete(oldestKey);
            log('[CoworkAgentRunner] Evicted oldest cached session:', oldestKey);
          }
        }
        this.piSessions.set(session.id, {
          session: piSession,
          modelId: activePiModel.id,
          thinkingLevel,
          runtimeSignature: sessionRuntimeSignature,
          skillsSignature,
          toolsSignature: effectiveToolsSignature,
          compactionEnabled: compactionSettings.enabled,
        });

        // Ollama: wrap _onPayload to inject num_ctx into every request
        if (provider === 'ollama') {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const agent = piSession.agent as any;
          // Guard: only patch if the SDK exposes _onPayload (private API)
          if (!('_onPayload' in agent)) {
            logWarn(
              '[CoworkAgentRunner] SDK agent does not expose _onPayload — skipping Ollama num_ctx patch'
            );
          } else {
            const originalOnPayload = agent._onPayload as
              | ((
                  payload: Record<string, unknown>,
                  modelArg: unknown
                ) => Promise<Record<string, unknown>>)
              | undefined;
            const ollamaNumCtx = {
              value: activePiModel.contextWindow || 128000,
            };
            agent._onPayload = async (payload: Record<string, unknown>, modelArg: unknown) => {
              let result = originalOnPayload
                ? await originalOnPayload.call(agent, payload, modelArg)
                : payload;
              if (result === undefined) result = payload;
              return { ...result, num_ctx: ollamaNumCtx.value };
            };
            this.piSessions.get(session.id)!.ollamaNumCtx = ollamaNumCtx;
            log(
              '[CoworkAgentRunner] Ollama _onPayload wrapper installed, num_ctx:',
              ollamaNumCtx.value
            );
          } // end else (_onPayload exists)
        }

        logTiming('agent session created', runStartTime);
      }

      // Whether SDK will auto-compact+retry on context overflow for this session.
      const compactionEnabled = this.piSessions.get(session.id)?.compactionEnabled ?? true;

      // Set up event handler to bridge agent SDK events → our ServerEvent protocol

      // Accumulate streamed text deltas in case message_end.content is empty (pi SDK streaming behaviour)
      let streamedText = '';
      let compactionStepId: string | undefined;
      let hasEmittedError = false;
      let terminalErrorText: string | undefined;
      const promptStartedAt = Date.now();
      const streamEventCounts = new Map<string, number>();

      // ── Loop guard: protect against runaway tool-call loops ──
      // (e.g. gemini-3.1-pro with thinking=off has been observed producing hundreds
      //  of empty-text + single-tool-call responses in a single turn)
      // Two layers: hash of whole tool-call group (window=20, warn=3/halt=5/abort=8)
      //             + per-tool frequency (warn=30/halt=50/abort=80).
      const loopGuard = new LoopGuard();
      // Track tools + final assistant content so we can detect "search then stop" turns.
      const toolsInvokedThisTurn: string[] = [];
      let finalAssistantSummary: TurnContentSummary = {
        hasText: false,
        hasThinking: false,
        hasToolUse: false,
      };
      const handleLoopGuardDecision = (decision: LoopGuardDecision, context: string): void => {
        if (decision.action === 'none' || controller.signal.aborted) return;
        logWarn(`[LoopGuard] ${context}: action=${decision.action} reason=${decision.reason}`);

        if (decision.action === 'hash_abort' || decision.action === 'freq_abort') {
          // Always surface the loop-guard explanation, even if an earlier
          // error already set hasEmittedError — the user must see why the
          // session stopped. Mark the flag afterward to suppress duplicate
          // generic-error chatter from later paths in this turn.
          this.sendMessage(session.id, {
            id: uuidv4(),
            sessionId: session.id,
            role: 'assistant',
            content: [{ type: 'text', text: buildAbortUserMessage(decision) }],
            timestamp: Date.now(),
          });
          hasEmittedError = true;
          this.sendTraceUpdate(session.id, thinkingStepId, {
            status: 'error',
            title: 'Stopped: tool-call loop detected',
          });
          try {
            // Mark BEFORE calling abort() so the AbortError handler in the
            // outer catch can distinguish a loop-guard abort from a user
            // cancel and skip the "Cancelled" trace overwrite.
            abortedByLoopGuard = true;
            controller.abort();
          } catch (abortErr) {
            logWarn('[LoopGuard] abort error:', abortErr);
          }
          return;
        }

        const steerText =
          decision.action === 'hash_halt' || decision.action === 'freq_halt'
            ? buildHaltSteerMessage(decision)
            : buildWarnSteerMessage(decision);
        // fire-and-forget: SDK queues the steering message for the next turn
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const sessionAny = piSession as any;
          if (typeof sessionAny.sendUserMessage === 'function') {
            Promise.resolve(sessionAny.sendUserMessage(steerText, { deliverAs: 'steer' })).catch(
              (err: unknown) => {
                logWarn('[LoopGuard] sendUserMessage(steer) failed:', err);
              }
            );
          } else {
            logWarn('[LoopGuard] piSession.sendUserMessage is not available; skipping steer');
          }
        } catch (steerErr) {
          logWarn('[LoopGuard] sendUserMessage(steer) threw:', steerErr);
        }
      };

      // Ollama cold-start feedback: if provider is 'ollama' and no stream event arrives
      // within 10 seconds, show a "model loading" trace update so users know what's happening.
      let ollamaColdStartTimerId: ReturnType<typeof setTimeout> | undefined;
      let receivedFirstStreamEvent = false;
      let firstStreamEventAt: number | undefined;
      if (provider === 'ollama') {
        ollamaColdStartTimerId = setTimeout(() => {
          if (!receivedFirstStreamEvent && !controller.signal.aborted) {
            this.sendTraceUpdate(session.id, thinkingStepId, {
              title: 'Waiting for model to load into memory...',
            });
          }
        }, 10000);
      }

      const markFirstStreamEvent = (eventType: string) => {
        if (receivedFirstStreamEvent) {
          return;
        }
        receivedFirstStreamEvent = true;
        firstStreamEventAt = Date.now();
        if (ollamaColdStartTimerId) {
          clearTimeout(ollamaColdStartTimerId);
        }
        this.sendTraceUpdate(session.id, thinkingStepId, {
          title: 'Processing request...',
        });
        if (provider === 'ollama') {
          log(
            '[CoworkAgentRunner] Ollama first stream event received',
            safeStringify({
              sessionId: session.id,
              eventType,
              modelId: activePiModel.id,
              modelProvider: activePiModel.provider,
              baseUrl: activePiModel.baseUrl || runtimeConfig.baseUrl || '',
              latencyMs: firstStreamEventAt - promptStartedAt,
            })
          );
        }
      };

      // Activity-based timeout: reset the 5-min timer whenever the SDK sends events
      const PROMPT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
      let activityTimeoutId: ReturnType<typeof setTimeout> | undefined;
      const resetActivityTimeout = () => {
        if (activityTimeoutId) clearTimeout(activityTimeoutId);
        activityTimeoutId = setTimeout(() => {
          logWarn('[CoworkAgentRunner] Prompt timed out (no activity for 5 min), aborting');
          abortedByTimeout = true;
          controller.abort();
        }, PROMPT_TIMEOUT_MS);
      };

      const recordStreamEvent = (eventType: string) => {
        streamEventCounts.set(eventType, (streamEventCounts.get(eventType) ?? 0) + 1);
      };

      const getStreamEventSummary = () =>
        Object.fromEntries(
          Array.from(streamEventCounts.entries()).sort(([left], [right]) =>
            left.localeCompare(right)
          )
        );

      const emitTerminalError = (errorText: string, options: { abort?: boolean } = {}): void => {
        terminalErrorText = errorText;

        const emission = buildTerminalErrorEmissionDetails({
          errorText,
          streamedText,
        });

        const partialText = emission.partialText ? sanitizeOutputPaths(emission.partialText) : '';
        const messageText = buildTerminalErrorMessage(errorText, partialText);
        streamedText = '';
        this.sendToRenderer({
          type: 'stream.partial',
          payload: { sessionId: session.id, delta: '' },
        });

        if (!hasEmittedError) {
          hasEmittedError = true;
          this.sendMessage(session.id, {
            id: uuidv4(),
            sessionId: session.id,
            role: 'assistant',
            content: [{ type: 'text', text: messageText }],
            timestamp: Date.now(),
          });
        }

        this.sendTraceUpdate(session.id, thinkingStepId, {
          status: 'error',
          title: 'Request failed',
        });

        if (options.abort && !controller.signal.aborted) {
          try {
            // Mark BEFORE calling abort() so AbortError handling preserves the
            // 'Request failed' state instead of treating this as a user cancel.
            abortedByStreamError = true;
            controller.abort();
          } catch (abortErr) {
            logWarn('[CoworkAgentRunner] stream-error abort failed:', abortErr);
          }
        }
      };

      const unsubscribe = piSession.subscribe((event) => {
        try {
          if (controller.signal.aborted) return;

          // Reset activity timeout on meaningful events
          resetActivityTimeout();

          if (event.type === 'message_update') {
            const updateType = event.assistantMessageEvent.type;
            recordStreamEvent(updateType);
            if (updateType !== 'text_delta' && updateType !== 'thinking_delta') {
              log(`[CoworkAgentRunner] Event: ${event.type} → ${updateType}`);
            }
          } else if (event.type === 'message_start') {
            log(
              '[CoworkAgentRunner] Event: message_start',
              safeStringify(summarizeMessageForLog(event.message), 2)
            );
          } else if (event.type === 'message_end') {
            log(
              '[CoworkAgentRunner] Event: message_end',
              safeStringify(
                {
                  message: summarizeMessageForLog(event.message),
                  messageUpdateCounts: getStreamEventSummary(),
                },
                2
              )
            );
          } else if (event.type === 'turn_end') {
            log(`[CoworkAgentRunner] Event: ${event.type}`);
          } else {
            log(`[CoworkAgentRunner] Event: ${event.type}`);
          }

          switch (event.type) {
            case 'message_update': {
              if (controller.signal.aborted) break;
              const ame = event.assistantMessageEvent;
              if (ame.type === 'text_delta') {
                markFirstStreamEvent(ame.type);
                streamedText += ame.delta;
                this.sendPartial(session.id, ame.delta);
              } else if (ame.type === 'thinking_delta') {
                markFirstStreamEvent(ame.type);
                // Forward thinking delta to renderer for real-time display
                this.sendToRenderer({
                  type: 'stream.thinking',
                  payload: { sessionId: session.id, delta: ame.delta },
                });
              } else if (ame.type === 'toolcall_start') {
                markFirstStreamEvent(ame.type);
                const partial = ame.partial;
                const toolContent = partial?.content?.[ame.contentIndex];
                const toolName = toolContent?.type === 'toolCall' ? toolContent.name : 'unknown';
                const toolCallId = toolContent?.type === 'toolCall' ? toolContent.id : uuidv4();
                const toolDisplayName = this.getToolDisplayName(toolName);
                this.sendTraceStep(session.id, {
                  id: toolCallId,
                  type: 'tool_call',
                  status: 'running',
                  title: toolDisplayName,
                  toolName,
                  toolInput:
                    toolContent?.type === 'toolCall'
                      ? (toolContent.arguments as Record<string, unknown>) || {}
                      : undefined,
                  timestamp: Date.now(),
                });
              } else if (ame.type === 'done') {
                // Some providers emit 'done' via message_update — we handle it
                // in message_end below as a unified path for all providers.
                log('[CoworkAgentRunner] message_update done event (handled in message_end)');
              } else if (ame.type === 'error') {
                markFirstStreamEvent(ame.type);
                const errorDetail = JSON.stringify(ame.error?.content || 'no content');
                logCtxError('[CoworkAgentRunner] pi-ai stream error:', ame.reason, errorDetail);
                const rawStreamError =
                  ame.error?.errorMessage?.trim() || ame.reason || 'stream_error';
                // Let the SDK compact-and-retry; aborting would cancel recovery.
                if (compactionEnabled && isSdkRecoverableContextOverflowError(rawStreamError)) {
                  log(
                    '[CoworkAgentRunner] Deferring context overflow stream error to SDK compaction'
                  );
                  break;
                }
                if (
                  isOpenRouterAccountLimitError(resolvedProvider, rawStreamError) &&
                  !openRouterLimitRetry.done
                ) {
                  openRouterLimitRetry.pending = true;
                  openRouterLimitRetry.rawError = rawStreamError;
                  abortedByStreamError = true;
                  if (!controller.signal.aborted) {
                    try {
                      controller.abort();
                    } catch (abortErr) {
                      logWarn('[CoworkAgentRunner] openrouter-limit abort failed:', abortErr);
                    }
                  }
                  break;
                }
                const userFacing = isOpenRouterAccountLimitError(resolvedProvider, rawStreamError)
                  ? openRouterLimitUserMessage(true)
                  : resolveAssistantStreamErrorText(ame);
                emitTerminalError(userFacing, { abort: true });
              }
              break;
            }

            case 'message_end': {
              // Unified handler: send the final assistant message to the renderer.
              // Works for all providers (some emit 'done' via message_update, others don't).
              if (controller.signal.aborted) break;

              const msg = event.message;
              if (process.env.YORK_IE_LOG_SDK_MESSAGES_FULL === '1') {
                log('[CoworkAgentRunner] message_end raw message:', safeStringify(msg, 2));
              }
              const resolvedPayload = resolveMessageEndPayload({
                message: msg as Parameters<typeof resolveMessageEndPayload>[0]['message'],
                streamedText,
              });
              streamedText = resolvedPayload.nextStreamedText;
              if (provider === 'ollama') {
                log(
                  '[CoworkAgentRunner] Ollama message_end diagnostics',
                  safeStringify({
                    sessionId: session.id,
                    modelId: activePiModel.id,
                    modelProvider: activePiModel.provider,
                    usedSyntheticModel,
                    receivedFirstStreamEvent,
                    firstStreamLatencyMs: firstStreamEventAt
                      ? firstStreamEventAt - promptStartedAt
                      : null,
                    stopReason: (msg as { stopReason?: unknown })?.stopReason ?? null,
                    contentBlocks: Array.isArray((msg as { content?: unknown[] })?.content)
                      ? ((msg as { content?: unknown[] }).content?.length ?? 0)
                      : 0,
                    emittedError: Boolean(resolvedPayload.errorText),
                  })
                );
              }
              if (resolvedPayload.errorText) {
                const rawError =
                  typeof (msg as { errorMessage?: unknown })?.errorMessage === 'string'
                    ? ((msg as { errorMessage: string }).errorMessage as string)
                    : resolvedPayload.errorText;
                // SDK auto-compacts once and retries; don't poison the chat yet.
                if (compactionEnabled && isSdkRecoverableContextOverflowError(rawError)) {
                  log(
                    '[CoworkAgentRunner] Deferring context overflow message_end error to SDK compaction'
                  );
                  break;
                }
                if (
                  isOpenRouterAccountLimitError(resolvedProvider, rawError) &&
                  !openRouterLimitRetry.done
                ) {
                  openRouterLimitRetry.pending = true;
                  openRouterLimitRetry.rawError = rawError;
                  abortedByStreamError = true;
                  if (!controller.signal.aborted) {
                    try {
                      controller.abort();
                    } catch (abortErr) {
                      logWarn('[CoworkAgentRunner] openrouter-limit abort failed:', abortErr);
                    }
                  }
                  break;
                }
                const userFacing = isOpenRouterAccountLimitError(resolvedProvider, rawError)
                  ? openRouterLimitUserMessage(true)
                  : resolvedPayload.errorText;
                reportHubGovernanceUsageFromCompletion({
                  modelId: activePiModel.id,
                  provider: String(activePiModel.provider || provider || ''),
                  sessionId: session.id,
                  hubProjectId: session.hubProjectId,
                  folderId: session.folderId,
                  launchpadProjectId: session.launchpadProjectId,
                  division: session.division,
                  usage: (msg as { usage?: unknown }).usage,
                  responseId:
                    typeof (msg as { responseId?: unknown }).responseId === 'string'
                      ? (msg as { responseId: string }).responseId
                      : null,
                  latencyMs: Date.now() - promptStartedAt,
                  status: 'error',
                  errorCode: 'message_end_error',
                });
                emitTerminalError(userFacing);
                break;
              }
              if (resolvedPayload.shouldEmitMessage) {
                const contentBlocks: ContentBlock[] = [];
                for (const block of resolvedPayload.effectiveContent) {
                  if (block.type === 'text') {
                    const { cleanText, artifacts } = extractArtifactsFromText(block.text);
                    if (cleanText) {
                      contentBlocks.push({ type: 'text', text: sanitizeOutputPaths(cleanText) });
                    }
                    if (artifacts.length > 0) {
                      for (const step of buildArtifactTraceSteps(artifacts)) {
                        this.sendTraceStep(session.id, step);
                      }
                    }
                  } else if (block.type === 'toolCall') {
                    const displayName = this.getToolDisplayName(block.name);
                    contentBlocks.push({
                      type: 'tool_use',
                      id: block.id,
                      name: block.name,
                      displayName,
                      input: block.arguments,
                    });
                  } else if (block.type === 'thinking') {
                    // Include thinking blocks in the final message for UI display
                    contentBlocks.push({
                      type: 'thinking',
                      thinking: block.thinking,
                    });
                  } else {
                    // Unknown block type — pass through as text so content isn't silently lost
                    const unknownBlock = block as { type?: string; text?: string };
                    log(`[CoworkAgentRunner] Unknown content block type: ${unknownBlock.type}`);
                    const text = unknownBlock.text || JSON.stringify(block);
                    if (text) contentBlocks.push({ type: 'text', text });
                  }
                }
                // Always clear partial text; send message even if only artifacts were extracted
                this.sendToRenderer({
                  type: 'stream.partial',
                  payload: { sessionId: session.id, delta: '' },
                });

                // ── Loop guard layer 1: hash of this message's tool-call group ──
                const toolUseDescriptors: ToolCallDescriptor[] = [];
                for (const block of resolvedPayload.effectiveContent) {
                  if (block.type === 'toolCall') {
                    toolUseDescriptors.push({
                      name: block.name || '',
                      input: (block.arguments as Record<string, unknown>) || undefined,
                    });
                  }
                }
                if (toolUseDescriptors.length > 0) {
                  handleLoopGuardDecision(
                    loopGuard.recordAssistantMessage(toolUseDescriptors),
                    'message_end'
                  );
                  if (controller.signal.aborted) break;
                }

                if (contentBlocks.length > 0) {
                  finalAssistantSummary = summarizeContentBlocks(contentBlocks);
                  const msgWithUsage = msg as { usage?: unknown };
                  const tokenUsage = normalizeTokenUsage(msgWithUsage.usage);
                  if (msgWithUsage.usage) {
                    log(
                      '[CoworkAgentRunner] normalized usage:',
                      safeStringify(
                        {
                          raw: msgWithUsage.usage,
                          normalized: tokenUsage,
                        },
                        2
                      )
                    );
                  }
                  const assistantMsg: Message = {
                    id: uuidv4(),
                    sessionId: session.id,
                    role: 'assistant',
                    content: contentBlocks,
                    timestamp: Date.now(),
                    api: activePiModel.api,
                    provider: activePiModel.provider,
                    model: activePiModel.id,
                    tokenUsage,
                  };
                  reportHubGovernanceUsageFromCompletion({
                    modelId: activePiModel.id,
                    provider: String(activePiModel.provider || provider || ''),
                    sessionId: session.id,
                    hubProjectId: session.hubProjectId,
                    folderId: session.folderId,
                    launchpadProjectId: session.launchpadProjectId,
                    division: session.division,
                    usage: msgWithUsage.usage,
                    responseId:
                      typeof (msg as { responseId?: unknown }).responseId === 'string'
                        ? (msg as { responseId: string }).responseId
                        : null,
                    latencyMs: Date.now() - promptStartedAt,
                    status: 'ok',
                  });
                  this.sendMessage(session.id, assistantMsg);
                }
              }
              break;
            }

            case 'tool_execution_start': {
              logCtx(`[CoworkAgentRunner] Tool execution start: ${event.toolName}`);
              if (typeof event.toolName === 'string' && event.toolName) {
                toolsInvokedThisTurn.push(event.toolName);
              }
              // ── Loop guard layer 2: per-tool cumulative frequency ──
              // LaunchPad status polls (incl. meta mcp_call_tool during LP delivery)
              // may run for hours — do not frequency-abort them.
              const toolNameForGuard =
                typeof event.toolName === 'string' ? event.toolName : 'unknown';
              const lpProgress = this.launchPadProgressBySession.get(session.id);
              const hasLaunchPadActivity = (lpProgress?.getCalls().length ?? 0) > 0;
              const skipLaunchPadPollFreq =
                isLaunchPadPollToolForLoopGuard(toolNameForGuard) ||
                (hasLaunchPadActivity &&
                  toolNameForGuard.toLowerCase() === MCP_CALL_TOOL_NAME.toLowerCase());
              handleLoopGuardDecision(
                loopGuard.recordToolInvocation(toolNameForGuard, {
                  skipFrequency: skipLaunchPadPollFreq,
                }),
                'tool_execution_start'
              );
              break;
            }

            case 'tool_execution_end': {
              if (controller.signal.aborted) break;
              const toolCallId = event.toolCallId;
              const isError = event.isError;
              const normalizedToolResult = normalizeToolExecutionResultForUi(event.result);
              const outputText = normalizedToolResult.content;
              const toolDisplayName = this.getToolDisplayName(event.toolName);
              this.sendTraceUpdate(session.id, toolCallId, {
                status: isError ? 'error' : 'completed',
                title: toolDisplayName,
                toolName: event.toolName,
                toolOutput: sanitizeOutputPaths(outputText).slice(0, 800),
              });

              // Send tool result message
              const toolResultMsg: Message = {
                id: uuidv4(),
                sessionId: session.id,
                role: 'assistant',
                content: [
                  {
                    type: 'tool_result',
                    toolUseId: toolCallId,
                    content: sanitizeOutputPaths(outputText),
                    isError,
                    ...(normalizedToolResult.images.length > 0
                      ? { images: normalizedToolResult.images }
                      : {}),
                  },
                ],
                timestamp: Date.now(),
              };
              this.sendMessage(session.id, toolResultMsg);
              break;
            }

            case 'agent_end': {
              logCtx('[CoworkAgentRunner] Agent finished');
              break;
            }

            case 'auto_compaction_start': {
              log('[CoworkAgentRunner] Auto-compaction started, reason:', event.reason);
              compactionStepId = `compaction-${Date.now()}`;
              this.sendTraceStep(session.id, {
                id: compactionStepId,
                type: 'thinking',
                status: 'running',
                title: `Compacting context (${event.reason})...`,
                timestamp: Date.now(),
              });
              break;
            }

            case 'auto_compaction_end': {
              const status = event.aborted ? 'error' : event.errorMessage ? 'error' : 'completed';
              const title = event.aborted
                ? 'Context compaction aborted'
                : event.errorMessage
                  ? `Context compaction failed: ${event.errorMessage}`
                  : 'Context compaction completed';
              log(
                '[CoworkAgentRunner] Auto-compaction ended:',
                title,
                'willRetry:',
                event.willRetry
              );

              // Surface compaction result details to the renderer (skip if retrying)
              if (event.result && !event.willRetry) {
                const compactionDetails = event.result.details as
                  | { readFiles?: string[]; modifiedFiles?: string[] }
                  | undefined;
                this.sendToRenderer({
                  type: 'compaction.result',
                  payload: {
                    sessionId: session.id,
                    summary: event.result.summary,
                    tokensBefore: event.result.tokensBefore,
                    readFiles: compactionDetails?.readFiles || [],
                    modifiedFiles: compactionDetails?.modifiedFiles || [],
                  },
                });
                log(
                  '[CoworkAgentRunner] Compaction result surfaced:',
                  JSON.stringify({
                    summaryLen: event.result.summary.length,
                    tokensBefore: event.result.tokensBefore,
                    readFiles: compactionDetails?.readFiles?.length || 0,
                    modifiedFiles: compactionDetails?.modifiedFiles?.length || 0,
                  })
                );
              }

              if (compactionStepId) {
                this.sendTraceUpdate(session.id, compactionStepId, { status, title });
                compactionStepId = undefined;
              } else {
                // Fallback: no matching start event, send as new step
                this.sendTraceStep(session.id, {
                  id: `compaction-end-${Date.now()}`,
                  type: 'thinking',
                  status,
                  title,
                  timestamp: Date.now(),
                });
              }

              // Overflow was deferred from message_end; surface a clear error if recovery failed.
              if (event.errorMessage && !event.willRetry && !event.aborted) {
                emitTerminalError(toUserFacingErrorText(event.errorMessage));
              }
              break;
            }
          }
        } catch (subscribeErr) {
          logError('[CoworkAgentRunner] Error in subscribe callback:', subscribeErr);
          if (compactionStepId) {
            this.sendTraceUpdate(session.id, compactionStepId, {
              status: 'error',
              title: 'Error during context compaction',
            });
            compactionStepId = undefined;
          }
          if (!hasEmittedError) {
            hasEmittedError = true;
            const errorText = toUserFacingErrorText(toErrorText(subscribeErr));
            this.sendMessage(session.id, {
              id: uuidv4(),
              sessionId: session.id,
              role: 'assistant',
              content: [{ type: 'text', text: `**Error**: ${errorText}` }],
              timestamp: Date.now(),
            });
          }
        }
      });

      // Execute the prompt — unsubscribe in finally to prevent event listener leak
      try {
        resetActivityTimeout();
        if (provider === 'ollama') {
          log(
            '[CoworkAgentRunner] Starting Ollama prompt',
            safeStringify({
              sessionId: session.id,
              modelId: activePiModel.id,
              modelProvider: activePiModel.provider,
              baseUrl: activePiModel.baseUrl || runtimeConfig.baseUrl || '',
              usedSyntheticModel,
              hasExplicitApiKey: Boolean(apiKey),
              thinkingLevel,
            })
          );
        }
        try {
          const promptResult = await piSession.prompt(contextualPrompt);
          log(
            '[CoworkAgentRunner] prompt() returned:',
            JSON.stringify(promptResult ?? 'void').substring(0, 1000)
          );
        } catch (promptErr) {
          // OpenRouter limit abort is intentional — fall through to York eco retry below.
          if (
            !(
              openRouterLimitRetry.pending &&
              !openRouterLimitRetry.done &&
              promptErr instanceof Error &&
              promptErr.name === 'AbortError'
            )
          ) {
            throw promptErr;
          }
          logCtx('[CoworkAgentRunner] OpenRouter limit abort; preparing York eco fallback');
        }

        if (
          openRouterLimitRetry.pending &&
          !openRouterLimitRetry.done &&
          !abortedByTimeout &&
          !abortedByLoopGuard
        ) {
          openRouterLimitRetry.done = true;
          openRouterLimitRetry.pending = false;
          abortedByStreamError = false;
          hasEmittedError = false;
          terminalErrorText = undefined;
          streamedText = '';

          // General / personal folders cannot fall back to York-paid models.
          if (session.division === 'general' || session.division === 'folder') {
            emitTerminalError(openRouterLimitUserMessage(false));
          } else {
            const rawModels = await fetchBackendModels();
            const enabledModels = filterModelsForOpenRouterKey(
              filterModelsForDivision(rawModels, session),
              runtimeConfig.openRouterUserApiKey
            );
            const fallback = resolveYorkPaidEcoFallback({
              enabledModels,
              promptText: promptTextForAuto,
              preference: 'eco',
            });

            if (!fallback) {
              emitTerminalError(openRouterLimitUserMessage(true));
            } else {
              log(
                `[CoworkAgentRunner] ${OPENROUTER_LIMIT_FALLBACK_NOTE} ${fallback.provider}/${fallback.modelId}`
              );
              this.sendToRenderer({
                type: 'session.autoRoute',
                payload: {
                  sessionId: session.id,
                  provider: fallback.provider,
                  modelId: fallback.modelId,
                  tier: 'fast',
                  score: 0,
                  reason: OPENROUTER_LIMIT_FALLBACK_NOTE,
                },
              });
              this.sendMessage(session.id, {
                id: uuidv4(),
                sessionId: session.id,
                role: 'assistant',
                content: [
                  {
                    type: 'text',
                    text: `_${OPENROUTER_LIMIT_FALLBACK_NOTE} Now using ${fallback.provider}/${fallback.modelId}._`,
                  },
                ],
                timestamp: Date.now(),
              });

              const yorkProtocol = resolvePiRouteProtocol(
                fallback.provider,
                fallback.customProtocol
              );
              let yorkModel = resolvePiRegistryModel(fallback.modelId, {
                configProvider: yorkProtocol,
                customBaseUrl: fallback.baseUrl,
                rawProvider: fallback.provider,
                customProtocol: fallback.customProtocol,
              });
              if (!yorkModel) {
                const synthetic = resolveSyntheticPiModelFallback({
                  rawModel: fallback.modelId,
                  resolvedModelString: fallback.modelId,
                  rawProvider: fallback.provider,
                  routeProtocol: yorkProtocol,
                  baseUrl: fallback.baseUrl,
                });
                yorkModel = buildSyntheticPiModel(
                  synthetic.modelId,
                  synthetic.provider,
                  yorkProtocol,
                  fallback.baseUrl,
                  undefined,
                  undefined,
                  runtimeConfig.contextWindow,
                  runtimeConfig.maxTokens
                );
                yorkModel = applyPiModelRuntimeOverrides(yorkModel, {
                  configProvider: yorkProtocol,
                  customBaseUrl: fallback.baseUrl,
                  rawProvider: fallback.provider,
                  customProtocol: fallback.customProtocol,
                });
              }

              if (!yorkModel) {
                emitTerminalError(openRouterLimitUserMessage(true));
              } else {
                if (isBackendManagedProvider(fallback.provider)) {
                  yorkModel = withAppVersionHeader(yorkModel, getClientAppVersion());
                }
                activePiModel = yorkModel;
                resolvedProvider = fallback.provider;
                await piSession.setModel(activePiModel);

                const yorkApiKey = (
                  await resolveBackendClientApiKey({
                    provider: fallback.provider,
                    apiKey: fallback.apiKey,
                  })
                ).trim();
                if (yorkApiKey) {
                  const authStorage = getSharedAuthStorage();
                  authStorage.setRuntimeApiKey(fallback.provider, yorkApiKey);
                  if (activePiModel.provider !== fallback.provider) {
                    authStorage.setRuntimeApiKey(activePiModel.provider, yorkApiKey);
                  }
                }

                // Fresh abort controller so subscribe callbacks accept events again.
                controller = new AbortController();
                try {
                  setMaxListeners(0, controller.signal);
                } catch {
                  // ignore
                }
                this.activeControllers.set(session.id, controller);

                resetActivityTimeout();
                const retryResult = await piSession.prompt(contextualPrompt);
                log(
                  '[CoworkAgentRunner] York eco fallback prompt() returned:',
                  JSON.stringify(retryResult ?? 'void').substring(0, 1000)
                );
              }
            }
          }
        }

        // ── Incomplete-turn recovery ──
        // search-then-stop / thinking-only / LaunchPad chat-only refuse,
        // wrong implement target, async job still running, next SDLC step.
        // Wait/next-step reasons may multi-steer; discovery reasons steer once.
        const canAttemptIncompleteRecovery =
          !controller.signal.aborted &&
          !abortedByTimeout &&
          !abortedByLoopGuard &&
          !abortedByStreamError &&
          !hasEmittedError &&
          !openRouterLimitRetry.pending;

        if (canAttemptIncompleteRecovery) {
          const evaluateIncomplete = () =>
            detectIncompleteTurn({
              userPrompt: prompt,
              toolsInvoked: toolsInvokedThisTurn,
              finalAssistant: finalAssistantSummary,
              launchPadProgress: this.getLaunchPadProgressSnapshot(session.id, prompt),
            });

          let incomplete = evaluateIncomplete();
          if (incomplete.incomplete) {
            const multiSteer = MULTI_STEER_INCOMPLETE_REASONS.has(incomplete.reason);
            const maxSteers = multiSteer ? INCOMPLETE_TURN_MULTI_STEER_MAX : 1;
            let steers = 0;
            while (incomplete.incomplete && steers < maxSteers) {
              steers += 1;
              logWarn(
                `[IncompleteTurn] Detected ${incomplete.reason}; steer ${steers}/${maxSteers}`
              );
              const lpSnap = this.getLaunchPadProgressSnapshot(session.id, prompt);
              const steerText = buildIncompleteTurnSteerMessage(incomplete.reason, lpSnap);
              finalAssistantSummary = {
                hasText: false,
                hasThinking: false,
                hasToolUse: false,
              };
              this.sendTraceUpdate(session.id, thinkingStepId, {
                title:
                  incomplete.reason === 'async_job_in_progress'
                    ? 'Waiting for LaunchPad job...'
                    : incomplete.reason === 'sdlc_next_step'
                      ? 'Continuing LaunchPad next step...'
                      : 'Continuing incomplete action...',
              });
              resetActivityTimeout();
              try {
                const continueResult = await piSession.prompt(steerText);
                log(
                  '[IncompleteTurn] continuation prompt() returned:',
                  JSON.stringify(continueResult ?? 'void').substring(0, 500)
                );
              } catch (continueErr) {
                if (continueErr instanceof Error && continueErr.name === 'AbortError') {
                  break;
                }
                throw continueErr;
              }

              if (
                controller.signal.aborted ||
                abortedByTimeout ||
                abortedByLoopGuard ||
                abortedByStreamError ||
                hasEmittedError
              ) {
                break;
              }
              incomplete = evaluateIncomplete();
              if (!multiSteer) break;
            }

            if (
              incomplete.incomplete &&
              !controller.signal.aborted &&
              !abortedByTimeout &&
              !abortedByLoopGuard &&
              !abortedByStreamError &&
              !hasEmittedError
            ) {
              const failureText = incompleteTurnFailureMessage(incomplete.reason);
              logWarn(
                `[IncompleteTurn] Still incomplete after ${steers} steer(s) (${incomplete.reason}); surfacing failure`
              );
              this.sendMessage(session.id, {
                id: uuidv4(),
                sessionId: session.id,
                role: 'assistant',
                content: [{ type: 'text', text: failureText }],
                timestamp: Date.now(),
              });
              hasEmittedError = true;
              terminalErrorText = failureText;
            }
          }
        }
      } finally {
        try {
          unsubscribe();
        } catch (e) {
          logWarn('[CoworkAgentRunner] unsubscribe error:', e);
        }
        if (activityTimeoutId) clearTimeout(activityTimeoutId);
        if (ollamaColdStartTimerId) clearTimeout(ollamaColdStartTimerId);
      }

      logTiming('agent prompt completed', runStartTime);

      // If the SDK swallowed the AbortError and returned void, detect timeout here
      if (controller.signal.aborted && abortedByTimeout) {
        logCtx('[CoworkAgentRunner] Aborted due to timeout (detected after prompt returned)');
        const errorMsg: Message = {
          id: uuidv4(),
          sessionId: session.id,
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: '**Request timed out**: No response for a long time; the operation was aborted.',
            },
          ],
          timestamp: Date.now(),
        };
        this.sendMessage(session.id, errorMsg);
        this.sendTraceUpdate(session.id, thinkingStepId, {
          status: 'error',
          title: 'Request timed out',
        });
        return;
      }
      // If the SDK swallowed the AbortError after a loop-guard abort, preserve
      // the 'error' trace status that handleLoopGuardDecision already published.
      // The user-facing message and trace step are already set; do not overwrite
      // them with the default "Task completed" below.
      const abortDisposition = resolveAbortDisposition({
        abortedByTimeout,
        abortedByLoopGuard,
        abortedByStreamError,
      });
      if (controller.signal.aborted && shouldPreserveExistingTrace(abortDisposition)) {
        logCtx(
          `[CoworkAgentRunner] Aborted by ${abortDisposition === 'loop_guard' ? 'loop guard' : 'stream error'} (detected after prompt returned)`
        );
        return;
      }
      // Complete - update the initial thinking step
      this.sendTraceUpdate(session.id, thinkingStepId, {
        status: terminalErrorText ? 'error' : 'completed',
        title: terminalErrorText ? 'Request failed' : 'Task completed',
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        const abortDisposition = resolveAbortDisposition({
          abortedByTimeout,
          abortedByLoopGuard,
          abortedByStreamError,
        });
        if (abortDisposition === 'timeout') {
          logCtx('[CoworkAgentRunner] Aborted due to timeout');
          const errorMsg: Message = {
            id: uuidv4(),
            sessionId: session.id,
            role: 'assistant',
            content: [
              {
                type: 'text',
                text: '**Request timed out**: No response for a long time; the operation was aborted.',
              },
            ],
            timestamp: Date.now(),
          };
          this.sendMessage(session.id, errorMsg);
          this.sendTraceUpdate(session.id, thinkingStepId, {
            status: 'error',
            title: 'Request timed out',
          });
        } else if (abortDisposition === 'loop_guard') {
          // Loop guard already published the user-facing assistant message and
          // an 'error' trace step with the loop-detected title. Do NOT overwrite
          // them here with a 'completed/Cancelled' state.
          logCtx('[CoworkAgentRunner] Aborted by loop guard');
        } else if (abortDisposition === 'stream_error') {
          // Stream-error handling already published the user-facing assistant
          // message and the 'Request failed' trace state. Preserve them.
          logCtx('[CoworkAgentRunner] Aborted by stream error');
        } else {
          logCtx('[CoworkAgentRunner] Aborted by user');
          this.sendTraceUpdate(session.id, thinkingStepId, {
            status: 'completed',
            title: 'Cancelled',
          });
        }
      } else {
        logCtxError('[CoworkAgentRunner] Error:', error);

        const errorText = toUserFacingErrorText(toErrorText(error));
        const errorMsg: Message = {
          id: uuidv4(),
          sessionId: session.id,
          role: 'assistant',
          content: [{ type: 'text', text: `**Error**: ${errorText}` }],
          timestamp: Date.now(),
        };
        this.sendMessage(session.id, errorMsg);

        this.sendTraceStep(session.id, {
          id: uuidv4(),
          type: 'thinking',
          status: 'error',
          title: 'Error occurred',
          timestamp: Date.now(),
        });

        // Mark so session-manager doesn't report again
        if (error instanceof Error) {
          (error as Error & { alreadyReportedToUser?: boolean }).alreadyReportedToUser = true;
        }
      }
    } finally {
      this.activeControllers.delete(session.id);
      this.pathResolver.unregisterSession(session.id);

      // Sync changes from sandbox back to host OS (but don't cleanup - sandbox persists)
      if (useSandboxIsolation && sandboxPath) {
        try {
          const sandbox = getSandboxAdapter();

          if (sandbox.isWSL) {
            log('[CoworkAgentRunner] Syncing sandbox changes to Windows...');
            const syncResult = await SandboxSync.syncToWindows(session.id);
            if (syncResult.success) {
              log('[CoworkAgentRunner] Sync completed successfully');
            } else {
              logError('[CoworkAgentRunner] Sync failed:', syncResult.error);
            }
          } else if (sandbox.isLima) {
            log('[CoworkAgentRunner] Syncing sandbox changes to macOS...');
            const { LimaSync } = await import('../sandbox/lima-sync');
            const syncResult = await LimaSync.syncToMac(session.id);
            if (syncResult.success) {
              log('[CoworkAgentRunner] Sync completed successfully');
            } else {
              logError('[CoworkAgentRunner] Sync failed:', syncResult.error);
            }
          }
        } catch (syncErr) {
          logError('[CoworkAgentRunner] Sandbox sync error:', syncErr);
          this.sendMessage(session.id, {
            id: uuidv4(),
            sessionId: session.id,
            role: 'assistant',
            content: [
              {
                type: 'text',
                text: `**Warning**: Sandbox sync failed: ${syncErr instanceof Error ? syncErr.message : String(syncErr)}`,
              },
            ],
            timestamp: Date.now(),
          });
        }
      }
    }
  }

  /**
   * Manually trigger context compaction for a session.
   * Delegates to the SDK's AgentSession.compact() method.
   *
   * @returns CompactionResult if successful, null if no session cached
   */
  async compact(
    sessionId: string,
    customInstructions?: string
  ): Promise<{
    summary: string;
    firstKeptEntryId: string;
    tokensBefore: number;
    details?: unknown;
  } | null> {
    const cached = this.piSessions.get(sessionId);
    if (!cached) {
      logWarn('[CoworkAgentRunner] No cached pi session for compact:', sessionId);
      return null;
    }
    log('[CoworkAgentRunner] Manual compact triggered for session:', sessionId);
    try {
      const result = await cached.session.compact(customInstructions);
      log(
        '[CoworkAgentRunner] Manual compact completed:',
        JSON.stringify({
          summaryLen: result.summary.length,
          tokensBefore: result.tokensBefore,
        })
      );
      const compactionDetails = result.details as
        | { readFiles?: string[]; modifiedFiles?: string[] }
        | undefined;
      this.sendToRenderer({
        type: 'compaction.result',
        payload: {
          sessionId,
          summary: result.summary,
          tokensBefore: result.tokensBefore,
          isManual: true,
          readFiles: compactionDetails?.readFiles || [],
          modifiedFiles: compactionDetails?.modifiedFiles || [],
        },
      });
      return result;
    } catch (err) {
      logError('[CoworkAgentRunner] compact error:', err);
      return null;
    }
  }

  /**
   * Get current context usage for a session.
   * Delegates to the SDK's AgentSession.getContextUsage() method.
   *
   * @returns ContextUsage { tokens, contextWindow, percent } or null
   */
  getContextUsage(
    sessionId: string
  ): { tokens: number | null; contextWindow: number; percent: number | null } | null {
    const cached = this.piSessions.get(sessionId);
    if (!cached) {
      return null;
    }
    try {
      const usage = cached.session.getContextUsage();
      log('[CoworkAgentRunner] getContextUsage:', sessionId, JSON.stringify(usage));
      return usage ?? null;
    } catch (err) {
      logError('[CoworkAgentRunner] getContextUsage error:', err);
      return null;
    }
  }

  cancel(sessionId: string): void {
    const controller = this.activeControllers.get(sessionId);
    if (controller) controller.abort();
  }

  private sendTraceStep(sessionId: string, step: TraceStep): void {
    log(`[Trace] ${step.type}: ${step.title}`);
    this.sendToRenderer({ type: 'trace.step', payload: { sessionId, step } });
  }

  private sendTraceUpdate(sessionId: string, stepId: string, updates: Partial<TraceStep>): void {
    log(`[Trace] Update step ${stepId}:`, updates);
    this.sendToRenderer({ type: 'trace.update', payload: { sessionId, stepId, updates } });
  }

  private sendMessage(sessionId: string, message: Message): void {
    // Save message to database for persistence
    if (this.saveMessage) {
      this.saveMessage(message);
    }
    // Send to renderer for UI update
    this.sendToRenderer({ type: 'stream.message', payload: { sessionId, message } });
  }

  private sendPartial(sessionId: string, delta: string): void {
    this.sendToRenderer({ type: 'stream.partial', payload: { sessionId, delta } });
  }
}
