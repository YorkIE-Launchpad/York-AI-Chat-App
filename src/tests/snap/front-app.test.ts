import { describe, expect, it, vi } from 'vitest';
import {
  activateTarget,
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
      return calls.length > 1 ? malicious : '';
    });
    await expect(activateTarget(malicious, run, 200)).resolves.toBe(true);

    const activateCall = calls[0];
    const scriptLines = activateCall.filter((_, i) => activateCall[i - 1] === '-e');
    expect(scriptLines.join('\n')).not.toContain(malicious);
    expect(activateCall[activateCall.length - 1]).toBe(malicious);
  });

  it('resolves true once the target becomes frontmost', async () => {
    const run = vi
      .fn<(args: string[]) => Promise<string>>()
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('com.other\n')
      .mockResolvedValueOnce('com.apple.Notes\n');
    await expect(activateTarget('com.apple.Notes', run, 1000)).resolves.toBe(true);
  });

  it('resolves false when activation fails', async () => {
    const run = vi.fn(async () => {
      throw new Error('app not found');
    });
    await expect(activateTarget('com.gone', run, 50)).resolves.toBe(false);
  });
});
