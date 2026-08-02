import type { MatterRuntimeConfig } from '../../shared/matter';
import { log } from '../utils/logger';

export interface MatterSchedulerOptions {
  getRuntime: () => MatterRuntimeConfig;
  onTick: (reason: 'interval' | 'startup' | 'manual') => void;
  onMorningBrief: () => void;
  onEndOfDay: () => void;
  now?: () => number;
}

export class MatterScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private minuteTimer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;

  constructor(private readonly options: MatterSchedulerOptions) {
    this.now = options.now || (() => Date.now());
  }

  start(): void {
    this.stop();
    this.armInterval();
    this.minuteTimer = setInterval(() => this.onMinute(), 60 * 1000);
    log('[Matter] Scheduler started');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.minuteTimer) {
      clearInterval(this.minuteTimer);
      this.minuteTimer = null;
    }
  }

  reschedule(): void {
    this.armInterval();
  }

  isInScanWindow(runtime?: MatterRuntimeConfig): boolean {
    const cfg = runtime || this.options.getRuntime();
    const date = new Date(this.now());
    const hour = date.getHours();
    const start = cfg.windowStartHour;
    const end = cfg.windowEndHour;
    if (start === end) return true;
    if (start < end) {
      return hour >= start && hour < end;
    }
    // overnight window
    return hour >= start || hour < end;
  }

  private armInterval(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    const runtime = this.options.getRuntime();
    if (!runtime.enabled) return;
    const ms = Math.max(15, runtime.intervalMinutes) * 60 * 1000;
    this.timer = setInterval(() => {
      if (!this.options.getRuntime().enabled) return;
      if (!this.isInScanWindow()) return;
      this.options.onTick('interval');
    }, ms);
  }

  private onMinute(): void {
    const runtime = this.options.getRuntime();
    if (!runtime.enabled) return;
    const date = new Date(this.now());
    const hour = date.getHours();
    const minute = date.getMinutes();

    // Morning brief ~5 minutes after window start
    if (hour === runtime.windowStartHour && minute === 5) {
      this.options.onMorningBrief();
    }

    // End of day ~15 minutes before window end
    const eodHour = runtime.windowEndHour === 0 ? 23 : runtime.windowEndHour - 1;
    const eodMinute = runtime.windowEndHour === 0 ? 45 : 45;
    if (runtime.endOfDayWrapEnabled && hour === eodHour && minute === eodMinute) {
      this.options.onEndOfDay();
    }
  }
}
