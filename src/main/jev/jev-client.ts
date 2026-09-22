/**
 * Shared TypeSafe Jev (System One) decision client.
 * Calls York backend `/typesafe` (Cognito JWT); proxy injects TYPESAFE_API_KEY.
 * Falls back to null when disabled or unauthenticated — callers keep heuristic/LLM paths.
 */
import {
  TypeSafeClient,
  choice,
  noul,
  score,
  type ChoiceCriteria,
  type EntryType,
  type Questions,
  type ScoreCriteria,
  type SystemOneResult,
} from '@typesafe-ai/sdk';
import { getTypesafeProxyBaseUrl } from '../../shared/backend-config';
import { YORK_APP_VERSION_HEADER } from '../../shared/client-version';
import { JEV_MODEL } from '../../shared/jev';
import { isAuthenticated } from '../auth/session';
import { getClientAppVersion, resolveBackendClientApiKey } from '../config/backend-auth';
import { configStore } from '../config/config-store';
import { log, logWarn } from '../utils/logger';

export { choice, noul, score };
export type { ChoiceCriteria, EntryType, Questions, ScoreCriteria, SystemOneResult };

let cachedClient: TypeSafeClient | null = null;
let cachedKeyFingerprint: string | null = null;

/**
 * @deprecated Client TypeSafe keys are unused — Jev goes through the backend proxy.
 * Kept for tests that stub env; product path uses Cognito + /typesafe.
 */
export function resolveTypesafeApiKey(): string {
  return '';
}

export function isJevEnabled(): boolean {
  const config = configStore.getAll();
  if (config.jevEnabled === false) return false;
  return isAuthenticated();
}

async function getClient(): Promise<TypeSafeClient | null> {
  if (!isJevEnabled()) return null;

  let apiKey: string;
  try {
    apiKey = await resolveBackendClientApiKey({
      provider: 'anthropic',
      apiKey: 'sk-york-ie-local-proxy',
    });
  } catch (error) {
    logWarn('[Jev] Could not resolve Cognito token for proxy:', error);
    return null;
  }
  if (!apiKey) return null;

  const fingerprint = `${apiKey.slice(0, 12)}:${getTypesafeProxyBaseUrl()}`;
  if (cachedClient && cachedKeyFingerprint === fingerprint) {
    return cachedClient;
  }

  cachedClient = new TypeSafeClient({
    apiKey,
    baseURL: getTypesafeProxyBaseUrl(),
    defaultModel: JEV_MODEL,
    timeout: 15_000,
    logLevel: 'warn',
    defaultHeaders: {
      [YORK_APP_VERSION_HEADER]: getClientAppVersion(),
    },
  });
  cachedKeyFingerprint = fingerprint;
  return cachedClient;
}

/** Reset cached client (tests / key rotation). */
export function resetJevClient(): void {
  cachedClient = null;
  cachedKeyFingerprint = null;
}

export type RunJevDecisionOptions = {
  model?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Log label for diagnostics. */
  label?: string;
};

/**
 * Run a System One decision. Returns null when Jev is unavailable or the call fails.
 */
export async function runJevDecision<const Q extends Questions>(
  state: EntryType,
  questions: Q,
  options: RunJevDecisionOptions = {}
): Promise<SystemOneResult<Q> | null> {
  if (!isJevEnabled()) {
    return null;
  }
  const client = await getClient();
  if (!client) {
    return null;
  }

  const label = options.label ?? 'jev';
  try {
    const result = await client.systemOne(
      {
        state,
        questions,
        model: options.model ?? JEV_MODEL,
      },
      {
        signal: options.signal,
        timeout: options.timeoutMs,
      }
    );
    log(
      `[Jev] ${label} ok model=${result.model} in=${result.usage.input_tokens} out=${result.usage.output_tokens}`
    );
    return result;
  } catch (error) {
    logWarn(`[Jev] ${label} failed:`, error);
    return null;
  }
}

/** Convenience: Noul probability or null. */
export async function runJevNoul(
  state: EntryType,
  instructions: string,
  options: RunJevDecisionOptions & { questionId?: string } = {}
): Promise<number | null> {
  const id = options.questionId ?? 'q';
  const result = await runJevDecision(state, { [id]: noul(instructions) }, options);
  const answer = result?.answers[id];
  if (answer && answer.type === 'noul') {
    return answer.noul;
  }
  return null;
}

/** Convenience: Choice label or null. */
export async function runJevChoice<T extends ChoiceCriteria>(
  state: EntryType,
  instructions: string,
  criteria: T,
  options: RunJevDecisionOptions & { questionId?: string } = {}
): Promise<(keyof T & string) | null> {
  const id = options.questionId ?? 'q';
  const result = await runJevDecision(
    state,
    { [id]: choice(instructions, criteria) },
    options
  );
  const answer = result?.answers[id];
  if (answer && answer.type === 'choice') {
    return answer.choice as keyof T & string;
  }
  return null;
}

/** Convenience: Score value + confidence or null. */
export async function runJevScore(
  state: EntryType,
  instructions: string,
  criteria: ScoreCriteria,
  options: RunJevDecisionOptions & { questionId?: string } = {}
): Promise<{ score: number; confidence: number } | null> {
  const id = options.questionId ?? 'q';
  const result = await runJevDecision(
    state,
    { [id]: score(instructions, criteria) },
    options
  );
  const answer = result?.answers[id];
  if (answer && answer.type === 'score') {
    return { score: answer.score, confidence: answer.confidence };
  }
  return null;
}

/** Map a 0–N score rubric onto a 0–100 scale (for legacy callers). */
export function scoreToHundred(rawScore: number, maxLevel: number): number {
  if (maxLevel <= 0) return 0;
  const clamped = Math.max(0, Math.min(maxLevel, rawScore));
  return Math.round((clamped / maxLevel) * 100);
}
