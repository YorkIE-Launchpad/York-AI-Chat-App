import { completeSimple, type UserMessage as PiUserMessage } from '@mariozechner/pi-ai';
import type { ApiTestInput, ApiTestResult } from '../../renderer/types';
import { PROVIDER_PRESETS, type AppConfig, type CustomProtocolType } from '../config/config-store';
import {
  normalizeAnthropicBaseUrl,
  normalizeOllamaBaseUrl,
  normalizeOpenAICompatibleBaseUrl,
  resolveOllamaCredentials,
  resolveOpenAICredentials,
  shouldAllowEmptyAnthropicApiKey,
  shouldAllowEmptyGeminiApiKey,
} from '../config/auth-utils';
import { resolveBackendClientApiKey } from '../config/backend-auth';
import { log, logWarn } from '../utils/logger';
import { normalizeGeneratedTitle } from '../session/session-title-utils';
import { getSharedAuthStorage } from './shared-auth';
import {
  applyPiModelRuntimeOverrides,
  buildSyntheticPiModel,
  inferPiApi,
  resolvePiModelString,
  resolvePiRegistryModel,
  resolvePiRouteProtocol,
  resolveSyntheticPiModelFallback,
} from './pi-model-resolution';

const NETWORK_ERROR_RE =
  /enotfound|econnrefused|etimedout|eai_again|enetunreach|timed?\s*out|timeout|abort|network\s*error/i;
const AUTH_ERROR_RE =
  /authentication[_\s-]?failed|\bunauthorized\b|invalid[_\s-]?api[_\s-]?key|api[_\s-]?key[_\s-]?invalid|api[_\s]+key[_\s]+not[_\s]+valid|\bforbidden\b|permission[_\s-]?denied|\b401\b|\b403\b/i;
const RATE_LIMIT_RE = /rate[_\s-]?limit|too\s+many\s+requests|429/i;
const SERVER_ERROR_RE = /server[_\s-]?error|internal\s+server\s+error|\b5\d\d\b/i;
const TEMPERATURE_UNSUPPORTED_RE =
  /temperature[`'"]?\s+is\s+deprecated|unsupported.*temperature|temperature.*(?:not\s+supported|does\s+not\s+support)/i;
const PROBE_ACK = 'sdk_probe_ok';
const LOCAL_ANTHROPIC_PLACEHOLDER_KEY = 'sk-ant-local-proxy';
const LOCAL_GEMINI_PLACEHOLDER_KEY = 'sk-gemini-local-proxy';

/**
 * Models that reject non-default `temperature`.
 * - Claude Fable and similar Anthropic models
 * - OpenAI GPT-5+ and o-series (only default temperature=1 is allowed)
 */
export function shouldOmitTemperature(modelId: string): boolean {
  const id = modelId.toLowerCase().trim();
  if (!id) return false;
  if (id.includes('fable')) return true;

  const bare = id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id;
  // GPT-5 family: gpt-5, gpt-5.6, gpt-5.6-sol, gpt-5.3-codex, …
  if (/^gpt-5(?:[.-]|$)/.test(bare)) return true;
  // OpenAI o-series reasoning models: o1, o3, o4-mini, …
  if (/^o[1-9](?:[.-]|$)/.test(bare)) return true;
  return false;
}

function omitTemperatureOption<T extends { temperature?: number }>(
  options: T | undefined
): Omit<T, 'temperature'> | undefined {
  if (!options || options.temperature === undefined) {
    return options;
  }
  const rest = { ...options };
  delete rest.temperature;
  return rest;
}

function resolveProbeBaseUrl(input: ApiTestInput): string | undefined {
  const configured = input.baseUrl?.trim();
  if (configured) return configured;
  if (input.provider !== 'custom') {
    return PROVIDER_PRESETS[input.provider]?.baseUrl;
  }
  return undefined;
}

function resolveProbeApiKey(
  input: ApiTestInput,
  resolvedCustomProtocol: CustomProtocolType,
  effectiveBaseUrl: string | undefined,
  explicitApiKey: string | undefined,
  config: AppConfig
): string {
  const candidateApiKey = explicitApiKey ?? config.apiKey?.trim() ?? '';
  if (candidateApiKey) {
    return candidateApiKey;
  }

  if (input.provider === 'ollama') {
    return (
      resolveOllamaCredentials({
        provider: input.provider,
        customProtocol: resolvedCustomProtocol,
        apiKey: '',
        baseUrl: effectiveBaseUrl,
      })?.apiKey || ''
    );
  }

  if (
    input.provider === 'openai' ||
    input.provider === 'openrouter' ||
    (input.provider === 'custom' && resolvedCustomProtocol === 'openai')
  ) {
    return (
      resolveOpenAICredentials({
        provider: input.provider,
        customProtocol: resolvedCustomProtocol,
        apiKey: '',
        baseUrl: effectiveBaseUrl,
      })?.apiKey || ''
    );
  }

  if (
    shouldAllowEmptyAnthropicApiKey({
      provider: input.provider,
      customProtocol: resolvedCustomProtocol,
      baseUrl: effectiveBaseUrl,
    })
  ) {
    return LOCAL_ANTHROPIC_PLACEHOLDER_KEY;
  }

  if (
    shouldAllowEmptyGeminiApiKey({
      provider: input.provider,
      customProtocol: resolvedCustomProtocol,
      baseUrl: effectiveBaseUrl,
    })
  ) {
    return LOCAL_GEMINI_PLACEHOLDER_KEY;
  }

  return '';
}

function buildProbeConfig(input: ApiTestInput, config: AppConfig): AppConfig {
  const resolvedBaseUrl = resolveProbeBaseUrl(input);
  const normalizedInputApiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : undefined;
  const resolvedCustomProtocol = resolvePiRouteProtocol(
    input.provider,
    input.customProtocol
  ) as CustomProtocolType;
  const effectiveRawBaseUrl = resolvedBaseUrl || '';
  const effectiveBaseUrl =
    input.provider === 'ollama'
      ? normalizeOllamaBaseUrl(effectiveRawBaseUrl) || effectiveRawBaseUrl
      : resolvedCustomProtocol === 'openai'
        ? normalizeOpenAICompatibleBaseUrl(effectiveRawBaseUrl) || effectiveRawBaseUrl
        : resolvedCustomProtocol === 'gemini'
          ? effectiveRawBaseUrl
          : normalizeAnthropicBaseUrl(effectiveRawBaseUrl);
  const effectiveApiKey = resolveProbeApiKey(
    input,
    resolvedCustomProtocol,
    effectiveBaseUrl,
    normalizedInputApiKey,
    config
  );
  return {
    ...config,
    provider: input.provider,
    customProtocol: resolvedCustomProtocol,
    apiKey: effectiveApiKey,
    baseUrl: effectiveBaseUrl,
    model: typeof input.model === 'string' ? input.model.trim() : config.model,
  };
}

function mapPiAiError(errorText: string, durationMs: number, provider?: string): ApiTestResult {
  const details = errorText.trim();
  const lowered = details.toLowerCase();

  if (AUTH_ERROR_RE.test(lowered)) {
    return { ok: false, latencyMs: durationMs, errorType: 'unauthorized', details };
  }
  if (RATE_LIMIT_RE.test(lowered)) {
    return { ok: false, latencyMs: durationMs, errorType: 'rate_limited', details };
  }
  if (SERVER_ERROR_RE.test(lowered)) {
    return { ok: false, latencyMs: durationMs, errorType: 'server_error', details };
  }
  if (provider === 'ollama' && /econnrefused/i.test(lowered)) {
    return { ok: false, latencyMs: durationMs, errorType: 'ollama_not_running', details };
  }
  if (NETWORK_ERROR_RE.test(lowered)) {
    return { ok: false, latencyMs: durationMs, errorType: 'network_error', details };
  }
  return { ok: false, latencyMs: durationMs, errorType: 'unknown', details };
}

/**
 * Run a simple one-shot prompt via pi-ai model directly (no agent session needed).
 */
export async function runPiAiOneShot(
  prompt: string,
  systemPrompt: string,
  config: AppConfig,
  options?: {
    temperature?: number;
    maxTokens?: number;
    signal?: AbortSignal;
  }
): Promise<{ text: string; hasThinking: boolean; durationMs: number }> {
  const modelString = resolvePiModelString(config);
  const keyProvider = config.customProtocol || config.provider || 'anthropic';
  const parts = modelString.split('/');
  const provider = parts.length >= 2 ? parts[0] : keyProvider || 'anthropic';

  // Normalize base URL for OpenAI-compatible providers (strips copy-pasted endpoint suffixes)
  const routeProtocol = resolvePiRouteProtocol(config.provider, config.customProtocol);
  const rawBaseUrl = config.baseUrl?.trim() || undefined;
  const effectiveBaseUrl =
    routeProtocol === 'openai' && config.provider !== 'ollama'
      ? normalizeOpenAICompatibleBaseUrl(rawBaseUrl) || rawBaseUrl
      : rawBaseUrl;

  let piModel = resolvePiRegistryModel(modelString, {
    configProvider: keyProvider,
    customBaseUrl: effectiveBaseUrl,
    rawProvider: config.provider || 'anthropic',
    customProtocol: config.customProtocol,
  });

  if (!piModel) {
    // Synthetic fallback for unknown/custom models
    const effectiveProtocol = resolvePiRouteProtocol(
      config.provider,
      config.customProtocol
    ) as CustomProtocolType;
    const api = effectiveBaseUrl ? inferPiApi(effectiveProtocol) : undefined;
    const synthetic = resolveSyntheticPiModelFallback({
      rawModel: config.model,
      resolvedModelString: modelString,
      rawProvider: config.provider,
      routeProtocol: effectiveProtocol,
      baseUrl: effectiveBaseUrl,
    });
    piModel = buildSyntheticPiModel(
      synthetic.modelId,
      synthetic.provider,
      effectiveProtocol,
      effectiveBaseUrl || '',
      api
    );
    piModel = applyPiModelRuntimeOverrides(piModel, {
      configProvider: keyProvider,
      customBaseUrl: effectiveBaseUrl,
      rawProvider: config.provider || 'anthropic',
      customProtocol: config.customProtocol,
    });
    logWarn('[OneShot] Model not in pi-ai registry, using synthetic model:', modelString, '→', api);
  }

  // piModel is guaranteed non-undefined after synthetic fallback
  const resolvedModel = piModel!;

  // Cognito JWT for backend-managed proxy; otherwise configured key
  const apiKey = (
    await resolveBackendClientApiKey({
      provider: config.provider,
      apiKey: config.apiKey,
    })
  ).trim();
  if (apiKey) {
    const authStorage = getSharedAuthStorage();
    // Set for the config provider
    authStorage.setRuntimeApiKey(provider, apiKey);
    // Also set for the model's native provider if different
    if (resolvedModel.provider !== provider) {
      authStorage.setRuntimeApiKey(resolvedModel.provider, apiKey);
    }
  }

  const start = Date.now();

  // Use pi-ai's completeSimple for a one-shot call
  // Pass apiKey directly in options — completeSimple uses options.apiKey || env var
  const userMsg: PiUserMessage = { role: 'user', content: prompt, timestamp: Date.now() };
  log(
    '[OneShot] Calling completeSimple:',
    resolvedModel.provider,
    resolvedModel.id,
    'baseUrl:',
    resolvedModel.baseUrl,
    'api:',
    resolvedModel.api
  );

  const generationOptions = shouldOmitTemperature(resolvedModel.id)
    ? omitTemperatureOption(options)
    : options;
  const baseOptions: {
    temperature?: number;
    maxTokens?: number;
    signal?: AbortSignal;
    apiKey: string | undefined;
  } = {
    ...generationOptions,
    apiKey: apiKey || undefined,
  };

  let response = await completeSimple(
    resolvedModel,
    {
      systemPrompt,
      messages: [userMsg],
    },
    baseOptions
  );

  // Some newer models reject temperature even when we didn't anticipate it.
  // Retry once without temperature so memory / title / probe keep working.
  const temperatureRejected =
    (response.stopReason === 'error' || response.stopReason === 'aborted') &&
    typeof response.errorMessage === 'string' &&
    TEMPERATURE_UNSUPPORTED_RE.test(response.errorMessage) &&
    baseOptions.temperature !== undefined;

  if (temperatureRejected) {
    logWarn(
      '[OneShot] Model rejected temperature; retrying without it:',
      resolvedModel.id,
      response.errorMessage
    );
    const withoutTemperature = { ...baseOptions };
    delete withoutTemperature.temperature;
    response = await completeSimple(
      resolvedModel,
      {
        systemPrompt,
        messages: [userMsg],
      },
      withoutTemperature
    );
  }

  // pi-ai resolves (not rejects) on provider errors — the error details
  // live in stopReason/errorMessage on the response object.  Surface them
  // so callers (probe, title-gen) get a meaningful error via mapPiAiError.
  if (response.stopReason === 'error' || response.stopReason === 'aborted') {
    logWarn('[OneShot] Provider error-as-resolve:', response.stopReason, response.errorMessage);
    throw new Error(response.errorMessage || 'Provider returned an error');
  }

  // Extract text and thinking content from response
  const textBlocks = response.content.filter((b) => b.type === 'text');
  const thinkingBlocks = response.content.filter((b) => b.type === 'thinking');
  const text = textBlocks
    .map((b) => (b as { text: string }).text)
    .join('')
    .trim();
  const hasThinking = thinkingBlocks.some(
    (b) => (b as { thinking: string }).thinking?.trim().length > 0
  );
  log(
    '[OneShot] Response:',
    text ? text.substring(0, 200) : '(empty)',
    'blocks:',
    response.content.length,
    'textBlocks:',
    textBlocks.length,
    'thinkingBlocks:',
    thinkingBlocks.length
  );
  return { text, hasThinking, durationMs: Date.now() - start };
}

function normalizeProbeAck(raw: string): string {
  // Strip markdown formatting and quotes around/between words, but preserve
  // underscores inside words (PROBE_ACK = 'sdk_probe_ok' contains underscores).
  return raw
    .replace(/(?<!\w)[*_~`"']+|[*_~`"']+(?!\w)/g, '')
    .replace(/[.,!?;:]+$/g, '')
    .trim()
    .toLowerCase();
}

export async function probeWithSdk(input: ApiTestInput, config: AppConfig): Promise<ApiTestResult> {
  const probeConfig = buildProbeConfig(input, config);

  if (input.provider === 'custom' && !probeConfig.baseUrl?.trim()) {
    return { ok: false, errorType: 'missing_base_url' };
  }

  if (!probeConfig.model?.trim()) {
    return { ok: false, errorType: 'unknown', details: 'missing_model' };
  }

  if (!probeConfig.apiKey?.trim()) {
    return { ok: false, errorType: 'missing_key', details: 'API key is required.' };
  }

  const probeStart = Date.now();
  try {
    const result = await runPiAiOneShot(
      `What is 2+2? After answering, also include this token: ${PROBE_ACK}`,
      `You are a connectivity test. Answer briefly, then include the token: ${PROBE_ACK}`,
      probeConfig
    );

    if (!result.text && !result.hasThinking) {
      return {
        ok: false,
        latencyMs: result.durationMs,
        errorType: 'unknown',
        details: 'empty_probe_response',
      };
    }
    // Thinking models may respond only with reasoning content and no text —
    // treat as successful probe since the model is reachable and responding.
    if (!result.text && result.hasThinking) {
      log(
        '[Probe] Thinking-only response — treating as ok (model reachable, cannot validate ack text)'
      );
      return { ok: true, latencyMs: result.durationMs };
    }
    if (!normalizeProbeAck(result.text).includes(PROBE_ACK)) {
      return {
        ok: false,
        latencyMs: result.durationMs,
        errorType: 'unknown',
        details: `probe_response_mismatch:${result.text.slice(0, 120)}`,
      };
    }
    return { ok: true, latencyMs: result.durationMs };
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    const elapsed = Date.now() - probeStart;
    return mapPiAiError(details, elapsed, input.provider);
  }
}

export async function generateTitleWithSdk(
  titlePrompt: string,
  config: AppConfig
): Promise<string | null> {
  try {
    const result = await runPiAiOneShot(
      titlePrompt,
      'Generate a concise title. Reply with only the title text and no extra markup.',
      config
    );
    const title = normalizeGeneratedTitle(result.text);
    if (!title && result.hasThinking) {
      logWarn('[SessionTitle] Thinking model returned reasoning only — no usable title text');
    }
    return title;
  } catch (error) {
    logWarn('[SessionTitle] pi-ai title generation failed:', error);
    return null;
  }
}
