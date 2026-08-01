import { createHash } from 'node:crypto';
import { BACKEND_PROXY_PLACEHOLDER_KEY, getBackendProxyBaseUrl } from '../../shared/backend-config';
import { isAuthenticated, ensureAuthenticatedSession } from '../auth/session';
import { resolveBackendClientApiKey } from '../config/backend-auth';
import { log, logWarn } from '../utils/logger';

export interface CreateRealtimeTranslationSessionOptions {
  targetLanguage?: string;
}

export interface CreateRealtimeTranslationSessionResult {
  clientSecret: string;
}

const DEFAULT_TARGET_LANGUAGE = 'en';
const REALTIME_TRANSLATE_MODEL = 'gpt-realtime-translate';

function resolveSafetyIdentifier(userKey: string | undefined): string {
  const raw = (userKey || 'anonymous').trim() || 'anonymous';
  return createHash('sha256').update(`york-ie-dictation:${raw}`).digest('hex').slice(0, 32);
}

function extractClientSecret(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const record = payload as Record<string, unknown>;
  if (typeof record.value === 'string' && record.value.trim()) {
    return record.value.trim();
  }
  const nested = record.client_secret;
  if (nested && typeof nested === 'object') {
    const value = (nested as Record<string, unknown>).value;
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

/**
 * Mint a short-lived OpenAI Realtime Translation client secret via the York
 * Cognito → `/openai` HTTP proxy. The renderer uses the secret for WebRTC only.
 */
export async function createRealtimeTranslationSession(
  options: CreateRealtimeTranslationSessionOptions = {}
): Promise<CreateRealtimeTranslationSessionResult> {
  if (!isAuthenticated()) {
    throw new Error('Sign in to enable live speech-to-text through the York backend.');
  }

  const targetLanguage =
    (options.targetLanguage || DEFAULT_TARGET_LANGUAGE).trim() || DEFAULT_TARGET_LANGUAGE;
  const baseUrl = getBackendProxyBaseUrl('openai');
  const apiKey = await resolveBackendClientApiKey({
    provider: 'openai',
    apiKey: BACKEND_PROXY_PLACEHOLDER_KEY,
  });

  let safetyUserKey = 'anonymous';
  try {
    const session = await ensureAuthenticatedSession();
    safetyUserKey = String(session.user?.id || session.user?.email || 'authenticated');
  } catch {
    // Still mint with anonymous safety id if session details are unavailable.
  }

  const url = `${baseUrl}/realtime/translations/client_secrets`;
  log(`[Dictation] Minting realtime translation session (${targetLanguage})`);

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'OpenAI-Safety-Identifier': resolveSafetyIdentifier(safetyUserKey),
      },
      body: JSON.stringify({
        session: {
          model: REALTIME_TRANSLATE_MODEL,
          audio: {
            output: { language: targetLanguage },
          },
        },
      }),
    });
  } catch (error) {
    logWarn('[Dictation] Failed to reach backend for realtime session', error);
    throw new Error('Could not start live speech-to-text. Check your connection and try again.');
  }

  const rawText = await response.text();
  let payload: unknown = null;
  if (rawText) {
    try {
      payload = JSON.parse(rawText) as unknown;
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const message =
      payload &&
      typeof payload === 'object' &&
      typeof (payload as { error?: { message?: string } }).error?.message === 'string'
        ? (payload as { error: { message: string } }).error.message
        : rawText || `HTTP ${response.status}`;
    logWarn('[Dictation] Realtime session mint failed', { status: response.status, message });
    throw new Error(message || 'Could not start live speech-to-text.');
  }

  const clientSecret = extractClientSecret(payload);
  if (!clientSecret) {
    throw new Error('Realtime session response did not include a client secret.');
  }

  return { clientSecret };
}
