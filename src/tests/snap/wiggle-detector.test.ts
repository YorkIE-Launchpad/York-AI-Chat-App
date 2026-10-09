import { describe, expect, it, vi } from 'vitest';
import { WiggleDetector, WiggleTracker } from '../../main/snap/wiggle-detector';

/** Feed a horizontal back-and-forth path; returns how many times the tracker fired. */
function shake(
  tracker: WiggleTracker,
  {
    strokes,
    amplitude,
    strokeMs,
    stepMs = 16,
    startAt = 0,
    dy = 0,
  }: {
    strokes: number;
    amplitude: number;
    strokeMs: number;
    stepMs?: number;
    startAt?: number;
    dy?: number;
  }
): { fired: number; end: number } {
  let t = startAt;
  let x = 500;
  let y = 400;
  let fired = 0;
  tracker.push(x, y, t);
  const steps = Math.max(1, Math.round(strokeMs / stepMs));
  for (let s = 0; s < strokes; s++) {
    const dir = s % 2 === 0 ? 1 : -1;
    for (let i = 0; i < steps; i++) {
      t += stepMs;
      x += (dir * amplitude) / steps;
      y += dy;
      if (tracker.push(x, y, t)) fired++;
    }
  }
  return { fired, end: t };
}

describe('WiggleTracker', () => {
  it('fires on a quick left-right shake', () => {
    const { fired } = shake(new WiggleTracker(), { strokes: 6, amplitude: 120, strokeMs: 80 });
    expect(fired).toBe(1);
  });

  it('ignores slow side-to-side movement', () => {
    const { fired } = shake(new WiggleTracker(), { strokes: 8, amplitude: 300, strokeMs: 600 });
    expect(fired).toBe(0);
  });

  it('ignores tiny jitters', () => {
    const { fired } = shake(new WiggleTracker(), { strokes: 12, amplitude: 10, strokeMs: 48 });
    expect(fired).toBe(0);
  });

  it('ignores mostly vertical shaking', () => {
    const { fired } = shake(new WiggleTracker(), {
      strokes: 8,
      amplitude: 60,
      strokeMs: 80,
      dy: 40,
    });
    expect(fired).toBe(0);
  });

  it('needs several reversals, not a single back-and-forth', () => {
    const { fired } = shake(new WiggleTracker(), { strokes: 3, amplitude: 150, strokeMs: 80 });
    expect(fired).toBe(0);
  });

  it('respects the cooldown, then fires again', () => {
    const tracker = new WiggleTracker({ cooldownMs: 1000 });
    const first = shake(tracker, { strokes: 12, amplitude: 120, strokeMs: 80 });
    expect(first.fired).toBe(1);
    const second = shake(tracker, {
      strokes: 6,
      amplitude: 120,
      strokeMs: 80,
      startAt: first.end + 1500,
    });
    expect(second.fired).toBe(1);
  });
});

describe('WiggleDetector', () => {
  it('polls the cursor and stops cleanly', () => {
    vi.useFakeTimers();
    const getCursor = vi.fn(() => ({ x: 0, y: 0 }));
    const detector = new WiggleDetector({ getCursor, onWiggle: vi.fn(), intervalMs: 10 });
    detector.start();
    vi.advanceTimersByTime(55);
    expect(getCursor).toHaveBeenCalledTimes(5);
    detector.stop();
    vi.advanceTimersByTime(100);
    expect(getCursor).toHaveBeenCalledTimes(5);
    expect(detector.running).toBe(false);
    vi.useRealTimers();
  });
});
