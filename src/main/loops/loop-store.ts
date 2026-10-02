/**
 * Loop store — persistent user-owned commitments in SQLite.
 */
import { v4 as uuidv4 } from 'uuid';
import type { DatabaseInstance } from '../db/database';
import type {
  Loop,
  LoopOrigin,
  LoopOwner,
  LoopPriority,
  LoopResearchSource,
  LoopResearchStatus,
  LoopSourceRef,
  LoopStatus,
  LoopUpdateInput,
} from '../../shared/loops';

export interface LoopRow {
  id: string;
  fingerprint: string;
  title: string;
  notes: string | null;
  research_note: string | null;
  research_sources: string | null;
  research_status: string | null;
  research_error: string | null;
  researched_at: number | null;
  origin: string;
  source_ref: string;
  owner: string;
  counterpart: string | null;
  due_at: number | null;
  priority: string;
  status: string;
  auto_captured: number;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
}

export interface LoopUpsertInput {
  fingerprint: string;
  title: string;
  notes?: string | null;
  origin: LoopOrigin;
  sourceRef?: LoopSourceRef;
  owner?: LoopOwner;
  counterpart?: string | null;
  dueAt?: number | null;
  priority?: LoopPriority;
  autoCaptured: boolean;
}

function parseSourceRef(raw: string | null | undefined): LoopSourceRef {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const ref = parsed as Record<string, unknown>;
    const pick = (key: string) => (typeof ref[key] === 'string' ? (ref[key] as string) : null);
    return {
      meetingId: pick('meetingId'),
      matterItemId: pick('matterItemId'),
      url: pick('url'),
      label: pick('label'),
    };
  } catch {
    return {};
  }
}

function parseResearchSources(raw: string | null | undefined): LoopResearchSource[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const rec = entry as Record<string, unknown>;
      if (typeof rec.id !== 'string' || typeof rec.title !== 'string') return [];
      return [
        {
          id: rec.id,
          source: typeof rec.source === 'string' ? rec.source : 'unknown',
          title: rec.title,
          url: typeof rec.url === 'string' ? rec.url : null,
        },
      ];
    });
  } catch {
    return [];
  }
}

function normalizeResearchStatus(raw: string | null | undefined): LoopResearchStatus {
  return raw === 'running' || raw === 'done' || raw === 'error' ? raw : 'idle';
}

export function mapLoopRow(row: LoopRow): Loop {
  return {
    id: row.id,
    fingerprint: row.fingerprint,
    title: row.title,
    notes: row.notes,
    researchNote: row.research_note ?? null,
    researchSources: parseResearchSources(row.research_sources),
    researchStatus: normalizeResearchStatus(row.research_status),
    researchError: row.research_error ?? null,
    researchedAt: row.researched_at ?? null,
    origin: row.origin as LoopOrigin,
    sourceRef: parseSourceRef(row.source_ref),
    owner: row.owner === 'other' ? 'other' : 'me',
    counterpart: row.counterpart,
    dueAt: row.due_at,
    priority: row.priority === 'high' || row.priority === 'low' ? row.priority : 'normal',
    status: row.status as LoopStatus,
    autoCaptured: row.auto_captured === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
  };
}

const CLOSED_LIST_LIMIT = 200;

export class LoopStore {
  constructor(private readonly db: DatabaseInstance) {}

  get(id: string): Loop | null {
    const row = this.db.prepare('SELECT * FROM loops WHERE id = ?').get(id) as LoopRow | undefined;
    return row ? mapLoopRow(row) : null;
  }

  getByFingerprint(fingerprint: string): Loop | null {
    const row = this.db.prepare('SELECT * FROM loops WHERE fingerprint = ?').get(fingerprint) as
      | LoopRow
      | undefined;
    return row ? mapLoopRow(row) : null;
  }

  /** Open loops plus the most recently closed ones. */
  list(): Loop[] {
    const open = this.db
      .prepare(
        `SELECT * FROM loops WHERE status = 'open'
         ORDER BY due_at IS NULL, due_at ASC, created_at DESC`
      )
      .all() as LoopRow[];
    const closed = this.db
      .prepare(
        `SELECT * FROM loops WHERE status != 'open'
         ORDER BY closed_at DESC LIMIT ?`
      )
      .all(CLOSED_LIST_LIMIT) as LoopRow[];
    return [...open, ...closed].map(mapLoopRow);
  }

  /** Fingerprints of every loop (any status) among the candidates. */
  knownFingerprints(fingerprints: string[]): Set<string> {
    if (fingerprints.length === 0) return new Set();
    const placeholders = fingerprints.map(() => '?').join(', ');
    const rows = this.db
      .prepare(`SELECT fingerprint FROM loops WHERE fingerprint IN (${placeholders})`)
      .all(...fingerprints) as Array<{ fingerprint: string }>;
    return new Set(rows.map((r) => r.fingerprint));
  }

  /**
   * Insert a new loop, or refresh an existing open one. Closed, dismissed, or ignored
   * loops are never reopened, and user edits to title/owner/due are never overwritten by capture.
   */
  upsertByFingerprint(input: LoopUpsertInput): { loop: Loop; created: boolean } {
    const existing = this.getByFingerprint(input.fingerprint);
    const now = Date.now();
    if (existing) {
      if (
        existing.status === 'open' &&
        !existing.sourceRef.matterItemId &&
        input.sourceRef?.matterItemId
      ) {
        this.db
          .prepare('UPDATE loops SET source_ref = ?, updated_at = ? WHERE id = ?')
          .run(JSON.stringify({ ...existing.sourceRef, ...input.sourceRef }), now, existing.id);
        return { loop: this.get(existing.id)!, created: false };
      }
      return { loop: existing, created: false };
    }
    const id = uuidv4();
    this.db
      .prepare(
        `INSERT INTO loops
         (id, fingerprint, title, notes, origin, source_ref, owner, counterpart, due_at,
          priority, status, auto_captured, created_at, updated_at, closed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, NULL)`
      )
      .run(
        id,
        input.fingerprint,
        input.title.trim().slice(0, 500),
        input.notes ?? null,
        input.origin,
        JSON.stringify(input.sourceRef || {}),
        input.owner || 'me',
        input.counterpart ?? null,
        input.dueAt ?? null,
        input.priority || 'normal',
        input.autoCaptured ? 1 : 0,
        now,
        now
      );
    return { loop: this.get(id)!, created: true };
  }

  update(id: string, updates: LoopUpdateInput): Loop | null {
    const columns: Record<string, unknown> = {};
    if (updates.title !== undefined) columns.title = updates.title.trim().slice(0, 500);
    if (updates.notes !== undefined) columns.notes = updates.notes;
    if (updates.owner !== undefined) columns.owner = updates.owner;
    if (updates.counterpart !== undefined) columns.counterpart = updates.counterpart;
    if (updates.dueAt !== undefined) columns.due_at = updates.dueAt;
    if (updates.priority !== undefined) columns.priority = updates.priority;
    if (updates.status !== undefined) {
      columns.status = updates.status;
      columns.closed_at = updates.status === 'open' ? null : Date.now();
    }
    const keys = Object.keys(columns);
    if (keys.length > 0) {
      const sets = [...keys.map((k) => `${k} = ?`), 'updated_at = ?'].join(', ');
      this.db
        .prepare(`UPDATE loops SET ${sets} WHERE id = ?`)
        .run(...keys.map((k) => columns[k]), Date.now(), id);
    }
    return this.get(id);
  }

  setResearch(
    id: string,
    research: {
      status: LoopResearchStatus;
      note?: string | null;
      sources?: LoopResearchSource[];
      error?: string | null;
    }
  ): Loop | null {
    const now = Date.now();
    if (research.status === 'running') {
      this.db
        .prepare(
          `UPDATE loops SET research_status = 'running', research_error = NULL, updated_at = ?
           WHERE id = ?`
        )
        .run(now, id);
    } else if (research.status === 'error') {
      this.db
        .prepare(
          `UPDATE loops SET research_status = 'error', research_error = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(research.error ?? 'Research failed', now, id);
    } else {
      this.db
        .prepare(
          `UPDATE loops SET research_status = ?, research_note = ?, research_sources = ?,
             research_error = NULL, researched_at = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(
          research.status,
          research.note ?? null,
          JSON.stringify(research.sources || []),
          now,
          now,
          id
        );
    }
    return this.get(id);
  }

  /** Research jobs interrupted by an app quit should not look stuck forever. */
  resetStaleResearch(): void {
    this.db
      .prepare(
        `UPDATE loops SET research_status = CASE WHEN research_note IS NULL THEN 'idle' ELSE 'done' END
         WHERE research_status = 'running'`
      )
      .run();
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM loops WHERE id = ?').run(id);
  }
}
