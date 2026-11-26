/**
 * SQLite access for brainstorm boards.
 */
import { v4 as uuidv4 } from 'uuid';
import type { DatabaseInstance } from '../db/database';
import {
  emptyProfileSnapshot,
  isBrainstormPhase,
  isBrainstormTechnique,
  summaryFromDetail,
  type BrainstormBrief,
  type BrainstormDetail,
  type BrainstormIdea,
  type BrainstormIdeaAuthor,
  type BrainstormIdeaDraft,
  type BrainstormIdeaPatch,
  type BrainstormPhase,
  type BrainstormProfileSnapshot,
  type BrainstormSignal,
  type BrainstormActivity,
  type BrainstormActivityKind,
  type BrainstormActor,
  type BrainstormSource,
  type BrainstormStatus,
  type BrainstormSummary,
  type BrainstormTechnique,
} from '../../shared/brainstorm-types';

interface BrainstormRow {
  id: string;
  session_id: string;
  topic: string;
  goal: string | null;
  technique: string;
  profile_snapshot: string;
  signals: string;
  phase: string;
  status: string;
  brief: string | null;
  room_id?: string | null;
  role?: string | null;
  created_at: number;
  updated_at: number;
}

interface IdeaRow {
  id: string;
  brainstorm_id: string;
  cluster: string | null;
  title: string;
  body: string;
  rationale: string | null;
  tags: string;
  impact: number | null;
  effort: number | null;
  starred: number;
  status: string;
  sources: string;
  author: string;
  author_email?: string | null;
  author_name?: string | null;
  position: number;
  created_at: number;
  updated_at: number;
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function clampScore(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(1, Math.min(5, Math.round(n)));
}

function asStringList(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, max);
}

export function normalizeSources(value: unknown): BrainstormSource[] {
  if (!Array.isArray(value)) return [];
  const sources: BrainstormSource[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const rec = entry as Record<string, unknown>;
    const title = typeof rec.title === 'string' ? rec.title.trim() : '';
    const url = typeof rec.url === 'string' ? rec.url.trim() : '';
    if (!title && !url) continue;
    sources.push({ title: title || url, url: url || null });
    if (sources.length >= 6) break;
  }
  return sources;
}

function normalizeProfile(raw: unknown): BrainstormProfileSnapshot {
  const base = emptyProfileSnapshot();
  if (!raw || typeof raw !== 'object') return base;
  const rec = raw as Record<string, unknown>;
  const str = (key: string) => (typeof rec[key] === 'string' ? (rec[key] as string).trim() : '');
  return {
    name: str('name'),
    email: str('email'),
    title: str('title') || null,
    functionName: str('functionName') || null,
    squad: str('squad') || null,
    department: str('department') || null,
    roleNote: str('roleNote') || null,
  };
}

function mapIdea(row: IdeaRow): BrainstormIdea {
  return {
    id: row.id,
    brainstormId: row.brainstorm_id,
    cluster: row.cluster,
    title: row.title,
    body: row.body || '',
    rationale: row.rationale,
    tags: asStringList(parseJson(row.tags, []), 12),
    impact: clampScore(row.impact),
    effort: clampScore(row.effort),
    starred: row.starred === 1,
    status: row.status === 'discarded' ? 'discarded' : 'active',
    sources: normalizeSources(parseJson(row.sources, [])),
    author: row.author === 'user' ? 'user' : 'agent',
    authorEmail: row.author_email || null,
    authorName: row.author_name || null,
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapBrief(raw: string | null): BrainstormBrief | null {
  if (!raw) return null;
  const parsed = parseJson<Record<string, unknown> | null>(raw, null);
  if (!parsed || typeof parsed !== 'object') return null;
  const experiments = Array.isArray(parsed.experiments)
    ? parsed.experiments.flatMap((entry) => {
        if (!entry || typeof entry !== 'object') return [];
        const rec = entry as Record<string, unknown>;
        const title = typeof rec.title === 'string' ? rec.title.trim() : '';
        if (!title) return [];
        return [
          {
            ideaId: typeof rec.ideaId === 'string' ? rec.ideaId : null,
            title,
            steps: typeof rec.steps === 'string' ? rec.steps.trim() : '',
          },
        ];
      })
    : [];
  return {
    summary: typeof parsed.summary === 'string' ? parsed.summary.trim() : '',
    rankedIdeaIds: asStringList(parsed.rankedIdeaIds, 20),
    experiments: experiments.slice(0, 8),
    openQuestions: asStringList(parsed.openQuestions, 12),
    sources: normalizeSources(parsed.sources),
  };
}

const ACTIVITY_KINDS = new Set<BrainstormActivityKind>([
  'idea_added',
  'thought',
  'starred',
  'discarded',
  'edited',
  'phase',
  'joined',
  'brief_saved',
  'file_added',
]);

export class BrainstormStore {
  private actor: BrainstormActor = { email: '', name: 'Facilitator' };
  /** Remote applies must not write a second activity row for the same event. */
  private silenceActivity = false;

  constructor(private readonly db: DatabaseInstance) {}

  setActor(actor: BrainstormActor): void {
    this.actor = {
      email: actor.email.trim(),
      name: actor.name.trim() || 'Someone',
    };
  }

  private touch(id: string, now = Date.now()): void {
    this.db.raw.prepare('UPDATE brainstorms SET updated_at = ? WHERE id = ?').run(now, id);
  }

  private row(id: string): BrainstormRow | undefined {
    return this.db.raw.prepare('SELECT * FROM brainstorms WHERE id = ?').get(id) as
      | BrainstormRow
      | undefined;
  }

  private ideasFor(id: string): BrainstormIdea[] {
    const rows = this.db.raw
      .prepare(
        `SELECT * FROM brainstorm_ideas WHERE brainstorm_id = ?
         ORDER BY position ASC, created_at ASC`
      )
      .all(id) as IdeaRow[];
    return rows.map(mapIdea);
  }

  private toDetail(row: BrainstormRow): BrainstormDetail {
    return {
      id: row.id,
      sessionId: row.session_id,
      topic: row.topic,
      goal: row.goal,
      technique: isBrainstormTechnique(row.technique) ? row.technique : 'auto',
      profileSnapshot: normalizeProfile(parseJson(row.profile_snapshot, {})),
      signals: this.parseSignals(row.signals),
      phase: isBrainstormPhase(row.phase) ? row.phase : 'frame',
      status: row.status === 'wrapped' ? 'wrapped' : 'active',
      brief: mapBrief(row.brief),
      roomId: row.room_id || null,
      role: row.role === 'owner' || row.role === 'member' ? row.role : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ideas: this.ideasFor(row.id),
      activity: this.activityFor(row.id),
    };
  }

  private activityFor(id: string): BrainstormActivity[] {
    const rows = this.db.raw
      .prepare(
        `SELECT * FROM brainstorm_activity WHERE brainstorm_id = ? ORDER BY created_at ASC, id ASC`
      )
      .all(id) as Array<{
      id: string;
      brainstorm_id: string;
      idea_id: string | null;
      actor_email: string;
      actor_name: string;
      kind: string;
      text: string | null;
      created_at: number;
    }>;
    return rows.flatMap((row) => {
      if (!ACTIVITY_KINDS.has(row.kind as BrainstormActivityKind)) return [];
      return [
        {
          id: row.id,
          brainstormId: row.brainstorm_id,
          ideaId: row.idea_id,
          actorEmail: row.actor_email || '',
          actorName: row.actor_name || '',
          kind: row.kind as BrainstormActivityKind,
          text: row.text,
          createdAt: row.created_at,
        },
      ];
    });
  }

  recordActivity(input: {
    id?: string;
    brainstormId: string;
    ideaId?: string | null;
    kind: BrainstormActivityKind;
    text?: string | null;
    createdAt?: number;
    actor?: BrainstormActor;
  }): void {
    if (this.silenceActivity && !input.id) return;
    const id = input.id || uuidv4();
    const existing = this.db.raw
      .prepare('SELECT id FROM brainstorm_activity WHERE id = ?')
      .get(id) as { id: string } | undefined;
    if (existing) return;
    const actor = input.actor || this.actor;
    this.db.raw
      .prepare(
        `INSERT INTO brainstorm_activity (
          id, brainstorm_id, idea_id, actor_email, actor_name, kind, text, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.brainstormId,
        input.ideaId || null,
        actor.email || '',
        actor.name || '',
        input.kind,
        input.text?.trim() || null,
        input.createdAt || Date.now()
      );
  }

  private parseSignals(raw: string): BrainstormSignal[] {
    const parsed = parseJson<unknown[]>(raw, []);
    if (!Array.isArray(parsed)) return [];
    const signals: BrainstormSignal[] = [];
    for (const entry of parsed) {
      if (!entry || typeof entry !== 'object') continue;
      const rec = entry as Record<string, unknown>;
      const title = typeof rec.title === 'string' ? rec.title.trim() : '';
      if (!title) continue;
      signals.push({
        id: typeof rec.id === 'string' && rec.id ? rec.id : uuidv4(),
        title,
        summary: typeof rec.summary === 'string' ? rec.summary.trim() : '',
        url: typeof rec.url === 'string' ? rec.url : null,
        source: typeof rec.source === 'string' ? rec.source : null,
        kind: rec.kind === 'file' ? 'file' : rec.kind === 'tool' ? 'tool' : 'web',
        sourceId: typeof rec.sourceId === 'string' ? rec.sourceId : null,
        status:
          rec.status === 'indexing' || rec.status === 'ready' || rec.status === 'failed'
            ? rec.status
            : undefined,
      });
      if (signals.length >= 16) break;
    }
    return signals;
  }

  get(id: string): BrainstormDetail | null {
    const row = this.row(id);
    return row ? this.toDetail(row) : null;
  }

  getBySessionId(sessionId: string): BrainstormDetail | null {
    const row = this.db.raw
      .prepare('SELECT * FROM brainstorms WHERE session_id = ?')
      .get(sessionId) as BrainstormRow | undefined;
    return row ? this.toDetail(row) : null;
  }

  list(): BrainstormSummary[] {
    const rows = this.db.raw
      .prepare('SELECT * FROM brainstorms ORDER BY updated_at DESC')
      .all() as BrainstormRow[];
    return rows.map((row) => summaryFromDetail(this.toDetail(row)));
  }

  create(input: {
    sessionId: string;
    topic: string;
    goal: string | null;
    technique: BrainstormTechnique;
    profile: BrainstormProfileSnapshot;
  }): BrainstormDetail {
    const now = Date.now();
    const id = uuidv4();
    this.db.raw
      .prepare(
        `INSERT INTO brainstorms (
          id, session_id, topic, goal, technique, profile_snapshot, signals, phase, status, brief, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, '[]', 'frame', 'active', NULL, ?, ?)`
      )
      .run(
        id,
        input.sessionId,
        input.topic,
        input.goal,
        input.technique,
        JSON.stringify(input.profile),
        now,
        now
      );
    return this.get(id)!;
  }

  setPhase(id: string, phase: BrainstormPhase): BrainstormDetail | null {
    const current = this.row(id);
    if (!current) return null;
    const now = Date.now();
    this.db.raw
      .prepare('UPDATE brainstorms SET phase = ?, updated_at = ? WHERE id = ?')
      .run(phase, now, id);
    if (current.phase !== phase) {
      this.recordActivity({ brainstormId: id, kind: 'phase', text: phase, createdAt: now });
    }
    return this.get(id);
  }

  rename(id: string, topic: string): BrainstormDetail | null {
    const trimmed = topic.trim();
    if (!trimmed) return this.get(id);
    this.db.raw
      .prepare('UPDATE brainstorms SET topic = ?, updated_at = ? WHERE id = ?')
      .run(trimmed, Date.now(), id);
    return this.get(id);
  }

  setRoom(id: string, roomId: string, role: 'owner' | 'member'): BrainstormDetail | null {
    const now = Date.now();
    this.db.raw
      .prepare('UPDATE brainstorms SET room_id = ?, role = ?, updated_at = ? WHERE id = ?')
      .run(roomId, role, now, id);
    return this.get(id);
  }

  setSignals(id: string, signals: BrainstormSignal[]): BrainstormDetail | null {
    const now = Date.now();
    this.db.raw
      .prepare('UPDATE brainstorms SET signals = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(signals.slice(0, 16)), now, id);
    return this.get(id);
  }

  saveBrief(id: string, brief: BrainstormBrief): BrainstormDetail | null {
    const now = Date.now();
    this.db.raw
      .prepare(
        `UPDATE brainstorms
         SET brief = ?, phase = 'wrapup', status = 'wrapped', updated_at = ?
         WHERE id = ?`
      )
      .run(JSON.stringify(brief), now, id);
    this.recordActivity({
      brainstormId: id,
      kind: 'brief_saved',
      text: brief.summary,
      createdAt: now,
    });
    return this.get(id);
  }

  nextPosition(brainstormId: string): number {
    const row = this.db.raw
      .prepare(
        'SELECT COALESCE(MAX(position), -1) AS maxPos FROM brainstorm_ideas WHERE brainstorm_id = ?'
      )
      .get(brainstormId) as { maxPos: number };
    return (row?.maxPos ?? -1) + 1;
  }

  addIdeas(
    brainstormId: string,
    drafts: BrainstormIdeaDraft[],
    author: BrainstormIdeaAuthor
  ): BrainstormDetail | null {
    if (!this.row(brainstormId)) return null;
    const now = Date.now();
    let position = this.nextPosition(brainstormId);
    const insert = this.db.raw.prepare(
      `INSERT INTO brainstorm_ideas (
        id, brainstorm_id, cluster, title, body, rationale, tags, impact, effort, starred, status, sources, author, author_email, author_name, position, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)`
    );
    const added: Array<{ id: string; title: string }> = [];
    const authorName = author === 'agent' ? 'Facilitator' : this.actor.name || 'You';
    const authorEmail = author === 'agent' ? '' : this.actor.email;
    const write = this.db.raw.transaction((items: BrainstormIdeaDraft[]) => {
      for (const draft of items) {
        const title = draft.title.trim();
        if (!title) continue;
        const id = uuidv4();
        insert.run(
          id,
          brainstormId,
          draft.cluster?.trim() || null,
          title,
          (draft.body || '').trim(),
          draft.rationale?.trim() || null,
          JSON.stringify(asStringList(draft.tags, 8)),
          clampScore(draft.impact),
          clampScore(draft.effort),
          draft.starred ? 1 : 0,
          JSON.stringify(normalizeSources(draft.sources)),
          author,
          authorEmail,
          authorName,
          position,
          now,
          now
        );
        added.push({ id, title });
        position += 1;
      }
    });
    write(drafts.slice(0, 30));
    for (const idea of added) {
      this.recordActivity({
        brainstormId,
        ideaId: idea.id,
        kind: 'idea_added',
        text: idea.title,
        createdAt: now,
        actor: { email: authorEmail, name: authorName },
      });
    }
    this.touch(brainstormId, now);
    return this.get(brainstormId);
  }

  updateIdea(id: string, patch: BrainstormIdeaPatch): BrainstormDetail | null {
    const existing = this.db.raw.prepare('SELECT * FROM brainstorm_ideas WHERE id = ?').get(id) as
      | IdeaRow
      | undefined;
    if (!existing) return null;
    const now = Date.now();
    const title = patch.title !== undefined ? patch.title.trim() : existing.title;
    if (!title) return this.get(existing.brainstorm_id);
    this.db.raw
      .prepare(
        `UPDATE brainstorm_ideas SET
          title = ?, body = ?, rationale = ?, tags = ?, impact = ?, effort = ?,
          cluster = ?, sources = ?, starred = ?, status = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(
        title,
        patch.body !== undefined ? patch.body.trim() : existing.body,
        patch.rationale !== undefined ? patch.rationale?.trim() || null : existing.rationale,
        patch.tags !== undefined ? JSON.stringify(asStringList(patch.tags, 8)) : existing.tags,
        patch.impact !== undefined ? clampScore(patch.impact) : existing.impact,
        patch.effort !== undefined ? clampScore(patch.effort) : existing.effort,
        patch.cluster !== undefined ? patch.cluster?.trim() || null : existing.cluster,
        patch.sources !== undefined
          ? JSON.stringify(normalizeSources(patch.sources))
          : existing.sources,
        patch.starred !== undefined ? (patch.starred ? 1 : 0) : existing.starred,
        patch.status !== undefined
          ? patch.status === 'discarded'
            ? 'discarded'
            : 'active'
          : existing.status,
        now,
        id
      );
    const kind: BrainstormActivityKind =
      patch.starred === true && existing.starred !== 1
        ? 'starred'
        : patch.status === 'discarded' && existing.status !== 'discarded'
          ? 'discarded'
          : 'edited';
    this.recordActivity({
      brainstormId: existing.brainstorm_id,
      ideaId: id,
      kind,
      text: title,
      createdAt: now,
    });
    this.touch(existing.brainstorm_id, now);
    return this.get(existing.brainstorm_id);
  }

  addThought(brainstormId: string, ideaId: string | null, text: string): BrainstormDetail | null {
    const body = text.trim();
    if (!body || !this.row(brainstormId)) return this.get(brainstormId);
    if (ideaId) {
      const idea = this.db.raw.prepare('SELECT id FROM brainstorm_ideas WHERE id = ?').get(ideaId);
      if (!idea) return this.get(brainstormId);
    }
    this.recordActivity({
      brainstormId,
      ideaId,
      kind: 'thought',
      text: body.slice(0, 2000),
    });
    this.touch(brainstormId);
    return this.get(brainstormId);
  }

  cluster(
    brainstormId: string,
    groups: Array<{ name: string; ideaIds: string[] }>
  ): BrainstormDetail | null {
    if (!this.row(brainstormId)) return null;
    const now = Date.now();
    const update = this.db.raw.prepare(
      `UPDATE brainstorm_ideas SET cluster = ?, updated_at = ? WHERE id = ? AND brainstorm_id = ?`
    );
    const write = this.db.raw.transaction((items: Array<{ name: string; ideaIds: string[] }>) => {
      for (const group of items) {
        const name = group.name.trim();
        if (!name) continue;
        for (const ideaId of group.ideaIds) {
          update.run(name, now, ideaId, brainstormId);
        }
      }
    });
    write(groups.slice(0, 20));
    this.recordActivity({
      brainstormId,
      kind: 'edited',
      text: groups
        .map((group) => group.name)
        .filter(Boolean)
        .join(', '),
      createdAt: now,
    });
    this.touch(brainstormId, now);
    return this.get(brainstormId);
  }

  /**
   * Apply a peer's board. Same ids are written once. Older remote copies do not
   * overwrite a newer local idea.
   */
  applyRemote(detail: BrainstormDetail): BrainstormDetail | null {
    const local = this.getBySessionId(detail.sessionId) || this.get(detail.id);
    if (!local) return null;
    this.silenceActivity = true;
    try {
      if (detail.phase && detail.phase !== local.phase) {
        this.db.raw
          .prepare('UPDATE brainstorms SET phase = ?, updated_at = ? WHERE id = ?')
          .run(detail.phase, Date.now(), local.id);
      }
      if (detail.signals) {
        this.db.raw
          .prepare('UPDATE brainstorms SET signals = ? WHERE id = ?')
          .run(JSON.stringify(detail.signals.slice(0, 16)), local.id);
      }
      for (const idea of detail.ideas || []) {
        this.upsertRemoteIdea(local.id, idea);
      }
      for (const row of detail.activity || []) {
        this.recordActivity({
          id: row.id,
          brainstormId: local.id,
          ideaId: row.ideaId,
          kind: row.kind,
          text: row.text,
          createdAt: row.createdAt,
          actor: { email: row.actorEmail, name: row.actorName },
        });
      }
      this.touch(local.id);
    } finally {
      this.silenceActivity = false;
    }
    return this.get(local.id);
  }

  private upsertRemoteIdea(brainstormId: string, idea: BrainstormIdea): void {
    const existing = this.db.raw
      .prepare('SELECT * FROM brainstorm_ideas WHERE id = ?')
      .get(idea.id) as IdeaRow | undefined;
    if (existing && existing.updated_at >= idea.updatedAt) return;
    const sources = JSON.stringify(normalizeSources(idea.sources));
    const tags = JSON.stringify(asStringList(idea.tags, 8));
    if (!existing) {
      this.db.raw
        .prepare(
          `INSERT INTO brainstorm_ideas (
            id, brainstorm_id, cluster, title, body, rationale, tags, impact, effort, starred, status, sources, author, author_email, author_name, position, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          idea.id,
          brainstormId,
          idea.cluster,
          idea.title,
          idea.body,
          idea.rationale,
          tags,
          idea.impact,
          idea.effort,
          idea.starred ? 1 : 0,
          idea.status === 'discarded' ? 'discarded' : 'active',
          sources,
          idea.author === 'user' ? 'user' : 'agent',
          idea.authorEmail || null,
          idea.authorName || null,
          idea.position,
          idea.createdAt,
          idea.updatedAt
        );
      return;
    }
    this.db.raw
      .prepare(
        `UPDATE brainstorm_ideas SET
          title = ?, body = ?, rationale = ?, tags = ?, impact = ?, effort = ?,
          cluster = ?, sources = ?, starred = ?, status = ?, author = ?, author_email = ?, author_name = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(
        idea.title,
        idea.body,
        idea.rationale,
        tags,
        idea.impact,
        idea.effort,
        idea.cluster,
        sources,
        idea.starred ? 1 : 0,
        idea.status === 'discarded' ? 'discarded' : 'active',
        idea.author === 'user' ? 'user' : 'agent',
        idea.authorEmail || null,
        idea.authorName || null,
        idea.updatedAt,
        idea.id
      );
  }

  remove(id: string): boolean {
    this.db.raw.prepare('DELETE FROM brainstorm_activity WHERE brainstorm_id = ?').run(id);
    const result = this.db.raw
      .prepare('DELETE FROM brainstorm_ideas WHERE brainstorm_id = ?')
      .run(id);
    const parent = this.db.raw.prepare('DELETE FROM brainstorms WHERE id = ?').run(id);
    return parent.changes > 0 || result.changes > 0;
  }

  removeBySessionId(sessionId: string): string | null {
    const row = this.db.raw
      .prepare('SELECT id FROM brainstorms WHERE session_id = ?')
      .get(sessionId) as { id: string } | undefined;
    if (!row) return null;
    this.remove(row.id);
    return row.id;
  }
}

export type { BrainstormStatus };
