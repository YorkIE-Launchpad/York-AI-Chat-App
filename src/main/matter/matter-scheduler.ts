import type { MatterRuntimeConfig } from '../../shared/matter';
import { log } from '../utils/logger';

/** Retry a failed scan sooner than the normal cadence. */
export const MATTER_SCAN_ERROR_RETRY_MS = 15 * 60 * 1000;
/** Morning brief may still fire this long after window start (e.g. laptop opened late). */
const MORNING_BRIEF_CATCH_UP_MINUTES = 3 * 60;
const TICK_MS = 60 * 1000;

export interface MatterScanState {
  /** Wall-clock start of the last scan attempt (manual or scheduled). */
  lastAttemptAt: number | null;
  lastAttemptFailed: boolean;
  /** True while a scan is running or the startup scan is still pending. */
  busy: boolean;
}

export interface MatterSchedulerOptions {
  getRuntime: () => MatterRuntimeConfig;
  getScanState: () => MatterScanState;
  /** Wall-clock time of the last calendar meetings refresh. */
  getMeetingsLastFetchAt?: () => number | null;
  onTick: (reason: 'interval' | 'startup' | 'manual') => void;
  /** Dedicated calendar meetings list refresh (separate from signal scans). */
  onMeetingsTick?: (reason: 'interval' | 'startup' | 'manual') => void;
  /** Return false to defer (e.g. a scan is still running); retried on the next tick. */
  onMorningBrief: () => boolean | void;
  onEndOfDay: () => void;
  /** Fired every minute while Matter is enabled (reminders / expiry). */
  onTimeTick?: () => void;
  now?: () => number;
}

function localDayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/**
 * Wall-clock scheduler. Every minute it compares "now" against the last scan / fetch
 * time instead of relying on long setIntervals, which pause while macOS sleeps and
 * restart whenever settings change — both made scans drift far off schedule.
 */
export class MatterScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private morningBriefDay: string | null = null;
  private endOfDayDay: string | null = null;
  private readonly now: () => number;

  constructor(private readonly options: MatterSchedulerOptions) {
    this.now = options.now || (() => Date.now());
  }

  start(): void {
    this.stop();
    this.timer = setInterval(() => this.tick(), TICK_MS);
    log('[Matter] Scheduler started');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Settings are read live on every tick; re-check right away so changes apply now. */
  reschedule(): void {
    if (this.timer) this.tick();
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

  isScanDue(runtime?: MatterRuntimeConfig): boolean {
    const cfg = runtime || this.options.getRuntime();
    if (!cfg.enabled || !this.isInScanWindow(cfg)) return false;
    const state = this.options.getScanState();
    if (state.busy) return false;
    if (state.lastAttemptAt == null) return true;
    const intervalMs = Math.max(15, cfg.intervalMinutes) * 60 * 1000;
    const waitMs = state.lastAttemptFailed
      ? Math.min(intervalMs, MATTER_SCAN_ERROR_RETRY_MS)
      : intervalMs;
    return this.now() - state.lastAttemptAt >= waitMs;
  }

  isMeetingsFetchDue(runtime?: MatterRuntimeConfig): boolean {
    const cfg = runtime || this.options.getRuntime();
    if (!cfg.enabled || !cfg.sources.calendar || !this.options.onMeetingsTick) return false;
    if (!this.isInScanWindow(cfg)) return false;
    const last = this.options.getMeetingsLastFetchAt?.() ?? null;
    if (last == null) return true;
    const minutes = Math.max(5, cfg.meetingsIntervalMinutes || 15);
    return this.now() - last >= minutes * 60 * 1000;
  }

  private tick(): void {
    const runtime = this.options.getRuntime();
    if (!runtime.enabled) return;

    // Time-sensitive deadlines run regardless of scan window.
    this.options.onTimeTick?.();

    if (this.isScanDue(runtime)) {
      this.options.onTick('interval');
    }
    if (this.isMeetingsFetchDue(runtime)) {
      this.options.onMeetingsTick?.('interval');
    }
    this.maybeDailyEvents(runtime);
  }

  private maybeDailyEvents(runtime: MatterRuntimeConfig): void {
    const nowMs = this.now();
    const date = new Date(nowMs);
    const day = localDayKey(nowMs);
    const minuteOfDay = date.getHours() * 60 + date.getMinutes();
    const startMinute = runtime.windowStartHour * 60;
    const endMinute = (runtime.windowEndHour === 0 ? 24 : runtime.windowEndHour) * 60;

    // Morning brief ~5 minutes after window start; catch up if the Mac was asleep / app closed.
    const sinceStart = (minuteOfDay - startMinute + 24 * 60) % (24 * 60);
    if (
      this.morningBriefDay !== day &&
      sinceStart >= 5 &&
      sinceStart <= MORNING_BRIEF_CATCH_UP_MINUTES
    ) {
      if (this.options.onMorningBrief() !== false) this.morningBriefDay = day;
    }

    // End of day ~15 minutes before window end, until the window closes.
    const eodMinute = endMinute - 15;
    if (
      runtime.endOfDayWrapEnabled &&
      this.endOfDayDay !== day &&
      minuteOfDay >= eodMinute &&
      minuteOfDay < endMinute
    ) {
      this.endOfDayDay = day;
      this.options.onEndOfDay();
    }
  }
}
