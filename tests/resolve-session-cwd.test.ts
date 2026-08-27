import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  isUnusableSessionCwd,
  resolveWritableSessionCwd,
} from '../src/main/session/resolve-session-cwd';

describe('resolveWritableSessionCwd', () => {
  it('rejects filesystem roots that cause /.tmp', () => {
    expect(isUnusableSessionCwd('/')).toBe(true);
    expect(isUnusableSessionCwd('')).toBe(true);
    expect(isUnusableSessionCwd('   ')).toBe(true);
    expect(isUnusableSessionCwd('/Users/demo/project')).toBe(false);
  });

  it('skips / and empty candidates so attachments never stage under /.tmp', () => {
    const resolved = resolveWritableSessionCwd(['/', '', null, undefined, '/tmp/york-safe']);
    expect(resolved).toBe(path.resolve('/tmp/york-safe'));
    expect(resolved).not.toBe('/');
    expect(path.join(resolved, '.tmp')).not.toBe('/.tmp');
  });

  it('falls back to os.tmpdir when every candidate is unusable', () => {
    const resolved = resolveWritableSessionCwd(['/', '', null]);
    expect(resolved).toBe(os.tmpdir());
  });
});
