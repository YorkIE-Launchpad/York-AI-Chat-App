import type { BashSpawnContext } from '@mariozechner/pi-coding-agent';

/** App credentials loaded into `process.env` that agent-run commands must never see. */
const APP_SECRET_ENV_KEYS = new Set([
  'YORK_LLM_API_KEY',
  'SLACK_CLIENT_SECRET',
  'GOOGLE_CONNECTOR_CLIENT_SECRET',
  'GOOGLE_CLIENT_SECRET',
  'ZOOM_CONNECTOR_CLIENT_SECRET',
  'ZM_RTMS_SECRET',
]);

const APP_SECRET_ENV_PATTERN = /CLIENT_SECRET$/;

export function isAppSecretEnvKey(key: string): boolean {
  return APP_SECRET_ENV_KEYS.has(key) || APP_SECRET_ENV_PATTERN.test(key);
}

/** Copy of `env` without app credentials. */
export function stripAppSecretsFromEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (!isAppSecretEnvKey(key)) out[key] = value;
  }
  return out;
}

export function agentShellSpawnHook(context: BashSpawnContext): BashSpawnContext {
  return { ...context, env: stripAppSecretsFromEnv(context.env) };
}
