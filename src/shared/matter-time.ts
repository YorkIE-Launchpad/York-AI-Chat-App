/**
 * Pure Matter time helpers — due/remind/expiry defaults, urgency recompute, countdown labels.
 */

import type { MatterOrbit, MatterSeverity, MatterSource } from './matter';

/** Default lead time before dueAt for OS reminder. */
export const MATTER_REMIND_LEAD_MS = 15 * 60 * 1000;

export interface MatterTimeFields {
  dueAt: number | null;
  remindAt: number | null;
  expiresAt: number | null;
}

export interface MatterUrgency {
  orbit: MatterOrbit;
  severity: MatterSeverity;
  /** Additive boost for rankScore (0–40). */
  rankBoost: number;
}

/**
 * Build due/remind/expires from a signal deadline.
 * - remindAt = dueAt − 15m (null if dueAt already in the past)
 * - expiresAt = signal end when provided, else dueAt for time-bound sources
 */
export function deriveMatterTimeFields(options: {
  dueAt?: number | null;
  expiresAt?: number | null;
  /** Reserved for source-specific default policies. */
  source?: MatterSource;
  now?: number;
}): MatterTimeFields {
  const now = options.now ?? Date.now();
  const dueAt =
    typeof options.dueAt === 'number' && Number.isFinite(options.dueAt) ? options.dueAt : null;
  if (dueAt == null) {
    return {
      dueAt: null,
      remindAt: null,
      expiresAt:
        typeof options.expiresAt === 'number' && Number.isFinite(options.expiresAt)
          ? options.expiresAt
          : null,
    };
  }

  void options.source;

  const remindAt = dueAt - MATTER_REMIND_LEAD_MS;
  // Skip scheduling a reminder that is already in the past relative to due.
  const scheduledRemind = remindAt > now && dueAt > now ? remindAt : null;

  let expiresAt =
    typeof options.expiresAt === 'number' && Number.isFinite(options.expiresAt)
      ? options.expiresAt
      : null;
  if (expiresAt == null) {
    // Time-bound action: expire at due when no explicit end is provided.
    expiresAt = dueAt;
  }

  return { dueAt, remindAt: scheduledRemind, expiresAt };
}

/** Orbit / severity / rank boost from minutes until due. */
const ORBIT_INNERNESS: Record<MatterOrbit, number> = {
  now: 0,
  today: 1,
  week: 2,
  watching: 3,
};

/** Inner-most orbit wins so rank/due dates can only pull a blip toward the center. */
export function innerMatterOrbit(a: MatterOrbit, b: MatterOrbit): MatterOrbit {
  return ORBIT_INNERNESS[a] <= ORBIT_INNERNESS[b] ? a : b;
}

/**
 * Map rankScore (0–100) onto radar rings. Higher score → closer to center.
 * Due-date urgency and an optional fallback orbit only pull inward (never outward).
 */
export function orbitFromRankScore(
  rankScore: number,
  options?: {
    dueAt?: number | null;
    pinned?: boolean;
    now?: number;
    fallbackOrbit?: MatterOrbit | null;
  }
): MatterOrbit {
  if (options?.pinned) return 'now';
  const score = Number.isFinite(rankScore) ? rankScore : 0;
  const fromRank: MatterOrbit =
    score >= 75 ? 'now' : score >= 50 ? 'today' : score >= 25 ? 'week' : 'watching';
  let orbit = fromRank;
  const urgency = urgencyFromDueAt(options?.dueAt ?? null, options?.now);
  if (urgency) orbit = innerMatterOrbit(orbit, urgency.orbit);
  if (options?.fallbackOrbit) orbit = innerMatterOrbit(orbit, options.fallbackOrbit);
  return orbit;
}

export function urgencyFromDueAt(dueAt: number | null, now = Date.now()): MatterUrgency | null {
  if (dueAt == null || !Number.isFinite(dueAt)) return null;
  const hoursUntil = (dueAt - now) / 36e5;
  if (hoursUntil < 0) {
    return { orbit: 'now', severity: 'critical', rankBoost: 40 };
  }
  if (hoursUntil <= 1) {
    return { orbit: 'now', severity: 'critical', rankBoost: 40 };
  }
  if (hoursUntil <= 2) {
    return { orbit: 'now', severity: 'warning', rankBoost: 30 };
  }
  if (hoursUntil <= 3) {
    return { orbit: 'today', severity: 'warning', rankBoost: 25 };
  }
  if (hoursUntil <= 6) {
    return { orbit: 'today', severity: 'signal', rankBoost: 15 };
  }
  if (hoursUntil <= 24) {
    return { orbit: 'today', severity: 'signal', rankBoost: 10 };
  }
  if (hoursUntil <= 24 * 7) {
    return { orbit: 'week', severity: 'signal', rankBoost: 5 };
  }
  return { orbit: 'watching', severity: 'signal', rankBoost: 0 };
}

export function shouldFireReminder(
  item: {
    remindAt: number | null;
    reminderNotifiedAt: number | null;
    status: string;
    snoozeUntil?: number | null;
  },
  now = Date.now()
): boolean {
  if (item.status !== 'active' && item.status !== 'resurfaced') return false;
  if (item.snoozeUntil && item.snoozeUntil > now) return false;
  if (item.remindAt == null || item.remindAt > now) return false;
  if (item.reminderNotifiedAt != null) return false;
  return true;
}

export function shouldFireExpiry(
  item: {
    expiresAt: number | null;
    expiredNotifiedAt: number | null;
    status: string;
    snoozeUntil?: number | null;
    pinned?: boolean;
  },
  now = Date.now()
): boolean {
  if (item.status !== 'active' && item.status !== 'resurfaced') return false;
  if (item.pinned) return false;
  if (item.snoozeUntil && item.snoozeUntil > now) return false;
  if (item.expiresAt == null || item.expiresAt > now) return false;
  if (item.expiredNotifiedAt != null) return false;
  return true;
}

/** Compact countdown for UI: "in 45m", "due now", "overdue". */
export function formatDueRelative(dueAt: number, now = Date.now()): string {
  const delta = dueAt - now;
  const abs = Math.abs(delta);
  const mins = Math.round(abs / 60_000);
  if (delta <= 0) {
    if (mins < 1) return 'due now';
    if (mins < 60) return `overdue ${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `overdue ${hours}h`;
    return `overdue ${Math.floor(hours / 24)}d`;
  }
  if (mins < 1) return 'due now';
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `in ${hours}h`;
  return `in ${Math.floor(hours / 24)}d`;
}

export function isDueUrgent(dueAt: number, now = Date.now()): boolean {
  return dueAt - now <= 2 * 36e5;
}
