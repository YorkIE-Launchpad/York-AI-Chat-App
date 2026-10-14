import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { findForbiddenEnvKeys } = require('../../scripts/stage-env-prod.js');

describe('stage-env-prod findForbiddenEnvKeys', () => {
  it('flags credential-looking keys that have values', () => {
    const text = [
      'HUB_API_URL=https://hub.example',
      'SLACK_CLIENT_ID=123.456',
      'SLACK_CLIENT_SECRET=abc',
      'YORK_LLM_API_KEY="k"',
      'export GOOGLE_CONNECTOR_CLIENT_SECRET=xyz',
    ].join('\n');
    expect(findForbiddenEnvKeys(text)).toEqual([
      'SLACK_CLIENT_SECRET',
      'YORK_LLM_API_KEY',
      'GOOGLE_CONNECTOR_CLIENT_SECRET',
    ]);
  });

  it('ignores comments and empty secret placeholders', () => {
    const text = ['# SLACK_CLIENT_SECRET=abc', 'ZOOM_CONNECTOR_CLIENT_SECRET=', 'X=1'].join('\n');
    expect(findForbiddenEnvKeys(text)).toEqual([]);
  });
});
