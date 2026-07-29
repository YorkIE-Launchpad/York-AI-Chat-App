import { describe, expect, it, vi } from 'vitest';
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { checkWatchCondition } from '../../main/schedule/watch-checks';

describe('checkWatchCondition', () => {
  it('detects file changes via hash', async () => {
    const path = join(tmpdir(), `york-watch-${Date.now()}.txt`);
    writeFileSync(path, 'v1');
    const first = await checkWatchCondition(
      {
        checkType: 'file',
        compareMode: 'hash',
        checkConfig: { path },
      },
      tmpdir()
    );
    expect(first.changed).toBe(true);

    const second = await checkWatchCondition(
      {
        checkType: 'file',
        compareMode: 'hash',
        checkConfig: { path },
        lastState: first.state,
      },
      tmpdir()
    );
    expect(second.changed).toBe(false);

    writeFileSync(path, 'v2');
    const third = await checkWatchCondition(
      {
        checkType: 'file',
        compareMode: 'hash',
        checkConfig: { path },
        lastState: first.state,
      },
      tmpdir()
    );
    expect(third.changed).toBe(true);
    unlinkSync(path);
  });

  it('runs command checks', async () => {
    const result = await checkWatchCondition(
      {
        checkType: 'command',
        compareMode: 'hash',
        checkConfig: { command: 'echo hello' },
      },
      tmpdir()
    );
    expect(result.state).toContain('cmd:0:');
    expect(result.changed).toBe(true);
  });

  it('supports agent checks', async () => {
    const runAgentCheck = vi.fn().mockResolvedValue({ changed: true, summary: 'PR merged' });
    const result = await checkWatchCondition(
      {
        checkType: 'agent',
        compareMode: 'hash',
        checkConfig: { checkPrompt: 'is PR merged?' },
      },
      tmpdir(),
      { runAgentCheck }
    );
    expect(runAgentCheck).toHaveBeenCalled();
    expect(result.changed).toBe(true);
    expect(result.summary).toBe('PR merged');
  });
});
