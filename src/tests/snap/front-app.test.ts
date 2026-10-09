import { describe, expect, it, vi } from 'vitest';

vi.mock('../../main/utils/logger', () => ({
  log: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import {
  activateTarget,
  ensureFieldFocused,
  getFrontmostTarget,
  parseFrontmostOutput,
} from '../../main/snap/front-app';

describe('parseFrontmostOutput', () => {
  it('parses app info with window bounds', () => {
    expect(
      parseFrontmostOutput('com.google.Chrome\tGoogle Chrome\t4242\t10\t25\t1200\t800\n', 1)
    ).toEqual({
      bundleId: 'com.google.Chrome',
      name: 'Google Chrome',
      pid: 4242,
      bounds: { x: 10, y: 25, width: 1200, height: 800 },
    });
  });

  it('parses app info without bounds (no Accessibility / no window)', () => {
    expect(parseFrontmostOutput('com.apple.Notes\tNotes\t99', 1)).toEqual({
      bundleId: 'com.apple.Notes',
      name: 'Notes',
      pid: 99,
    });
  });

  it('returns null when GrowthOS itself is frontmost', () => {
    expect(parseFrontmostOutput('ie.york.app\tYork GrowthOS\t555\t0\t0\t100\t100', 555)).toBeNull();
  });

  it('returns null for unusable output', () => {
    expect(parseFrontmostOutput('', 1)).toBeNull();
    expect(parseFrontmostOutput('missing value\tFoo\t12', 1)).toBeNull();
  });

  it('drops zero-sized bounds', () => {
    expect(parseFrontmostOutput('a.b\tA\t3\t0\t0\t0\t0', 1)?.bounds).toBeUndefined();
  });

  it('parses the focused text field frame', () => {
    expect(
      parseFrontmostOutput('com.google.Chrome\tChrome\t9\t0\t25\t1200\t800\t300\t410\t500\t36', 1)
    ).toMatchObject({
      bounds: { x: 0, y: 25, width: 1200, height: 800 },
      focusedField: { x: 300, y: 410, width: 500, height: 36 },
    });
  });

  it('handles empty window or field columns', () => {
    const target = parseFrontmostOutput('a.b\tA\t3\t\t\t\t\t5\t6\t70\t20', 1);
    expect(target?.bounds).toBeUndefined();
    expect(target?.focusedField).toEqual({ x: 5, y: 6, width: 70, height: 20 });
    expect(parseFrontmostOutput('a.b\tA\t3\t1\t2\t3\t4\t\t\t\t', 1)?.focusedField).toBeUndefined();
  });
});

describe('ensureFieldFocused', () => {
  const field = { x: 100, y: 200, width: 400, height: 30 };
  const isClick = (args: string[]) => args.some((arg) => arg.includes('click at'));

  it('does not click when a text field already has focus', async () => {
    const run = vi.fn(async (_args: string[]) => 'editable');
    await expect(ensureFieldFocused(field, run, { restoreMs: 0 })).resolves.toBe(true);
    expect(run.mock.calls.some(([args]) => isClick(args))).toBe(false);
  });

  it('trusts the paste when AX cannot tell (no click)', async () => {
    const run = vi.fn(async (_args: string[]) => 'unknown');
    await expect(ensureFieldFocused(field, run, { restoreMs: 0 })).resolves.toBe(true);
    expect(run.mock.calls.some(([args]) => isClick(args))).toBe(false);
  });

  it('clicks where the field was (coords via argv) when focus was lost', async () => {
    let clicked = false;
    const run = vi.fn(async (args: string[]) => {
      if (isClick(args)) {
        clicked = true;
        return '';
      }
      return clicked ? 'editable' : 'other';
    });
    await expect(ensureFieldFocused(field, run, { restoreMs: 0, afterClickMs: 200 })).resolves.toBe(
      true
    );
    const clickCall = run.mock.calls.find(([args]) => isClick(args))?.[0] ?? [];
    expect(clickCall.slice(-2)).toEqual(['300', '215']);
  });

  it('reports failure when no field is focused even after clicking', async () => {
    const run = vi.fn(async (args: string[]) => (isClick(args) ? '' : 'other'));
    await expect(ensureFieldFocused(field, run, { restoreMs: 0, afterClickMs: 100 })).resolves.toBe(
      false
    );
  });
});

describe('getFrontmostTarget', () => {
  it('returns null when osascript fails', async () => {
    const run = vi.fn(async () => {
      throw new Error('not allowed');
    });
    await expect(getFrontmostTarget(run, 1)).resolves.toBeNull();
  });
});

describe('activateTarget', () => {
  it('passes the bundle id via argv, never inside the script text', async () => {
    const malicious = 'x"; tell application "Finder" to quit; "';
    const calls: string[][] = [];
    const run = vi.fn(async (args: string[]) => {
      calls.push(args);
      return calls.length > 1 ? 'focused' : '';
    });
    await expect(activateTarget(malicious, run, 200, 0)).resolves.toBe(true);

    for (const call of calls) {
      const scriptLines = call.filter((_, i) => call[i - 1] === '-e');
      expect(scriptLines.join('\n')).not.toContain(malicious);
      expect(call[call.length - 1]).toBe(malicious);
    }
  });

  it('waits until the target window is focused, not just frontmost', async () => {
    const run = vi
      .fn<(args: string[]) => Promise<string>>()
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('back\n')
      .mockResolvedValueOnce('front\n')
      .mockResolvedValueOnce('focused\n');
    await expect(activateTarget('com.google.Chrome', run, 1000, 0)).resolves.toBe(true);
    expect(run).toHaveBeenCalledTimes(4);
  });

  it('still pastes when the app is frontmost but never reports a focused window', async () => {
    const run = vi.fn(async () => 'front');
    await expect(activateTarget('com.apple.finder', run, 150, 0)).resolves.toBe(true);
  });

  it('resolves false when the target never comes to the front', async () => {
    const run = vi.fn(async () => 'back');
    await expect(activateTarget('com.google.Chrome', run, 150, 0)).resolves.toBe(false);
  });

  it('resolves false when activation fails', async () => {
    const run = vi.fn(async () => {
      throw new Error('app not found');
    });
    await expect(activateTarget('com.gone', run, 50)).resolves.toBe(false);
  });
});
