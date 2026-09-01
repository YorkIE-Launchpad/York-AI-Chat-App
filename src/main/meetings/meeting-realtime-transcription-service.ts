import { createHash } from 'node:crypto';
import { BACKEND_PROXY_PLACEHOLDER_KEY, getBackendProxyBaseUrl } from '../../shared/backend-config';
import {
  REALTIME_TRANSCRIPTION_DELAY_OPTIONS,
  REALTIME_TRANSCRIPTION_PROMPT,
  type RealtimeTranscriptionDelay,
} from '../../shared/meetings/realtime-transcription-events';
import {
  resolveClientOutdatedFromHttpResponse,
  YORK_APP_VERSION_HEADER,
} from '../../shared/client-version';
import { isAuthenticated, ensureAuthenticatedSession } from '../auth/session';
import { getClientAppVersion, resolveBackendClientApiKey } from '../config/backend-auth';
import { log, logWarn } from '../utils/logger';

export interface CreateRealtimeTranscriptionSessionOptions {
  delay?: RealtimeTranscriptionDelay;
}

export interface CreateRealtimeTranscriptionSessionResult {
  clientSecret: string;
}

export interface RealtimeTranscriptionReadiness {
  ready: boolean;
  reason?: string;
}

const PRIMARY_TRANSCRIBE_MODEL = 'gpt-live-transcribe';
const FALLBACK_TRANSCRIBE_MODEL = 'gpt-realtime-whisper';
const DEFAULT_DELAY: RealtimeTranscriptionDelay = 'low';

function resolveSafetyIdentifier(userKey: string | undefined): string {
  const raw = (userKey || 'anonymous').trim() || 'anonymous';
  return createHash('sha256').update(`york-ie-meeting-stt:${raw}`).digest('hex').slice(0, 32);
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

export function resolveRealtimeTranscriptionDelay(
  delay: string | undefined
): RealtimeTranscriptionDelay {
  if (delay && REALTIME_TRANSCRIPTION_DELAY_OPTIONS.includes(delay as RealtimeTranscriptionDelay)) {
    return delay as RealtimeTranscriptionDelay;
  }
  return DEFAULT_DELAY;
}

export function getRealtimeTranscriptionReadiness(): RealtimeTranscriptionReadiness {
  if (!isAuthenticated()) {
    return {
      ready: false,
      reason: 'Sign in to enable meeting transcription through the York backend.',
    };
  }
  return { ready: true };
}

function buildTranscriptionSessionBody(
  model: string,
  delay: RealtimeTranscriptionDelay
): Record<string, unknown> {
  const transcription: Record<string, unknown> = {
    model,
    prompt: REALTIME_TRANSCRIPTION_PROMPT,
    languages: ['en'],
  };
  if (model === PRIMARY_TRANSCRIBE_MODEL) {
    transcription.delay = delay;
  }

  return {
    session: {
      type: 'transcription',
      audio: {
        input: {
          transcription,
          noise_reduction: { type: 'far_field' },
          turn_detection: { type: 'server_vad' },
        },
      },
    },
  };
}

async function mintClientSecret(
  apiKey: string,
  safetyUserKey: string,
  body: Record<string, unknown>
): Promise<{ ok: true; clientSecret: string } | { ok: false; status: number; message: string }> {
  const baseUrl = getBackendProxyBaseUrl('openai');
  const url = `${baseUrl}/realtime/client_secrets`;

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
      body: JSON.stringify(body),
    });
  } catch (error) {
    logWarn('[Meetings] Failed to reach backend for realtime transcription session', error);
    return {
      ok: false,
      status: 0,
      message: 'Could not start live transcription. Check your connection and try again.',
    };
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
    const outdatedMessage = resolveClientOutdatedFromHttpResponse(
      response.status,
      payload,
      rawText
    );
    if (outdatedMessage) {
      return { ok: false, status: response.status, message: outdatedMessage };
    }
    const message =
      payload &&
      typeof payload === 'object' &&
      typeof (payload as { error?: { message?: string } }).error?.message === 'string'
        ? (payload as { error: { message: string } }).error.message
        : rawText || `HTTP ${response.status}`;
    return { ok: false, status: response.status, message };
  }

  const clientSecret = extractClientSecret(payload);
  if (!clientSecret) {
    return {
      ok: false,
      status: response.status,
      message: 'Realtime session response did not include a client secret.',
    };
  }

  return { ok: true, clientSecret };
}

/**
 * Mint a short-lived OpenAI Realtime transcription client secret via the York
 * Cognito → `/openai` HTTP proxy. The renderer uses the secret for WebRTC only.
 */
export async function createRealtimeTranscriptionSession(
  options: CreateRealtimeTranscriptionSessionOptions = {}
): Promise<CreateRealtimeTranscriptionSessionResult> {
  const readiness = getRealtimeTranscriptionReadiness();
  if (!readiness.ready) {
    throw new Error(readiness.reason || 'Transcription is not configured');
  }

  const delay = resolveRealtimeTranscriptionDelay(options.delay);
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

  log(`[Meetings] Minting realtime transcription session (delay=${delay})`);

  const primary = await mintClientSecret(
    apiKey,
    safetyUserKey,
    buildTranscriptionSessionBody(PRIMARY_TRANSCRIBE_MODEL, delay)
  );
  if (primary.ok) {
    return { clientSecret: primary.clientSecret };
  }

  logWarn('[Meetings] Primary realtime transcription model failed, trying fallback', {
    model: PRIMARY_TRANSCRIBE_MODEL,
    status: primary.status,
    message: primary.message,
  });

  const fallback = await mintClientSecret(
    apiKey,
    safetyUserKey,
    buildTranscriptionSessionBody(FALLBACK_TRANSCRIBE_MODEL, delay)
  );
  if (fallback.ok) {
    return { clientSecret: fallback.clientSecret };
  }

  logWarn('[Meetings] Realtime transcription session mint failed', {
    status: fallback.status,
    message: fallback.message,
  });
  throw new Error(fallback.message || 'Could not start live transcription.');
}
