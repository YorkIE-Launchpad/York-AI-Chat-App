import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  APP_DATA_ENV_VAR,
  APP_DATA_NAME_VAR,
  BASE_APP_DATA_NAME,
  resolveAppDataDir,
  resolveAppDataEnv,
  resolveAppDataName,
} from '../../shared/app-data-env';

describe('app-data-env', () => {
  it('defaults to packaged york-ie when no env signals are set', () => {
    const env = {};
    expect(resolveAppDataEnv(env)).toBe('default');
    expect(resolveAppDataName(env)).toBe(BASE_APP_DATA_NAME);
  });

  it('uses YORK_IE_APP_DATA_ENV when set', () => {
    const env = { [APP_DATA_ENV_VAR]: 'dev' };
    expect(resolveAppDataEnv(env)).toBe('dev');
    expect(resolveAppDataName(env)).toBe('york-ie-dev');
  });

  it('treats explicit default as packaged name', () => {
    const env = { [APP_DATA_ENV_VAR]: 'default' };
    expect(resolveAppDataEnv(env)).toBe('default');
    expect(resolveAppDataName(env)).toBe(BASE_APP_DATA_NAME);
  });

  it('infers dev from VITE_DEV_SERVER_URL when env var is unset', () => {
    const env = { VITE_DEV_SERVER_URL: 'http://localhost:5173' };
    expect(resolveAppDataEnv(env)).toBe('dev');
    expect(resolveAppDataName(env)).toBe('york-ie-dev');
  });

  it('prefers YORK_IE_APP_DATA_ENV over VITE_DEV_SERVER_URL', () => {
    const env = {
      [APP_DATA_ENV_VAR]: 'local',
      VITE_DEV_SERVER_URL: 'http://localhost:5173',
    };
    expect(resolveAppDataEnv(env)).toBe('local');
    expect(resolveAppDataName(env)).toBe('york-ie-local');
  });

  it('prefers YORK_IE_APP_DATA_NAME when already resolved', () => {
    const env = {
      [APP_DATA_ENV_VAR]: 'dev',
      [APP_DATA_NAME_VAR]: 'york-ie-custom',
    };
    expect(resolveAppDataName(env)).toBe('york-ie-custom');
  });

  it('sanitizes unsafe env suffixes', () => {
    const env = { [APP_DATA_ENV_VAR]: 'my env/../x' };
    expect(resolveAppDataEnv(env)).toBe('my-env----x');
    expect(resolveAppDataName(env)).toBe('york-ie-my-env----x');
  });

  it('resolves platform directories', () => {
    const env = { [APP_DATA_ENV_VAR]: 'dev' };
    expect(resolveAppDataDir({ platform: 'darwin', home: '/Users/demo', env })).toBe(
      path.join('/Users/demo', 'Library', 'Application Support', 'york-ie-dev')
    );

    expect(
      resolveAppDataDir({
        platform: 'win32',
        home: 'C:\\Users\\demo',
        env: { ...env, APPDATA: 'C:\\Users\\demo\\AppData\\Roaming' },
      })
    ).toBe(path.join('C:\\Users\\demo\\AppData\\Roaming', 'york-ie-dev'));

    expect(resolveAppDataDir({ platform: 'linux', home: '/home/demo', env })).toBe(
      path.join('/home/demo', '.config', 'york-ie-dev')
    );
  });
});
