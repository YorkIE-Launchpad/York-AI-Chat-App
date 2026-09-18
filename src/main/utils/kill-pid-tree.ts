import { execFileSync } from 'child_process';

/**
 * Depth-first descendant PIDs of `rootPid` (includes root).
 * `listChildren` is injected so tests don't spawn processes.
 */
export function collectDescendantPids(
  rootPid: number,
  listChildren: (pid: number) => number[]
): number[] {
  const seen = new Set<number>();
  const walk = (pid: number): void => {
    if (!Number.isFinite(pid) || pid <= 1 || seen.has(pid)) return;
    seen.add(pid);
    for (const child of listChildren(pid)) {
      walk(child);
    }
  };
  walk(rootPid);
  return [...seen];
}

export function listChildPids(pid: number): number[] {
  try {
    const out = execFileSync('pgrep', ['-P', String(pid)], {
      encoding: 'utf8',
      timeout: 2000,
    }).trim();
    if (!out) return [];
    return out
      .split(/\s+/)
      .map((part) => parseInt(part, 10))
      .filter((child) => Number.isFinite(child) && child > 1);
  } catch {
    return [];
  }
}

/** SIGKILL a pid and every descendant. Never kills `skipPid` (usually the Electron main process). */
export function killPidTree(pid: number, skipPid: number = process.pid): void {
  const targets = collectDescendantPids(pid, listChildPids);
  for (const target of targets) {
    if (target === skipPid) continue;
    try {
      process.kill(target, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}
