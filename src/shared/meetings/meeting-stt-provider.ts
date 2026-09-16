export const MEETING_STT_PROVIDER_ENV = 'YORK_IE_MEETING_STT_PROVIDER';

export type MeetingSttProvider = 'openai' | 'apple';

const VALID_PROVIDERS = new Set<MeetingSttProvider>(['openai', 'apple']);

/**
 * Parse meeting live-STT provider from env. Invalid or missing values default to `openai`.
 */
export function parseMeetingSttProvider(
  raw: string | undefined | null
): MeetingSttProvider {
  const normalized = (raw ?? '').trim().toLowerCase();
  if (VALID_PROVIDERS.has(normalized as MeetingSttProvider)) {
    return normalized as MeetingSttProvider;
  }
  return 'openai';
}

export function resolveMeetingSttProviderFromEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env
): MeetingSttProvider {
  return parseMeetingSttProvider(env[MEETING_STT_PROVIDER_ENV]);
}
