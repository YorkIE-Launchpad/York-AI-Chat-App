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
import { resolveBackendClientApiKey } from '../config/backend-auth';
import type { MCPManager } from '../mcp/mcp-manager';
import { log, logError } from '../utils/logger';
import { leanMcpToolArgs, augmentMcpToolDescription } from './mcp-tool-payload';
import { normalizeMcpToolResultForModel } from './tool-result-utils';
import { buildMcpMetaTools, selectCustomToolsForModel } from './mcp-tool-budget';
import { resolveFreeModelForChild } from './free-model-resolve';
import { resolveAutoModelIfNeeded } from './auto-model-resolve';
import type { CustomProtocolType, ProviderType } from '../config/config-store';
import {
  applyPiModelRuntimeOverrides,
  buildSyntheticPiModel,
  inferPiApi,
  resolvePiRegistryModel,
  resolvePiRouteProtocol,
  resolveSyntheticPiModelFallback,
} from './pi-model-resolution';
import { getSharedAuthStorage, ModelRegistry } from './shared-auth';
import { fetchBackendModels } from '../config/backend-client';
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
import { v4 as uuidv4 } from 'uuid';

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

function buildFlatMcpTools(mcpManager: MCPManager): ToolDefinition[] {
  return mcpManager.getTools().map((mcpTool) => {
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
        const result = await mcpManager.callTool(mcpTool.name, leanArgs);
        const normalizedResult = normalizeMcpToolResultForModel(result);
        return {
          content: [{ type: 'text' as const, text: normalizedResult.text }],
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
    });
    if (autoRoute.usedAuto) {
      modelString = autoRoute.modelId;
      provider = autoRoute.provider;
      customProtocol = autoRoute.customProtocol;
      baseUrl = autoRoute.baseUrl;
      apiKey = autoRoute.apiKey || apiKey;
    }
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
  if (emitProgress && input.parentSessionId) {
    safeSendEvent(
      input.sendEvent,
      buildProgressEvent(input.parentSessionId, subagentId, {
        event: 'started',
        task: task.slice(0, 200),
      })
    );
  }

  try {
    log(
      `[ChildAgent] Spawning ${subagentId} modelMode=${modelMode} task="${task.slice(0, 100)}..."`
    );

    const resolved = await resolveChildPiModel({ modelMode, promptText: task });
    if (!resolved) {
      const needsOrKey = configStore.getAll().provider === 'openrouter' || modelMode === 'free';
      return {
        text:
          needsOrKey && !hasOpenRouterUserApiKey(configStore.getAll().openRouterUserApiKey)
            ? `Error: ${openRouterKeyRequiredMessage()}`
            : 'Error: could not resolve model for subagent. Check provider/model config.',
        subagentId,
        durationMs: Date.now() - startTime,
        error: 'model',
      };
    }

    let { piModel } = resolved;
    let activeProvider = resolved.provider;
    const authStorage = getSharedAuthStorage();
    const modelRegistry = new ModelRegistry(authStorage);
    const config = configStore.getAll();
    const cwd = config.defaultWorkdir || process.cwd();

    let customTools: ToolDefinition[] = [];
    const codingTools = includeCodingTools ? createCodingTools(cwd) : [];

    if (mcpToolsMode === 'meta-only' && input.mcpManager) {
      let allowed: Set<string> | null = null;
      if (input.allowedTools && input.allowedTools.length > 0) {
        allowed = new Set(input.allowedTools);
      }
      customTools = buildMcpMetaTools(input.mcpManager, allowed);
    } else if (mcpToolsMode === 'flat' && input.mcpManager) {
      let mcpCustomTools = buildFlatMcpTools(input.mcpManager);
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
      });
      customTools = toolSelection.customTools;
      if (toolSelection.mode === 'meta') {
        log(
          `[ChildAgent] Using MCP meta search/call (${mcpCustomTools.length} flat tools exceeded limit)`
        );
      }
    }

    const childSystemPrompt =
      input.systemPrompt || buildChildSystemPrompt(task, input.resultFormat);
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      appendSystemPrompt: childSystemPrompt,
    });
    await resourceLoader.reload();

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
    const unsubscribe = childSession.subscribe((event) => {
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
