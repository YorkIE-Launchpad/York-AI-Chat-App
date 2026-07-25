/**
 * Virtual "Auto" model: rule-based router that picks a concrete catalog model
 * per message from curated fast / balanced / frontier tiers.
 */
import type { BackendCloudProvider, BackendModelInfo } from './backend-config';

export const AUTO_MODEL_ID = 'auto';

export type AutoModelPreference = 'eco' | 'balanced' | 'max';
export type AutoModelTier = 'fast' | 'balanced' | 'frontier';

export interface AutoModelCandidate {
  provider: BackendCloudProvider;
  id: string;
  supportsVision: boolean;
}

export interface AutoModelPick {
  provider: BackendCloudProvider;
  modelId: string;
  tier: AutoModelTier;
  score: number;
  reason: string;
}

export interface PromptComplexityContext {
  hasImages?: boolean;
  messageCount?: number;
  contextChars?: number;
}

const TIER_ORDER: AutoModelTier[] = ['fast', 'balanced', 'frontier'];

/** Curated pool — preference order within each tier. Free OpenRouter first on fast/balanced; after paid on frontier. */
export const AUTO_MODEL_TIERS: Record<AutoModelTier, AutoModelCandidate[]> = {
  fast: [
    { provider: 'openrouter', id: 'openrouter/free', supportsVision: true },
    { provider: 'openrouter', id: 'meta-llama/llama-3.2-3b-instruct:free', supportsVision: false },
    { provider: 'openrouter', id: 'openai/gpt-oss-20b:free', supportsVision: false },
    { provider: 'openrouter', id: 'nvidia/nemotron-3-nano-30b-a3b:free', supportsVision: false },
    { provider: 'openrouter', id: 'poolside/laguna-xs-2.1:free', supportsVision: false },
    { provider: 'anthropic', id: 'claude-haiku-4-5', supportsVision: true },
    { provider: 'gemini', id: 'gemini-3.5-flash', supportsVision: true },
    { provider: 'openai', id: 'gpt-5.4-mini', supportsVision: true },
    { provider: 'gemini', id: 'gemini-3.1-flash-lite-preview', supportsVision: true },
    { provider: 'openrouter', id: 'anthropic/claude-haiku-4.5', supportsVision: true },
    { provider: 'openrouter', id: 'google/gemini-3.5-flash', supportsVision: true },
  ],
  balanced: [
    { provider: 'openrouter', id: 'meta-llama/llama-3.3-70b-instruct:free', supportsVision: false },
    { provider: 'openrouter', id: 'google/gemma-4-31b-it:free', supportsVision: true },
    { provider: 'openrouter', id: 'qwen/qwen3-next-80b-a3b-instruct:free', supportsVision: false },
    { provider: 'anthropic', id: 'claude-sonnet-5', supportsVision: true },
    { provider: 'openai', id: 'gpt-5.6', supportsVision: true },
    { provider: 'gemini', id: 'gemini-3.1-pro-preview', supportsVision: true },
    { provider: 'openrouter', id: 'anthropic/claude-sonnet-5', supportsVision: true },
    { provider: 'openrouter', id: 'openai/gpt-5.6-sol', supportsVision: true },
    { provider: 'openrouter', id: 'google/gemini-3.1-pro-preview', supportsVision: true },
  ],
  frontier: [
    { provider: 'anthropic', id: 'claude-fable-5', supportsVision: true },
    { provider: 'anthropic', id: 'claude-opus-5', supportsVision: true },
    { provider: 'anthropic', id: 'claude-opus-4-8', supportsVision: true },
    { provider: 'openai', id: 'gpt-5.6-sol', supportsVision: true },
    { provider: 'openrouter', id: 'anthropic/claude-fable-5', supportsVision: true },
    { provider: 'openrouter', id: 'anthropic/claude-opus-5', supportsVision: true },
    { provider: 'openrouter', id: 'anthropic/claude-opus-4.8', supportsVision: true },
    { provider: 'openrouter', id: 'openai/gpt-5.6-sol', supportsVision: true },
    { provider: 'openrouter', id: 'nvidia/nemotron-3-super-120b-a12b:free', supportsVision: false },
    { provider: 'openrouter', id: 'qwen/qwen3-coder:free', supportsVision: false },
    { provider: 'openrouter', id: 'poolside/laguna-m.1:free', supportsVision: false },
  ],
};

/** Hardcoded last-resort when the catalog is empty or unreachable. */
export const AUTO_MODEL_ULTIMATE_FALLBACK: AutoModelPick = {
  provider: 'anthropic',
  modelId: 'claude-sonnet-5',
  tier: 'balanced',
  score: 0,
  reason: 'ultimate-fallback',
};

const CODE_KEYWORD_RE =
  /\b(refactor|debug|implement|fix|test|compile|typescript|javascript|python|rust|golang|sql|stack\s*trace|exception|nullpointer|segfault)\b/i;
const REASONING_KEYWORD_RE =
  /\b(analy[sz]e|architecture|architect|design\s+a|plan\s+(out|the|a)|prove|compare|trade-?off|reason\s+about|multi-?step|strateg(y|ize)|evaluate)\b/i;
const FILE_PATH_RE =
  /(?:^|[\s`'"(])(?:\.?\.?\/|~\/|[A-Za-z]:\\)[\w./\\-]+\.\w{1,8}\b|(?:^|[\s`'"(])[\w.-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|kt|swift|css|html|json|yaml|yml|md|toml|sql)\b/;
const CODE_FENCE_RE = /```/;
const STACK_TRACE_RE = /^\s+at\s+\S+/m;
const MATH_RE = /[$∫∑√∞≈≠≤≥]|\\frac\b|\\sum\b|\btheorem\b|\blemma\b/i;

export function isAutoModelId(model: string | undefined | null): boolean {
  return (model?.trim().toLowerCase() || '') === AUTO_MODEL_ID;
}

export function isAutoModelPreference(value: unknown): value is AutoModelPreference {
  return value === 'eco' || value === 'balanced' || value === 'max';
}

export function normalizeAutoModelPreference(value: unknown): AutoModelPreference {
  return isAutoModelPreference(value) ? value : 'balanced';
}

/**
 * Heuristic complexity score in ~0–100+ range. Higher → harder task.
 */
export function scorePromptComplexity(
  prompt: string,
  context: PromptComplexityContext = {}
): number {
  const text = prompt || '';
  const length = text.length;
  let score = 0;

  if (length >= 2000) score += 30;
  else if (length >= 500) score += 20;
  else if (length >= 100) score += 10;
  else if (length >= 40) score += 4;

  if (CODE_FENCE_RE.test(text)) score += 25;
  if (FILE_PATH_RE.test(text)) score += 15;
  if (STACK_TRACE_RE.test(text)) score += 20;
  if (CODE_KEYWORD_RE.test(text)) score += 15;
  if (REASONING_KEYWORD_RE.test(text)) score += 20;
  if (MATH_RE.test(text)) score += 10;

  const messageCount = context.messageCount ?? 0;
  if (messageCount > 30) score += 20;
  else if (messageCount > 10) score += 10;
  else if (messageCount > 4) score += 4;

  const contextChars = context.contextChars ?? 0;
  if (contextChars > 200_000) score += 25;
  else if (contextChars > 50_000) score += 15;
  else if (contextChars > 10_000) score += 6;

  if (context.hasImages) score += 5;

  return score;
}

function scoreToBaseTier(score: number): AutoModelTier {
  if (score < 35) return 'fast';
  if (score < 70) return 'balanced';
  return 'frontier';
}

function shiftTier(tier: AutoModelTier, delta: number): AutoModelTier {
  const index = TIER_ORDER.indexOf(tier);
  const next = Math.max(0, Math.min(TIER_ORDER.length - 1, index + delta));
  return TIER_ORDER[next];
}

export function tierForScore(score: number, preference: AutoModelPreference): AutoModelTier {
  const base = scoreToBaseTier(score);
  if (preference === 'eco') return shiftTier(base, -1);
  if (preference === 'max') return shiftTier(base, 1);
  return base;
}

/** Preferred tier first, then cheaper (lower) tiers as fallback. */
function tierFallbackChain(preferred: AutoModelTier): AutoModelTier[] {
  const start = TIER_ORDER.indexOf(preferred);
  const chain: AutoModelTier[] = [];
  for (let i = start; i >= 0; i -= 1) {
    chain.push(TIER_ORDER[i]);
  }
  return chain;
}

function catalogKey(provider: string, id: string): string {
  return `${provider}::${id}`;
}

/**
 * Pick the best available model from the enabled backend catalog.
 */
export function pickAutoModel(
  enabledModels: BackendModelInfo[],
  score: number,
  preference: AutoModelPreference = 'balanced',
  options: { requireVision?: boolean } = {}
): AutoModelPick {
  const preferredTier = tierForScore(score, preference);
  const available = new Set(enabledModels.map((m) => catalogKey(m.provider, m.id)));
  const requireVision = Boolean(options.requireVision);

  for (const tier of tierFallbackChain(preferredTier)) {
    for (const candidate of AUTO_MODEL_TIERS[tier]) {
      if (requireVision && !candidate.supportsVision) continue;
      if (!available.has(catalogKey(candidate.provider, candidate.id))) continue;
      return {
        provider: candidate.provider,
        modelId: candidate.id,
        tier,
        score,
        reason:
          tier === preferredTier
            ? `tier=${tier};preference=${preference}`
            : `fallback-from=${preferredTier};tier=${tier};preference=${preference}`,
      };
    }
  }

  // Catalog has models but none matched curated list — use first enabled entry.
  const first = enabledModels[0];
  if (first) {
    return {
      provider: first.provider,
      modelId: first.id,
      tier: preferredTier,
      score,
      reason: `catalog-first;preference=${preference}`,
    };
  }

  return {
    ...AUTO_MODEL_ULTIMATE_FALLBACK,
    score,
    reason: `ultimate-fallback;preference=${preference}`,
  };
}

export const AUTO_PREFERENCE_LABELS: Record<AutoModelPreference, string> = {
  eco: 'Prefer lower cost',
  balanced: 'Balanced',
  max: 'Prefer smartest',
};

export const AUTO_PREFERENCE_SHORT_LABELS: Record<AutoModelPreference, string> = {
  eco: 'Eco',
  balanced: 'Balanced',
  max: 'Max',
};
