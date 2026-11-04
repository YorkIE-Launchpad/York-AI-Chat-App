/**
 * Haiku cleanup for voice buttons. Runs through the existing backend proxy.
 * Audio never reaches this call. Only the transcript does.
 */
import { BACKEND_PROXY_PLACEHOLDER_KEY, getBackendProxyBaseUrl } from '../../shared/backend-config';
import { VOICE_CLEANUP_MODEL, VOICE_CLEANUP_TIMEOUT_MS } from '../../shared/voice-buttons';
import { runPiAiOneShot } from '../agent/sdk-one-shot';
import { configStore, type AppConfig } from '../config/config-store';

function voiceCleanupConfig(): AppConfig {
  return {
    ...configStore.getAll(),
    provider: 'anthropic',
    customProtocol: 'anthropic',
    baseUrl: getBackendProxyBaseUrl('anthropic'),
    apiKey: BACKEND_PROXY_PLACEHOLDER_KEY,
    model: VOICE_CLEANUP_MODEL,
  };
}

export async function completeVoiceCleanup(system: string, user: string): Promise<string> {
  const result = await runPiAiOneShot(user, system, voiceCleanupConfig(), {
    temperature: 0.2,
    maxTokens: 1200,
    signal: AbortSignal.timeout(VOICE_CLEANUP_TIMEOUT_MS),
    usageFeature: 'voice_dictation',
    usageSessionId: 'voice-dictation',
  });
  return result.text;
}
