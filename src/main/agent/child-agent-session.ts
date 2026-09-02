/**
 * Shared in-process child agent session runner for spawn_subagent and mcp_run.
 */
import { Type } from '@sinclair/typebox';
import {
  createAgentSession,
  SessionManager as PiSessionManager,
  SettingsManager as PiSettingsManager,
  createCodingTools,
  DefaultResourceLoader,
  type ToolDefinition,
} from '@mariozechner/pi-coding-agent';
import type { ServerEvent } from '../../renderer/types';
import { configStore } from '../config/config-store';
import { getClientAppVersion, resolveBackendClientApiKey } from '../config/backend-auth';
import type { MCPManager } from '../mcp/mcp-manager';
import { log, logError } from '../utils/logger';
import type { CheckpointService } from '../orchestration/checkpoint-service';

/** Optional durable checkpoints for child subagents (M3). */
let subagentCheckpoints: CheckpointService | null = null;

export function bindSubagentCheckpointService(service: CheckpointService | null): void {
  subagentCheckpoints = service;
}
import {
  leanMcpToolArgs,
  augmentMcpToolDescription,
  compressToolResultTextForModel,
} from './mcp-tool-payload';
import { normalizeMcpToolResultForModel } from './tool-result-utils';
import { buildMcpMetaTools, selectCustomToolsForModel } from './mcp-tool-budget';
import { resolveFreeModelForChild } from './free-model-resolve';
import { resolveAutoModelIfNeeded } from './auto-model-resolve';
import { reportHubGovernanceUsageFromCompletion } from '../hub/hub-ai-governance';
import type { CustomProtocolType, ProviderType } from '../config/config-store';
import {
  applyPiModelRuntimeOverrides,
  buildSyntheticPiModel,
  inferPiApi,
  resolvePiRegistryModel,
  resolvePiRouteProtocol,
  resolveSyntheticPiModelFallback,
} from './pi-model-resolution';
import {
  applyOpenRouterClaudeCacheHints,
  enableLongAnthropicPromptCache,
} from './prompt-cache';
import { getSharedAuthStorage, ModelRegistry } from './shared-auth';
import { fetchBackendModels } from '../config/backend-client';
import {
  filterModelsForOpenRouterKey,
  resolveYorkPaidEcoFallback,
} from '../../shared/openrouter-fallback';
import { isBackendManagedProvider } from '../../shared/backend-config';
import { withAppVersionHeader } from '../../shared/client-version';
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
import {
  generalWorkspaceOpenRouterOnlyMessage,
  isProviderAllowedInDivision,
  filterMcpToolsForDivision,
  type SessionDivisionFields,
} from '../../shared/workspace-division';
import { applyCompanyProjectScopedMcpResultFilter } from '../../shared/company-project-mcp-scope';
import { prepareCompanyProjectScopedMcpArgs as prepareProjectScopedMcpArgs } from '../../shared/company-project-mcp-scope';
import { linkageForSession } from '../hub/project-linkage-cache';
import type { ProjectLinkageMetadata } from '../../shared/project-linkage-metadata';
import type { OnProjectScopeViolation } from '../../shared/project-mcp-scope';
import { v4 as uuidv4 } from 'uuid';
import {
  createProjectScopeViolationReporter,
  emitProjectScopeBlock,
} from './project-scope-violation';
import { buildProfileInstructionsBlock } from './profile-instructions';

export const MAX_CHILD_TIMEOUT_MS = 300_000;
export const DEFAULT_CHILD_TIMEOUT_MS = 120_000;
export const MAX_CONCURRENT_CHILD_AGENTS = 3;
export const MAX_CHILD_TASK_LENGTH = 10_000;

export const childAgentConcurrency = { active: 0 };

export class ChildAgentTimeoutError extends Error {
  constructor() {
    super('Subagent timed out');
  }
}

export class ParentCancelledError extends Error {
  constructor() {
    super('Parent session cancelled');
  }
}

type SendEvent = (event: ServerEvent) => void;
export type ChildPermissionHandler = (
  toolName: string,
  toolInput: unknown
) => Promise<'allow' | 'deny'>;

type SubagentProgressPayload = Extract<ServerEvent, { type: 'subagent.progress' }>['payload'];

function buildProgressEvent(
  parentSessionId: string,
  subagentId: string,
  payload: Omit<SubagentProgressPayload, 'parentSessionId' | 'subagentId'>
): ServerEvent {
  return {
    type: 'subagent.progress',
    payload: { parentSessionId, subagentId, ...payload },
  };
}

function safeSendEvent(sendEvent: SendEvent | undefined, event: ServerEvent): void {
  if (!sendEvent) return;
  try {
    sendEvent(event);
  } catch {
    // Renderer may be disconnected
  }
}

export function buildChildSystemPrompt(task: string, resultFormat?: string): string {
  const parts = [
    'You are a focused sub-agent. Complete the task below and return ONLY the result.',
    'Do not ask questions. Do not provide commentary beyond what is needed for the result.',
    '',
    `## Task`,
    task,
  ];
  if (resultFormat) {
    parts.push('', `## Expected Output Format`, resultFormat);
  }
  return parts.join('\n');
}

export function buildMcpRunChildSystemPrompt(
  goal: string,
  options?: { server?: string; resultFormat?: string }
): string {
  const parts = [
    'You are an MCP tool runner. Discover the right MCP tools and call them to fulfill the goal.',
    'Use mcp_search_tools to find tools, then mcp_call_tool to invoke them.',
    'After mcp_search_tools returns matches, immediately call mcp_call_tool in the same turn — do not stop after searching.',
    'Return ONLY the distilled facts needed to answer the goal — no preamble, no tool narration.',
    '',
    `## Goal`,
    goal,
  ];
  if (options?.server) {
    parts.push('', `## Preferred MCP server filter`, options.server);
  }
  if (options?.resultFormat) {
    parts.push('', `## Expected Output Format`, options.resultFormat);
  }
  return parts.join('\n');
}

function buildFlatMcpTools(
  mcpManager: MCPManager,
  division?: Partial<SessionDivisionFields> | null,
  onProjectScopeViolation?: OnProjectScopeViolation | null,
  sessionId?: string | null,
  linkage?: ProjectLinkageMetadata
): ToolDefinition[] {
  const resolvedLinkage = linkage ?? linkageForSession(division);
  return filterMcpToolsForDivision(mcpManager.getTools(), division).map((mcpTool) => {
    const parameters = Type.Unsafe<Record<string, unknown>>(
      mcpTool.inputSchema as Record<string, unknown>
    );
    return {
      name: mcpTool.name,
      label: `${mcpTool.serverName} → ${mcpTool.originalName || mcpTool.name}`,
      description: augmentMcpToolDescription(
        mcpTool.name,
        mcpTool.description || `MCP tool from ${mcpTool.serverName}`
      ),
      parameters,
      async execute(_id: string, p: unknown) {
        const leanArgs = leanMcpToolArgs(
          p && typeof p === 'object' ? (p as Record<string, unknown>) : {},
          mcpTool.inputSchema
        );
        const prepared = prepareProjectScopedMcpArgs(mcpTool.name, leanArgs, division, resolvedLinkage);
        if (prepared.kind === 'block') {
          emitProjectScopeBlock(
            onProjectScopeViolation,
            prepared,
            mcpTool.name,
            division,
            sessionId
          );
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
              applyCompanyProjectScopedMcpResultFilter(mcpTool.name, normalizedResult.text, division)
            )
          : normalizedResult.text;
        return {
          content: [{ type: 'text' as const, text }],
          details:
            normalizedResult.images.length > 0
              ? { openCoworkImages: normalizedResult.images }
              : undefined,
        };
      },
    } as ToolDefinition;
  });
}

async function resolveChildPiModel(options: {
  modelMode: 'free' | 'inherit';
  promptText: string;
  division?: Partial<SessionDivisionFields> | null;
}): Promise<{
  piModel: NonNullable<ReturnType<typeof resolvePiRegistryModel>>;
  provider: string;
  apiKey: string | undefined;
} | null> {
  const config = configStore.getAll();
  const authStorage = getSharedAuthStorage();

  let modelString = config.model?.trim() || 'auto';
  let provider = config.provider;
  let customProtocol = config.customProtocol;
  let baseUrl = config.baseUrl?.trim() || undefined;
  let apiKey = config.apiKey;

  if (options.modelMode === 'free') {
    const freeRoute = await resolveFreeModelForChild({
      promptText: options.promptText,
      division: options.division,
      parent: {
        model: config.model,
        provider: config.provider,
        customProtocol: config.customProtocol,
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        autoModelPreference: config.autoModelPreference,
      },
    });
    modelString = freeRoute.modelId;
    provider = freeRoute.provider as ProviderType;
    customProtocol = freeRoute.customProtocol;
    baseUrl = freeRoute.baseUrl || undefined;
    apiKey = freeRoute.apiKey || apiKey;
  } else {
    const autoRoute = await resolveAutoModelIfNeeded({
      model: modelString,
      preference: config.autoModelPreference,
      promptText: options.promptText,
      messageCount: 1,
      contextChars: options.promptText.length,
      division: options.division,
    });
    if (autoRoute.usedAuto) {
      modelString = autoRoute.modelId;
      provider = autoRoute.provider;
      customProtocol = autoRoute.customProtocol;
      baseUrl = autoRoute.baseUrl;
      apiKey = autoRoute.apiKey || apiKey;
    }
  }

  if (!isProviderAllowedInDivision(provider, options.division)) {
    log(`[ChildAgent] Provider ${provider} blocked in General workspace`);
    return null;
  }

  const configProtocol = resolvePiRouteProtocol(provider, customProtocol);
  let piModel = resolvePiRegistryModel(modelString, {
    configProvider: configProtocol,
    customBaseUrl: baseUrl,
    rawProvider: provider,
    customProtocol,
  });

  if (!piModel) {
    const effectiveProtocol = resolvePiRouteProtocol(
      provider,
      customProtocol
    ) as CustomProtocolType;
    const api = baseUrl ? inferPiApi(effectiveProtocol) : undefined;
    const synthetic = resolveSyntheticPiModelFallback({
      rawModel: modelString,
      resolvedModelString: modelString.includes('/')
        ? modelString
        : `${provider || 'openrouter'}/${modelString}`,
      rawProvider: provider,
      routeProtocol: effectiveProtocol,
      baseUrl,
    });
    piModel = buildSyntheticPiModel(
      synthetic.modelId,
      synthetic.provider,
      effectiveProtocol,
      baseUrl || '',
      api
    );
    piModel = applyPiModelRuntimeOverrides(piModel, {
      configProvider: configProtocol,
      customBaseUrl: baseUrl,
      rawProvider: provider || 'anthropic',
      customProtocol,
    });
    log(`[ChildAgent] Model not in registry, using synthetic: ${modelString}`);
  }

  if (!piModel) return null;

  if (provider === 'openrouter') {
    const userKey = config.openRouterUserApiKey?.trim();
    if (!hasOpenRouterUserApiKey(userKey)) {
      log(`[ChildAgent] OpenRouter selected but no user key configured`);
      return null;
    }
    piModel = withOpenRouterUserKeyHeader(piModel, userKey);
  }

  if (isBackendManagedProvider(provider)) {
    piModel = withAppVersionHeader(piModel, getClientAppVersion());
  }

  const runtimeApiKey = (
    await resolveBackendClientApiKey({
      provider,
      apiKey,
    })
  ).trim();
  if (runtimeApiKey) {
    const piProvider =
      provider === 'custom' ? customProtocol || 'anthropic' : provider || 'anthropic';
    authStorage.setRuntimeApiKey(piProvider, runtimeApiKey);
    if (piModel.provider !== piProvider) {
      authStorage.setRuntimeApiKey(piModel.provider, runtimeApiKey);
    }
  }

  return { piModel, provider: provider || 'anthropic', apiKey };
}

export interface RunChildAgentSessionInput {
  task: string;
  resultFormat?: string;
  systemPrompt?: string;
  timeoutMs?: number;
  /** Default: 'free'. Pass 'inherit' to use parent/auto routing. */
  modelMode?: 'free' | 'inherit';
  /** Include read/bash/edit/write. Default true. */
  includeCodingTools?: boolean;
  /**
   * MCP tool exposure for the child:
   * - flat: all MCP tools (budget may switch to search+call)
   * - meta-only: only mcp_search_tools + mcp_call_tool
   * - none: no MCP tools
   */
  mcpToolsMode?: 'flat' | 'meta-only' | 'none';
  allowedTools?: string[];
  mcpManager: MCPManager | null;
  sendEvent?: SendEvent;
  parentSessionId?: string;
  requestPermission?: ChildPermissionHandler | null;
  getParentAbortSignal?: () => AbortSignal | null;
  concurrencyState?: { active: number };
  /** When set, emit subagent.progress events under this id (generated if omitted and sendEvent set). */
  subagentId?: string;
  emitProgress?: boolean;
  /** Parent session workspace division (provider gating is FE-owned). */
  division?: Partial<SessionDivisionFields> | null;
  /** Hub usage feature tag (default: subagent). */
  usageFeature?: string;
}

export interface RunChildAgentSessionResult {
  text: string;
  subagentId: string;
  durationMs: number;
  error?: 'timeout' | 'cancelled' | 'concurrency' | 'model' | 'task' | string;
}

export async function runChildAgentSession(
  input: RunChildAgentSessionInput
): Promise<RunChildAgentSessionResult> {
  const task = input.task?.trim() || '';
  const subagentId = input.subagentId || uuidv4();
  const concurrencyState = input.concurrencyState || childAgentConcurrency;
  const emitProgress = Boolean(input.emitProgress && input.sendEvent && input.parentSessionId);
  const startTime = Date.now();

  if (!task) {
    return {
      text: 'Error: task parameter is required.',
      subagentId,
      durationMs: 0,
      error: 'task',
    };
  }
  if (task.length > MAX_CHILD_TASK_LENGTH) {
    return {
      text: `Error: task exceeds maximum length (${MAX_CHILD_TASK_LENGTH} chars). Shorten the task description.`,
      subagentId,
      durationMs: 0,
      error: 'task',
    };
  }
  if (concurrencyState.active >= MAX_CONCURRENT_CHILD_AGENTS) {
    return {
      text: `Error: maximum concurrent subagents (${MAX_CONCURRENT_CHILD_AGENTS}) reached. Wait for a running subagent to complete.`,
      subagentId,
      durationMs: 0,
      error: 'concurrency',
    };
  }

  const timeoutMs = Math.min(input.timeoutMs ?? DEFAULT_CHILD_TIMEOUT_MS, MAX_CHILD_TIMEOUT_MS);
  const modelMode = input.modelMode ?? 'free';
  const includeCodingTools = input.includeCodingTools !== false;
  const mcpToolsMode = input.mcpToolsMode ?? 'flat';

  concurrencyState.active++;
  const checkpointRunId =
    subagentCheckpoints?.startRun({
      kind: 'subagent',
      stepId: 'run',
      sessionId: input.parentSessionId ?? null,
      sourceId: subagentId,
      title: task.slice(0, 120),
      payload: { subagentId, task: task.slice(0, 500) },
    }).id ?? null;

  try {
    log(
      `[ChildAgent] Spawning ${subagentId} modelMode=${modelMode} task="${task.slice(0, 100)}..."`
    );

    const resolved = await resolveChildPiModel({
      modelMode,
      promptText: task,
      division: input.division,
    });
    if (!resolved) {
      const needsOrKey = configStore.getAll().provider === 'openrouter' || modelMode === 'free';
      const blockedInGeneral =
        (input.division?.division === 'general' || input.division?.division === 'folder') &&
        !isProviderAllowedInDivision(configStore.getAll().provider, input.division);
      const errorText = blockedInGeneral
        ? `Error: ${generalWorkspaceOpenRouterOnlyMessage()}`
        : needsOrKey && !hasOpenRouterUserApiKey(configStore.getAll().openRouterUserApiKey)
          ? `Error: ${openRouterKeyRequiredMessage()}`
          : 'Error: could not resolve model for subagent. Check provider/model config.';
      if (emitProgress && input.parentSessionId) {
        safeSendEvent(
          input.sendEvent,
          buildProgressEvent(input.parentSessionId, subagentId, {
            event: 'failed',
            task: task.slice(0, 200),
            error: errorText,
            durationMs: Date.now() - startTime,
            model: modelMode,
          })
        );
      }
      return {
        text: errorText,
        subagentId,
        durationMs: Date.now() - startTime,
        error: 'model',
      };
    }

    if (emitProgress && input.parentSessionId) {
      safeSendEvent(
        input.sendEvent,
        buildProgressEvent(input.parentSessionId, subagentId, {
          event: 'started',
          task: task.slice(0, 200),
          model: resolved.piModel.id,
        })
      );
    }

    let { piModel } = resolved;
    let activeProvider = resolved.provider;
    const authStorage = getSharedAuthStorage();
    const modelRegistry = new ModelRegistry(authStorage);
    const config = configStore.getAll();
    const cwd = config.defaultWorkdir || process.cwd();

    let customTools: ToolDefinition[] = [];
    const codingTools = includeCodingTools ? createCodingTools(cwd) : [];
    const onProjectScopeViolation = createProjectScopeViolationReporter({
      sessionId: input.parentSessionId,
      division: input.division,
      sendToRenderer: input.sendEvent,
    });

    const sessionLinkage = linkageForSession(input.division);
    if (mcpToolsMode === 'meta-only' && input.mcpManager) {
      let allowed: Set<string> | null = null;
      if (input.allowedTools && input.allowedTools.length > 0) {
        allowed = new Set(input.allowedTools);
      }
      customTools = buildMcpMetaTools(
        input.mcpManager,
        allowed,
        input.division,
        onProjectScopeViolation,
        input.parentSessionId,
        undefined,
        sessionLinkage
      );
    } else if (mcpToolsMode === 'flat' && input.mcpManager) {
      let mcpCustomTools = buildFlatMcpTools(
        input.mcpManager,
        input.division,
        onProjectScopeViolation,
        input.parentSessionId,
        sessionLinkage
      );
      let allowedToolNames: Set<string> | null = null;
      if (input.allowedTools && input.allowedTools.length > 0) {
        allowedToolNames = new Set(input.allowedTools);
        mcpCustomTools = mcpCustomTools.filter((t) => allowedToolNames!.has(t.name));
      }
      const toolSelection = selectCustomToolsForModel({
        api: piModel.api,
        builtInToolCount: codingTools.length,
        mcpManager: input.mcpManager,
        mcpTools: mcpCustomTools,
        extensionTools: [],
        allowedToolNames,
        // Children always get search+call meta tools, never mcp_run (avoid nested offload).
        parentMetaTools: undefined,
        useSearchCallMeta: true,
        division: input.division,
        onProjectScopeViolation,
        sessionId: input.parentSessionId,
        linkage: sessionLinkage,
      });
      customTools = toolSelection.customTools;
      if (toolSelection.mode === 'meta') {
        log(
          `[ChildAgent] Using MCP meta search/call (${mcpCustomTools.length} flat tools exceeded limit)`
        );
      }
    }

    const baseChildSystemPrompt =
      input.systemPrompt || buildChildSystemPrompt(task, input.resultFormat);
    const profileInstructions = buildProfileInstructionsBlock(configStore.getAll());
    const childSystemPrompt = [baseChildSystemPrompt, profileInstructions]
      .filter((section) => Boolean(section && section.trim()))
      .join('\n\n');
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      appendSystemPrompt: childSystemPrompt,
    });
    await resourceLoader.reload();

    enableLongAnthropicPromptCache();
    piModel = applyOpenRouterClaudeCacheHints(
      piModel,
      input.parentSessionId || subagentId
    );

    const { session: childSession } = await createAgentSession({
      model: piModel,
      authStorage,
      modelRegistry,
      tools: codingTools,
      customTools,
      sessionManager: PiSessionManager.inMemory(),
      settingsManager: PiSettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: true, maxRetries: 1 },
      }),
      resourceLoader,
      cwd,
    });

    if (input.requestPermission) {
      const piSession = childSession as unknown as {
        setBeforeToolCall?: (
          hook: (call: {
            toolName: string;
            args: unknown;
          }) => Promise<{ block: boolean; reason?: string } | void>
        ) => void;
      };
      if (typeof piSession.setBeforeToolCall === 'function') {
        const requestPermission = input.requestPermission;
        piSession.setBeforeToolCall(async (call) => {
          const decision = await requestPermission(call.toolName, call.args);
          if (decision === 'deny') {
            return { block: true, reason: 'Permission denied by parent session policy' };
          }
          return undefined;
        });
      } else {
        logError(
          '[ChildAgent] Child session does not support setBeforeToolCall — permission gating disabled'
        );
      }
    }

    let finalText = '';
    const usageFeature = (input.usageFeature || '').trim() || 'subagent';
    const unsubscribe = childSession.subscribe((event) => {
      if (event.type === 'message_end') {
        const msg = event.message as unknown as {
          usage?: unknown;
          responseId?: unknown;
        };
        if (msg) {
          reportHubGovernanceUsageFromCompletion({
            modelId: String(piModel.id || ''),
            provider: String(piModel.provider || activeProvider || ''),
            sessionId: input.parentSessionId || subagentId,
            division: input.division?.division ?? null,
            hubProjectId: input.division?.hubProjectId ?? null,
            folderId: input.division?.folderId ?? null,
            launchpadProjectId: input.division?.launchpadProjectId ?? null,
            feature: usageFeature,
            usage: msg.usage,
            responseId: typeof msg.responseId === 'string' ? msg.responseId : null,
            latencyMs: Date.now() - startTime,
            status: 'ok',
            metadata: {
              subagent_id: subagentId,
              model_mode: modelMode,
            },
          });
        }
      }

      if (event.type === 'agent_end') {
        const messages = (event as { messages?: unknown[] }).messages || [];
        for (let i = messages.length - 1; i >= 0; i--) {
          const msg = messages[i] as { role?: string; content?: unknown } | undefined;
          if (msg && msg.role === 'assistant' && Array.isArray(msg.content)) {
            finalText = (msg.content as Array<{ type: string; text?: string }>)
              .filter((b) => b.type === 'text' && b.text)
              .map((b) => b.text)
              .join('');
            break;
          }
        }
      }

      if (!emitProgress || !input.parentSessionId) return;

      if (event.type === 'tool_execution_start') {
        safeSendEvent(
          input.sendEvent,
          buildProgressEvent(input.parentSessionId, subagentId, {
            event: 'tool_start',
            toolName: (event as { toolName?: string }).toolName || 'unknown',
          })
        );
      } else if (event.type === 'tool_execution_end') {
        const e = event as { toolName?: string; isError?: boolean };
        safeSendEvent(
          input.sendEvent,
          buildProgressEvent(input.parentSessionId, subagentId, {
            event: 'tool_end',
            toolName: e.toolName || 'unknown',
            isError: e.isError || false,
          })
        );
      } else if (event.type === 'message_update') {
        const e = event as { message?: { content?: unknown[] } };
        const content = e.message?.content;
        if (Array.isArray(content)) {
          const lastText = content
            .filter((b): b is { type: 'text'; text: string } => {
              const block = b as { type?: string; text?: string };
              return block.type === 'text' && typeof block.text === 'string';
            })
            .pop();
          if (lastText) {
            safeSendEvent(
              input.sendEvent,
              buildProgressEvent(input.parentSessionId, subagentId, {
                event: 'text_delta',
                text: lastText.text,
              })
            );
          }
        }
      }
    });

    let timeoutId: NodeJS.Timeout | undefined;
    const parentSignal = input.getParentAbortSignal?.() ?? null;
    let parentAbortHandler: (() => void) | undefined;

    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new ChildAgentTimeoutError()), timeoutMs);
      });

      const parentAbortPromise = parentSignal
        ? new Promise<never>((_, reject) => {
            if (parentSignal.aborted) {
              reject(new ParentCancelledError());
              return;
            }
            parentAbortHandler = () => reject(new ParentCancelledError());
            parentSignal.addEventListener('abort', parentAbortHandler);
          })
        : null;

      const racers: Promise<unknown>[] = [childSession.prompt(task), timeoutPromise];
      if (parentAbortPromise) racers.push(parentAbortPromise);

      try {
        await Promise.race(racers);
      } catch (promptErr) {
        const promptMessage = promptErr instanceof Error ? promptErr.message : String(promptErr);
        if (
          !(promptErr instanceof ChildAgentTimeoutError) &&
          !(promptErr instanceof ParentCancelledError) &&
          isOpenRouterAccountLimitError(activeProvider, promptMessage)
        ) {
          if (input.division?.division === 'general' || input.division?.division === 'folder') {
            throw new Error(openRouterLimitUserMessage(false));
          }
          const rawModels = await fetchBackendModels();
          const enabledModels = filterModelsForOpenRouterKey(
            rawModels,
            config.openRouterUserApiKey
          );
          const fallback = resolveYorkPaidEcoFallback({
            enabledModels,
            promptText: task,
            preference: 'eco',
          });
          if (!fallback) {
            throw new Error(openRouterLimitUserMessage(true));
          }
          log(
            `[ChildAgent] ${OPENROUTER_LIMIT_FALLBACK_NOTE} ${fallback.provider}/${fallback.modelId}`
          );
          let yorkModel = resolvePiRegistryModel(fallback.modelId, {
            configProvider: fallback.customProtocol,
            customBaseUrl: fallback.baseUrl,
            rawProvider: fallback.provider,
            customProtocol: fallback.customProtocol,
          });
          if (!yorkModel) {
            const synthetic = resolveSyntheticPiModelFallback({
              rawModel: fallback.modelId,
              resolvedModelString: fallback.modelId,
              rawProvider: fallback.provider,
              routeProtocol: fallback.customProtocol,
              baseUrl: fallback.baseUrl,
            });
            yorkModel = buildSyntheticPiModel(
              synthetic.modelId,
              synthetic.provider,
              fallback.customProtocol,
              fallback.baseUrl,
              inferPiApi(fallback.customProtocol)
            );
            yorkModel = applyPiModelRuntimeOverrides(yorkModel, {
              configProvider: fallback.customProtocol,
              customBaseUrl: fallback.baseUrl,
              rawProvider: fallback.provider,
              customProtocol: fallback.customProtocol,
            });
          }
          piModel = yorkModel;
          if (isBackendManagedProvider(fallback.provider)) {
            piModel = withAppVersionHeader(piModel, getClientAppVersion());
          }
          activeProvider = fallback.provider;
          const yorkApiKey = (
            await resolveBackendClientApiKey({
              provider: fallback.provider,
              apiKey: fallback.apiKey,
            })
          ).trim();
          if (yorkApiKey) {
            authStorage.setRuntimeApiKey(fallback.provider, yorkApiKey);
            if (piModel.provider !== fallback.provider) {
              authStorage.setRuntimeApiKey(piModel.provider, yorkApiKey);
            }
          }
          await childSession.setModel(piModel);

          // Fresh timeout for the fallback attempt (prior timeout promise may already be settled).
          const retryTimeoutPromise = new Promise<never>((_, reject) => {
            if (timeoutId) clearTimeout(timeoutId);
            timeoutId = setTimeout(() => reject(new ChildAgentTimeoutError()), timeoutMs);
          });
          const retryRacers: Promise<unknown>[] = [childSession.prompt(task), retryTimeoutPromise];
          if (parentAbortPromise) retryRacers.push(parentAbortPromise);
          await Promise.race(retryRacers);
        } else {
          throw promptErr;
        }
      }
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      if (parentAbortHandler && parentSignal) {
        parentSignal.removeEventListener('abort', parentAbortHandler);
      }
      unsubscribe();
      try {
        const abortable = childSession as unknown as { abort?: () => Promise<void> | void };
        if (abortable.abort) {
          const abortResult = abortable.abort();
          if (abortResult && typeof abortResult === 'object' && 'then' in abortResult) {
            const abortTimeout = new Promise<void>((r) => setTimeout(r, 5000));
            await Promise.race([abortResult, abortTimeout]);
          }
        }
      } catch {
        // ignore
      }
      childSession.dispose();
    }

    const durationMs = Date.now() - startTime;
    log(`[ChildAgent] Child ${subagentId} completed in ${durationMs}ms`);

    if (checkpointRunId) {
      subagentCheckpoints?.checkpoint(
        checkpointRunId,
        'done',
        { durationMs, textPreview: finalText.slice(0, 200) },
        'completed'
      );
    }

    if (emitProgress && input.parentSessionId) {
      safeSendEvent(
        input.sendEvent,
        buildProgressEvent(input.parentSessionId, subagentId, {
          event: 'completed',
          durationMs,
        })
      );
    }

    return {
      text: finalText || '(subagent produced no text output)',
      subagentId,
      durationMs,
    };
  } catch (err: unknown) {
    const durationMs = Date.now() - startTime;
    const message = err instanceof Error ? err.message : String(err);
    logError(`[ChildAgent] Child ${subagentId} failed after ${durationMs}ms:`, message);

    const isTimeout = err instanceof ChildAgentTimeoutError;
    const isCancelled = err instanceof ParentCancelledError;
    const errorKind = isTimeout ? 'timeout' : isCancelled ? 'cancelled' : message;

    if (checkpointRunId) {
      subagentCheckpoints?.fail(checkpointRunId, String(errorKind));
    }

    if (emitProgress && input.parentSessionId) {
      safeSendEvent(
        input.sendEvent,
        buildProgressEvent(input.parentSessionId, subagentId, {
          event: 'failed',
          error: isTimeout ? 'timeout' : isCancelled ? 'cancelled' : message.slice(0, 200),
          durationMs,
        })
      );
    }

    return {
      text: isTimeout
        ? `Subagent timed out after ${Math.round(durationMs / 1000)}s (child wall-clock). This does not always mean the MCP server failed — remote MCP calls (especially Atlassian Jira/Confluence) often need timeout_seconds up to 300. Retry with a narrower goal and a higher timeout_seconds.`
        : isCancelled
          ? 'Subagent cancelled: parent session was stopped.'
          : `Subagent error: ${message}`,
      subagentId,
      durationMs,
      error: errorKind,
    };
  } finally {
    concurrencyState.active--;
  }
}
