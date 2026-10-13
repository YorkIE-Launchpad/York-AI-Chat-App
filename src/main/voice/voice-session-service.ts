import { createHash } from 'node:crypto';
import { BACKEND_PROXY_PLACEHOLDER_KEY, getBackendProxyBaseUrl } from '../../shared/backend-config';
import {
  resolveClientOutdatedFromHttpResponse,
  YORK_APP_VERSION_HEADER,
} from '../../shared/client-version';
import {
  VOICE_REALTIME_MODEL_DEFAULT,
  VOICE_SYSTEM_PROMPT,
  VOICE_TOOLS,
  type VoiceSessionCredentials,
} from '../../shared/voice-control';
import { isAuthenticated, ensureAuthenticatedSession } from '../auth/session';
import { getClientAppVersion, resolveBackendClientApiKey } from '../config/backend-auth';
import { log, logWarn } from '../utils/logger';

export const VOICE_REALTIME_MODEL_ENV = 'YORK_VOICE_REALTIME_MODEL';

export function resolveVoiceRealtimeModel(env: NodeJS.ProcessEnv = process.env): string {
  return env[VOICE_REALTIME_MODEL_ENV]?.trim() || VOICE_REALTIME_MODEL_DEFAULT;
}

function resolveSafetyIdentifier(userKey: string): string {
  const raw = userKey.trim() || 'anonymous';
  return createHash('sha256').update(`york-ie-voice:${raw}`).digest('hex').slice(0, 32);
}

function extractClientSecret(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  if (typeof record.value === 'string' && record.value.trim()) return record.value.trim();
  const nested = record.client_secret;
  if (nested && typeof nested === 'object') {
    const value = (nested as Record<string, unknown>).value;
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

export function buildVoiceSessionBody(model: string): Record<string, unknown> {
  return {
    session: {
      type: 'realtime',
      model,
      instructions: VOICE_SYSTEM_PROMPT,
      output_modalities: ['audio'],
      audio: {
        input: {
          noise_reduction: { type: 'near_field' },
          transcription: { model: 'gpt-4o-mini-transcribe', language: 'en' },
          turn_detection: {
            type: 'semantic_vad',
            eagerness: 'medium',
            create_response: true,
            interrupt_response: true,
          },
        },
        output: { voice: 'marin' },
      },
      tools: VOICE_TOOLS,
      tool_choice: 'auto',
    },
  };
}

/**
 * Mint a short-lived Realtime client secret for a voice-control session via the
 * York Cognito → `/openai` proxy. The renderer uses it for WebRTC only.
 */
export async function createVoiceSession(): Promise<VoiceSessionCredentials> {
  if (!isAuthenticated()) {
    throw new Error('Sign in to York GrowthOS to use voice control.');
  }

  const model = resolveVoiceRealtimeModel();
  const apiKey = await resolveBackendClientApiKey({
    provider: 'openai',
    apiKey: BACKEND_PROXY_PLACEHOLDER_KEY,
  });

  let safetyUserKey = 'anonymous';
  try {
    const session = await ensureAuthenticatedSession();
    safetyUserKey = String(session.user?.id || session.user?.email || 'authenticated');
  } catch {
    // Still mint with an anonymous safety id if session details are unavailable.
  }

  const url = `${getBackendProxyBaseUrl('openai')}/realtime/client_secrets`;
  log(`[Voice] Minting realtime session (model=${model})`);

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'OpenAI-Safety-Identifier': resolveSafetyIdentifier(safetyUserKey),
        [YORK_APP_VERSION_HEADER]: getClientAppVersion(),
      },
      body: JSON.stringify(buildVoiceSessionBody(model)),
    });
  } catch (error) {
    logWarn('[Voice] Failed to reach backend for realtime session', error);
    throw new Error('Could not start voice control. Check your connection and try again.');
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
    const outdated = resolveClientOutdatedFromHttpResponse(response.status, payload, rawText);
    if (outdated) throw new Error(outdated);
    const message =
      typeof (payload as { error?: { message?: unknown } } | null)?.error?.message === 'string'
        ? (payload as { error: { message: string } }).error.message
        : rawText || `HTTP ${response.status}`;
    logWarn('[Voice] Realtime session mint failed', { status: response.status, model, message });
    throw new Error(message);
  }

  const clientSecret = extractClientSecret(payload);
  if (!clientSecret) {
    throw new Error('Realtime session response did not include a client secret.');
  }
  return { clientSecret, model };
}
