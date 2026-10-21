/**
 * Apple Local LLM — the on-device Apple Foundation Model exposed by the
 * macOS 27 `fm` CLI (`fm serve`, FoundationModels framework).
 *
 * `fm serve` speaks the OpenAI Chat Completions API on loopback, so at the
 * wire level this rides the existing `ollama` provider plumbing (OpenAI
 * protocol, no API key) exactly like York LLM does — only the base URL,
 * model id, and lifecycle differ. York LLM is a shared remote llama.cpp
 * server; Apple Local LLM is spawned on demand on this Mac and never
 * leaves the device.
 */

export const APPLE_LLM_DISPLAY_NAME = 'Apple Local LLM (offline)';
/** `fm serve` only supports the on-device system model. */
export const APPLE_LLM_MODEL_ID = 'system';
export const APPLE_LLM_DEFAULT_PORT = 1976;
export const DEFAULT_APPLE_LLM_BASE_URL = `http://127.0.0.1:${APPLE_LLM_DEFAULT_PORT}/v1`;
/** On-device context is small (4K class) — plan compaction around it. */
export const APPLE_LLM_CONTEXT_WINDOW = 4096;
/** Reply cap so input keeps most of the 4K window. */
export const APPLE_LLM_MAX_RESPONSE_TOKENS = 512;

/**
 * Slim chat persona for Apple sessions. The default GrowthOS/coding-agent
 * system prompt tells the model to build files and deliverables; a small
 * tool-less on-device model follows that literally and emits HTML/code as
 * chat text. Apple gets a chat-first prompt instead.
 */
export const APPLE_LLM_SYSTEM_PROMPT = [
  'You are the York GrowthOS assistant running on Apple Local LLM, an on-device model.',
  'Answer directly in chat, in plain text or simple Markdown. Be concise and accurate.',
  'You are best at summarizing, extracting, classifying, rewriting, drafting, and short Q&A.',
  'Default to plain text. Write HTML or code only when the user asks for HTML or code, and then write it.',
  'Do not create files and do not claim you performed actions outside this chat.',
  'Help with every request you can answer from general knowledge or text the user provides.',
  'Only when the user asks for live, personal, or company data (calendars, leaves, Slack, email, projects, the web), say you have no access on-device and suggest York LLM or a cloud model.',
].join('\n');
/** Provider key used when Apple Local LLM is selected (OpenAI-compatible local server). */
export const APPLE_LLM_PROVIDER = 'ollama' as const;

export const APPLE_LLM_ZERO_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
} as const;

export type AppleLlmUnavailableReason =
  | 'unsupported-platform'
  | 'fm-missing'
  | 'license-required'
  | 'apple-intelligence-unavailable'
  | 'model-unavailable'
  | 'unknown';

export interface AppleLlmStatus {
  /** True when the on-device model can serve requests (license + availability OK). */
  available: boolean;
  /** True when a server is already answering on the base URL. */
  serverRunning: boolean;
  reason?: AppleLlmUnavailableReason;
  /** Human-readable detail (safe to show in the model picker). */
  message?: string;
  /**
   * Which local backend would serve requests. The bundled FoundationModels
   * helper needs no admin rights; the `fm` CLI fallback needs a one-time
   * `sudo fm license` (Jamf can push that — see scripts/jamf/).
   */
  backend?: 'foundation-models-helper' | 'fm-cli';
}

function readEnv(name: string): string {
  if (typeof process !== 'undefined' && process.env?.[name]) {
    return process.env[name]!.trim();
  }
  return '';
}

export function resolveAppleLlmPort(): number {
  const raw = readEnv('APPLE_LLM_PORT');
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  if (Number.isFinite(parsed) && parsed > 0 && parsed <= 65535) return parsed;
  return APPLE_LLM_DEFAULT_PORT;
}

export function resolveAppleLlmBaseUrl(): string {
  const fromEnv = readEnv('APPLE_LLM_BASE_URL');
  if (fromEnv) return fromEnv.replace(/\/+$/, '');
  return `http://127.0.0.1:${resolveAppleLlmPort()}/v1`;
}

export function isAppleLlmBaseUrl(baseUrl: string | undefined | null): boolean {
  const trimmed = baseUrl?.trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(trimmed);
    const loopback = ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname.toLowerCase());
    if (!loopback) return false;
    const port = parsed.port ? Number.parseInt(parsed.port, 10) : 80;
    return port === resolveAppleLlmPort();
  } catch {
    return trimmed.includes(`:${APPLE_LLM_DEFAULT_PORT}/`);
  }
}

export function isAppleLlmSelection(
  provider: string | undefined,
  baseUrl: string | undefined,
  model: string | undefined
): boolean {
  if (provider !== APPLE_LLM_PROVIDER || !model?.trim()) return false;
  if (model.trim() !== APPLE_LLM_MODEL_ID) return false;
  return isAppleLlmBaseUrl(baseUrl);
}

/** Config fields applied when selecting Apple Local LLM in the model picker. */
export function appleLlmSelectionPayload(): {
  provider: typeof APPLE_LLM_PROVIDER;
  activeProfileKey: typeof APPLE_LLM_PROVIDER;
  customProtocol: 'openai';
  baseUrl: string;
  model: string;
  apiKey: string;
  contextWindow: number;
  maxTokens: number;
} {
  return {
    provider: APPLE_LLM_PROVIDER,
    activeProfileKey: APPLE_LLM_PROVIDER,
    customProtocol: 'openai',
    baseUrl: resolveAppleLlmBaseUrl(),
    model: APPLE_LLM_MODEL_ID,
    apiKey: '',
    contextWindow: APPLE_LLM_CONTEXT_WINDOW,
    maxTokens: APPLE_LLM_MAX_RESPONSE_TOKENS,
  };
}

/** Apple Local LLM is on-device and free — never ingest cost into Hub AI Governance. */
export function shouldSkipHubUsageForAppleLlm(baseUrl: string | undefined | null): boolean {
  return isAppleLlmBaseUrl(baseUrl);
}

export function formatAppleLlmModelName(_id: string): string {
  return APPLE_LLM_DISPLAY_NAME;
}
