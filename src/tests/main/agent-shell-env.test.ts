import { describe, expect, it } from 'vitest';
import { agentShellSpawnHook, stripAppSecretsFromEnv } from '../../main/utils/agent-shell-env';

describe('agent shell env', () => {
  it('removes app credentials but keeps everything else', () => {
    const env = stripAppSecretsFromEnv({
      PATH: '/usr/bin',
      HOME: '/Users/me',
      OPENAI_API_KEY: 'user-own-key',
      YORK_LLM_API_KEY: 'llama',
      SLACK_CLIENT_SECRET: 's',
      GOOGLE_CONNECTOR_CLIENT_SECRET: 'g',
      ZOOM_CONNECTOR_CLIENT_SECRET: 'z',
      VITE_SLACK_CLIENT_SECRET: 'v',
      SLACK_CLIENT_ID: 'public-id',
    });
    expect(env).toEqual({
      PATH: '/usr/bin',
      HOME: '/Users/me',
      OPENAI_API_KEY: 'user-own-key',
      SLACK_CLIENT_ID: 'public-id',
    });
  });

  it('spawn hook preserves command and cwd', () => {
    const result = agentShellSpawnHook({
      command: 'env',
      cwd: '/tmp',
      env: { YORK_LLM_API_KEY: 'x', PATH: '/bin' },
    });
    expect(result).toEqual({ command: 'env', cwd: '/tmp', env: { PATH: '/bin' } });
  });
});
