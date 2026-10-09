/**
 * "Wiggle to snap": detects a quick left-right shake of the mouse pointer by
 * polling the cursor position (no extra macOS permission needed).
 */

export interface WiggleOptions {
  /** Shortest horizontal stroke (px) that counts toward a wiggle. */
  minStrokePx?: number;
  /** A stroke slower than this is ordinary movement, not shaking. */
  maxStrokeMs?: number;
  /** Direction changes needed inside `windowMs` (4 ≈ two full shakes). */
  reversals?: number;
  windowMs?: number;
  /** Ignore further wiggles for this long after firing. */
  cooldownMs?: number;
}

const DEFAULTS: Required<WiggleOptions> = {
  minStrokePx: 40,
  maxStrokeMs: 220,
  reversals: 4,
  windowMs: 900,
  cooldownMs: 2500,
};

/** Pure stroke/reversal tracker; feed it cursor samples, it says when a wiggle happened. */
export class WiggleTracker {
  private readonly opts: Required<WiggleOptions>;
  private lastX: number | null = null;
  private lastY = 0;
  private direction = 0;
  private strokePx = 0;
  private strokeStart = 0;
  private reversalTimes: number[] = [];
  private cooldownUntil = 0;

  constructor(options: WiggleOptions = {}) {
    this.opts = { ...DEFAULTS, ...options };
  }

  push(x: number, y: number, now: number): boolean {
    if (this.lastX === null) {
      this.lastX = x;
      this.lastY = y;
      this.strokeStart = now;
      return false;
    }
    const dx = x - this.lastX;
    const dy = y - this.lastY;
    this.lastX = x;
    this.lastY = y;
    if (dx === 0) return false;
    // Mostly vertical movement is not a shake.
    if (Math.abs(dy) > Math.abs(dx) * 1.5) {
      this.resetStrokes(now);
      return false;
    }

    const sign = Math.sign(dx);
    if (sign === this.direction) {
      this.strokePx += Math.abs(dx);
      return false;
    }

    const completedStroke =
      this.direction !== 0 &&
      this.strokePx >= this.opts.minStrokePx &&
      now - this.strokeStart <= this.opts.maxStrokeMs;
    this.direction = sign;
    this.strokePx = Math.abs(dx);
    this.strokeStart = now;
    if (!completedStroke) {
      this.reversalTimes = [];
      return false;
    }

    this.reversalTimes = this.reversalTimes.filter((t) => now - t <= this.opts.windowMs);
    this.reversalTimes.push(now);
    if (this.reversalTimes.length < this.opts.reversals || now < this.cooldownUntil) return false;

    this.reversalTimes = [];
    this.cooldownUntil = now + this.opts.cooldownMs;
    return true;
  }

  private resetStrokes(now: number): void {
    this.direction = 0;
    this.strokePx = 0;
    this.strokeStart = now;
    this.reversalTimes = [];
  }
}

export interface WiggleDetectorDeps {
  getCursor: () => { x: number; y: number };
  onWiggle: () => void;
  intervalMs?: number;
  now?: () => number;
  options?: WiggleOptions;
}

/** Polls the cursor while running and calls `onWiggle` on a quick shake. */
export class WiggleDetector {
  private timer: ReturnType<typeof setInterval> | null = null;
  private tracker: WiggleTracker;

  constructor(private readonly deps: WiggleDetectorDeps) {
    this.tracker = new WiggleTracker(deps.options);
  }

  get running(): boolean {
    return this.timer !== null;
  }

  start(): void {
    if (this.timer) return;
    this.tracker = new WiggleTracker(this.deps.options);
    const now = this.deps.now ?? Date.now;
    this.timer = setInterval(() => {
      const { x, y } = this.deps.getCursor();
      if (this.tracker.push(x, y, now())) this.deps.onWiggle();
    }, this.deps.intervalMs ?? 16);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}
