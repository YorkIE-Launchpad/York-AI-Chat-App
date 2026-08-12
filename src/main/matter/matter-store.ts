import { v4 as uuidv4 } from 'uuid';
import type {
  DatabaseInstance,
  MatterActionRow,
  MatterItemRow,
  MatterScanRow,
} from '../db/database';
import type {
  MatterActionType,
  MatterItem,
  MatterItemStatus,
  MatterMuteRule,
  MatterScan,
  MatterSourceRef,
} from '../../shared/matter';
import { MATTER_DEFAULT_SNOOZE_MS } from '../../shared/matter';

/**
 * Status when re-upserting a ranked signal onto an existing row.
 * Done never auto-resurfaces; dismissed may resurface when scan content changed.
 */
export function nextMatterUpsertStatus(input: {
  existingStatus: MatterItemStatus;
  incomingStatus?: MatterItemStatus | null;
  snoozeUntil: number | null;
  now?: number;
}): MatterItemStatus {
  const now = input.now ?? Date.now();
  const stillSnoozed =
    input.existingStatus === 'snoozed' &&
    (input.snoozeUntil ? input.snoozeUntil > now : true);
  if (stillSnoozed) return 'snoozed';
  if (input.existingStatus === 'done') return 'done';
  if (input.existingStatus === 'dismissed' && input.incomingStatus !== 'dismissed') {
    return 'resurfaced';
  }
  return input.incomingStatus || 'active';
}

function parseJsonObject(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function parseStringArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export function mapMatterItemRow(row: MatterItemRow): MatterItem {
  const ref = parseJsonObject(row.source_ref) as MatterSourceRef;
  return {
    id: row.id,
    fingerprint: row.fingerprint,
    title: row.title,
    summary: row.summary,
    whyItMatters: row.why_it_matters,
    rawDetails: row.raw_details ?? null,
    severity: row.severity as MatterItem['severity'],
    orbit: row.orbit as MatterItem['orbit'],
    category: row.category as MatterItem['category'],
    source: row.source as MatterItem['source'],
    sourceRef: {
      connectorId: typeof ref.connectorId === 'string' ? ref.connectorId : null,
      toolName: typeof ref.toolName === 'string' ? ref.toolName : null,
      externalId: typeof ref.externalId === 'string' ? ref.externalId : null,
      url: typeof ref.url === 'string' ? ref.url : null,
      label: typeof ref.label === 'string' ? ref.label : null,
    },
    confidence: row.confidence,
    suggestedAction: row.suggested_action,
    status: row.status as MatterItemStatus,
    pinned: row.pinned === 1,
    snoozeUntil: row.snooze_until,
    dueAt: row.due_at ?? null,
    remindAt: row.remind_at ?? null,
    expiresAt: row.expires_at,
    reminderNotifiedAt: row.reminder_notified_at ?? null,
    expiredNotifiedAt: row.expired_notified_at ?? null,
    rankScore: row.rank_score,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSeenAt: row.last_seen_at,
    resolvedAt: row.resolved_at,
  };
}

export function mapMatterScanRow(row: MatterScanRow): MatterScan {
  return {
    id: row.id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
    status: row.status as MatterScan['status'],
    sourcesChecked: parseStringArray(row.sources_checked),
    sourcesSkipped: parseStringArray(row.sources_skipped),
    itemCount: row.item_count,
    criticalCount: row.critical_count,
    warningCount: row.warning_count,
    error: row.error,
    brief: row.brief,
  };
}

export interface MatterStore {
  listVisibleItems: (now?: number) => MatterItem[];
  listActiveItems: () => MatterItem[];
  getItem: (id: string) => MatterItem | null;
  getByFingerprint: (fingerprint: string) => MatterItem | null;
  upsertRankedItems: (
    items: Array<
      Omit<
        MatterItem,
        | 'id'
        | 'createdAt'
        | 'updatedAt'
        | 'lastSeenAt'
        | 'resolvedAt'
        | 'status'
        | 'pinned'
        | 'snoozeUntil'
        | 'reminderNotifiedAt'
        | 'expiredNotifiedAt'
      > & {
        status?: MatterItemStatus;
        pinned?: boolean;
        snoozeUntil?: number | null;
      }
    >
  ) => MatterItem[];
  /** Mark active items not in keepFingerprints as expired (keeps pinned/snoozed). */
  expireAbsentItems: (keepFingerprints: string[], now?: number) => number;
  /** Persist temporal expiry for items whose expiresAt has passed (no OS notify). */
  expireTimedItems: (now?: number) => MatterItem[];
  updateItem: (id: string, updates: Partial<MatterItem>) => MatterItem | null;
  recordAction: (input: {
    itemId?: string | null;
    fingerprint?: string | null;
    action: MatterActionType;
    muteKey?: string | null;
    meta?: Record<string, unknown> | null;
  }) => void;
  listMuteRules: () => MatterMuteRule[];
  isMuted: (candidates: string[]) => boolean;
  startScan: () => MatterScan;
  finishScan: (
    id: string,
    updates: Partial<
      Pick<
        MatterScan,
        | 'status'
        | 'sourcesChecked'
        | 'sourcesSkipped'
        | 'itemCount'
        | 'criticalCount'
        | 'warningCount'
        | 'error'
        | 'brief'
      >
    >
  ) => MatterScan | null;
  getLatestScan: () => MatterScan | null;
  countClearedToday: (now?: number) => number;
}

function loadMuteRules(db: DatabaseInstance): MatterMuteRule[] {
  const seen = new Set<string>();
  const rules: MatterMuteRule[] = [];
  const recent = db.matterActions.listRecent(500);
  for (const row of db.matterActions.listMuteRules()) {
    if (!row.mute_key || seen.has(row.mute_key)) continue;
    const laterUnmute = recent.find(
      (r) => r.action === 'unmute' && r.mute_key === row.mute_key && r.created_at > row.created_at
    );
    if (laterUnmute) continue;
    seen.add(row.mute_key);
    const meta = parseJsonObject(row.meta);
    rules.push({
      key: row.mute_key,
      kind:
        meta.kind === 'sender' ||
        meta.kind === 'project' ||
        meta.kind === 'category' ||
        meta.kind === 'thread' ||
        meta.kind === 'fingerprint'
          ? meta.kind
          : 'fingerprint',
      label: typeof meta.label === 'string' ? meta.label : row.mute_key,
      createdAt: row.created_at,
    });
  }
  return rules;
}

export function createMatterStore(db: DatabaseInstance): MatterStore {
  return {
    listVisibleItems: (now = Date.now()) => {
      return db.matterItems
        .listActive()
        .map(mapMatterItemRow)
        .filter((item) => {
          if (item.status === 'snoozed' && item.snoozeUntil && item.snoozeUntil > now) {
            return false;
          }
          // Hide past deadline; processTimeEvents transitions status + notifies.
          if (item.expiresAt && item.expiresAt <= now) {
            return false;
          }
          return (
            item.status === 'active' || item.status === 'resurfaced' || item.status === 'snoozed'
          );
        })
        .map((item) => {
          if (item.status !== 'snoozed') return item;
          // Legacy / incomplete rows: snooze status without a deadline — re-seed duration
          // instead of immediately reactivating (that made the queue feel "stuck").
          if (!item.snoozeUntil) {
            const until = now + MATTER_DEFAULT_SNOOZE_MS;
            db.matterItems.update(item.id, { status: 'snoozed', snooze_until: until });
            return { ...item, status: 'snoozed' as const, snoozeUntil: until };
          }
          if (item.snoozeUntil <= now) {
            db.matterItems.update(item.id, { status: 'active', snooze_until: null });
            return { ...item, status: 'active' as const, snoozeUntil: null };
          }
          return item;
        })
        .filter((item) => {
          if (item.status === 'snoozed') return false;
          return item.status === 'active' || item.status === 'resurfaced';
        })
        .sort((a, b) => {
          if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
          return b.rankScore - a.rankScore;
        });
    },

    listActiveItems: () => db.matterItems.listActive().map(mapMatterItemRow),

    getItem: (id) => {
      const row = db.matterItems.get(id);
      return row ? mapMatterItemRow(row) : null;
    },

    getByFingerprint: (fingerprint) => {
      const row = db.matterItems.getByFingerprint(fingerprint);
      return row ? mapMatterItemRow(row) : null;
    },

    upsertRankedItems: (items) => {
      const now = Date.now();
      const result: MatterItem[] = [];
      for (const incoming of items) {
        const existing = db.matterItems.getByFingerprint(incoming.fingerprint);
        if (existing) {
          const stillSnoozed =
            existing.status === 'snoozed' &&
            (existing.snooze_until ? existing.snooze_until > now : true);
          // If snooze_until is missing but status is snoozed, keep hidden and re-seed deadline.
          const repairedSnoozeUntil =
            stillSnoozed && !existing.snooze_until
              ? now + MATTER_DEFAULT_SNOOZE_MS
              : existing.snooze_until;
          const nextStatus = nextMatterUpsertStatus({
            existingStatus: existing.status as MatterItemStatus,
            incomingStatus: incoming.status,
            snoozeUntil: existing.snooze_until,
            now,
          });

          const dueChanged = (existing.due_at ?? null) !== (incoming.dueAt ?? null);
          const remindChanged = (existing.remind_at ?? null) !== (incoming.remindAt ?? null);
          const expiresChanged = (existing.expires_at ?? null) !== (incoming.expiresAt ?? null);

          db.matterItems.update(existing.id, {
            title: incoming.title,
            summary: incoming.summary,
            why_it_matters: incoming.whyItMatters,
            raw_details: incoming.rawDetails,
            severity: incoming.severity,
            orbit: incoming.pinned || existing.pinned === 1 ? 'now' : incoming.orbit,
            category: incoming.category,
            source: incoming.source,
            source_ref: JSON.stringify(incoming.sourceRef || {}),
            confidence: incoming.confidence,
            suggested_action: incoming.suggestedAction,
            status: nextStatus,
            due_at: incoming.dueAt ?? null,
            remind_at: incoming.remindAt ?? null,
            expires_at: incoming.expiresAt,
            // Reset notification stamps when schedule changes so rescheduled items remount.
            ...(dueChanged || remindChanged ? { reminder_notified_at: null } : {}),
            ...(dueChanged || expiresChanged ? { expired_notified_at: null } : {}),
            rank_score: incoming.rankScore,
            last_seen_at: now,
            // Keep / repair snooze window while still snoozed
            ...(stillSnoozed ? { snooze_until: repairedSnoozeUntil } : {}),
            resolved_at:
              nextStatus === 'active' || nextStatus === 'resurfaced' ? null : existing.resolved_at,
          });
          const updated = db.matterItems.get(existing.id);
          if (updated) result.push(mapMatterItemRow(updated));
        } else {
          const row: MatterItemRow = {
            id: uuidv4(),
            fingerprint: incoming.fingerprint,
            title: incoming.title,
            summary: incoming.summary,
            why_it_matters: incoming.whyItMatters,
            raw_details: incoming.rawDetails,
            severity: incoming.severity,
            orbit: incoming.orbit,
            category: incoming.category,
            source: incoming.source,
            source_ref: JSON.stringify(incoming.sourceRef || {}),
            confidence: incoming.confidence,
            suggested_action: incoming.suggestedAction,
            status: incoming.status || 'active',
            pinned: incoming.pinned ? 1 : 0,
            snooze_until: incoming.snoozeUntil ?? null,
            due_at: incoming.dueAt ?? null,
            remind_at: incoming.remindAt ?? null,
            expires_at: incoming.expiresAt,
            reminder_notified_at: null,
            expired_notified_at: null,
            rank_score: incoming.rankScore,
            created_at: now,
            updated_at: now,
            last_seen_at: now,
            resolved_at: null,
          };
          db.matterItems.create(row);
          result.push(mapMatterItemRow(row));
        }
      }
      return result;
    },

    expireAbsentItems: (keepFingerprints, now = Date.now()) => {
      const keep = new Set(keepFingerprints);
      let expired = 0;
      for (const row of db.matterItems.listActive()) {
        if (row.pinned === 1) continue;
        if (row.status === 'snoozed' && row.snooze_until && row.snooze_until > now) continue;
        if (keep.has(row.fingerprint)) continue;
        if (row.status !== 'active' && row.status !== 'resurfaced') continue;
        db.matterItems.update(row.id, {
          status: 'expired',
          resolved_at: now,
          expires_at: now,
        });
        expired += 1;
      }
      return expired;
    },

    expireTimedItems: (now = Date.now()) => {
      const expired: MatterItem[] = [];
      for (const row of db.matterItems.listActive()) {
        const item = mapMatterItemRow(row);
        if (item.pinned) continue;
        if (item.status === 'snoozed' && item.snoozeUntil && item.snoozeUntil > now) continue;
        if (item.status !== 'active' && item.status !== 'resurfaced') continue;
        if (item.expiresAt == null || item.expiresAt > now) continue;
        db.matterItems.update(item.id, {
          status: 'expired',
          resolved_at: now,
        });
        const updated = db.matterItems.get(item.id);
        if (updated) expired.push(mapMatterItemRow(updated));
      }
      return expired;
    },

    updateItem: (id, updates) => {
      const mapped: Partial<MatterItemRow> = {};
      if (updates.title !== undefined) mapped.title = updates.title;
      if (updates.summary !== undefined) mapped.summary = updates.summary;
      if (updates.whyItMatters !== undefined) mapped.why_it_matters = updates.whyItMatters;
      if (updates.rawDetails !== undefined) mapped.raw_details = updates.rawDetails;
      if (updates.severity !== undefined) mapped.severity = updates.severity;
      if (updates.orbit !== undefined) mapped.orbit = updates.orbit;
      if (updates.category !== undefined) mapped.category = updates.category;
      if (updates.source !== undefined) mapped.source = updates.source;
      if (updates.sourceRef !== undefined) mapped.source_ref = JSON.stringify(updates.sourceRef);
      if (updates.confidence !== undefined) mapped.confidence = updates.confidence;
      if (updates.suggestedAction !== undefined) mapped.suggested_action = updates.suggestedAction;
      if (updates.status !== undefined) mapped.status = updates.status;
      if (updates.pinned !== undefined) mapped.pinned = updates.pinned ? 1 : 0;
      if (updates.snoozeUntil !== undefined) mapped.snooze_until = updates.snoozeUntil;
      if (updates.dueAt !== undefined) mapped.due_at = updates.dueAt;
      if (updates.remindAt !== undefined) mapped.remind_at = updates.remindAt;
      if (updates.expiresAt !== undefined) mapped.expires_at = updates.expiresAt;
      if (updates.reminderNotifiedAt !== undefined) {
        mapped.reminder_notified_at = updates.reminderNotifiedAt;
      }
      if (updates.expiredNotifiedAt !== undefined) {
        mapped.expired_notified_at = updates.expiredNotifiedAt;
      }
      if (updates.rankScore !== undefined) mapped.rank_score = updates.rankScore;
      if (updates.lastSeenAt !== undefined) mapped.last_seen_at = updates.lastSeenAt;
      if (updates.resolvedAt !== undefined) mapped.resolved_at = updates.resolvedAt;
      db.matterItems.update(id, mapped);
      const row = db.matterItems.get(id);
      return row ? mapMatterItemRow(row) : null;
    },

    recordAction: (input) => {
      const row: MatterActionRow = {
        id: uuidv4(),
        item_id: input.itemId ?? null,
        fingerprint: input.fingerprint ?? null,
        action: input.action,
        mute_key: input.muteKey ?? null,
        meta: input.meta ? JSON.stringify(input.meta) : null,
        created_at: Date.now(),
      };
      db.matterActions.create(row);
    },

    listMuteRules: () => loadMuteRules(db),

    isMuted: (candidates) => {
      const muted = new Set(loadMuteRules(db).map((r) => r.key));
      return candidates.some((c) => muted.has(c));
    },

    startScan: () => {
      const now = Date.now();
      const row: MatterScanRow = {
        id: uuidv4(),
        started_at: now,
        finished_at: null,
        duration_ms: null,
        status: 'running',
        sources_checked: '[]',
        sources_skipped: '[]',
        item_count: 0,
        critical_count: 0,
        warning_count: 0,
        error: null,
        brief: null,
      };
      db.matterScans.create(row);
      return mapMatterScanRow(row);
    },

    finishScan: (id, updates) => {
      const existing = db.matterScans.get(id);
      if (!existing) return null;
      const finishedAt = Date.now();
      db.matterScans.update(id, {
        finished_at: finishedAt,
        duration_ms: finishedAt - existing.started_at,
        status: updates.status ?? 'success',
        sources_checked: updates.sourcesChecked
          ? JSON.stringify(updates.sourcesChecked)
          : existing.sources_checked,
        sources_skipped: updates.sourcesSkipped
          ? JSON.stringify(updates.sourcesSkipped)
          : existing.sources_skipped,
        item_count: updates.itemCount ?? existing.item_count,
        critical_count: updates.criticalCount ?? existing.critical_count,
        warning_count: updates.warningCount ?? existing.warning_count,
        error: updates.error !== undefined ? updates.error : existing.error,
        brief: updates.brief !== undefined ? updates.brief : existing.brief,
      });
      const row = db.matterScans.get(id);
      return row ? mapMatterScanRow(row) : null;
    },

    getLatestScan: () => {
      const row = db.matterScans.getLatest();
      return row ? mapMatterScanRow(row) : null;
    },

    countClearedToday: (now = Date.now()) => {
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      const startMs = start.getTime();
      return db.matterItems
        .listAll(500)
        .filter(
          (row) =>
            (row.status === 'done' || row.status === 'dismissed') &&
            row.resolved_at !== null &&
            row.resolved_at >= startMs
        ).length;
    },
  };
}
