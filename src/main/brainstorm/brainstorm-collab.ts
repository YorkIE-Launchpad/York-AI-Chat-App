/**
 * Board, activity, and file excerpts live in the same Y.Doc as the shared chat.
 * The relay stores nothing, so a joiner only catches up from someone who is online.
 */
import * as Y from 'yjs';
import type { BrainstormDetail } from '../../shared/brainstorm-types';

export const BRAINSTORM_LOCAL_ORIGIN = 'brainstorm-local';
const SOURCE_EXCERPT_CAP = 60_000;

export interface SharedBrainstormSource {
  sourceId: string;
  title: string;
  excerpt: string;
}

function maps(doc: Y.Doc) {
  return {
    meta: doc.getMap<string>('bs.meta'),
    ideas: doc.getMap<string>('bs.ideas'),
    activity: doc.getMap<string>('bs.activity'),
    sources: doc.getMap<string>('bs.sources'),
  };
}

export function publishBrainstorm(doc: Y.Doc, detail: BrainstormDetail): void {
  const { meta, ideas, activity } = maps(doc);
  doc.transact(() => {
    meta.set(
      'json',
      JSON.stringify({
        id: detail.id,
        sessionId: detail.sessionId,
        topic: detail.topic,
        goal: detail.goal,
        technique: detail.technique,
        phase: detail.phase,
        status: detail.status,
        profileSnapshot: detail.profileSnapshot,
        signals: detail.signals,
        brief: detail.brief,
        roomId: detail.roomId || null,
      })
    );
    for (const idea of detail.ideas) {
      ideas.set(idea.id, JSON.stringify(idea));
    }
    for (const row of detail.activity || []) {
      activity.set(row.id, JSON.stringify(row));
    }
  }, BRAINSTORM_LOCAL_ORIGIN);
}

export function publishBrainstormSource(doc: Y.Doc, source: SharedBrainstormSource): void {
  const excerpt = source.excerpt.slice(0, SOURCE_EXCERPT_CAP);
  doc.transact(() => {
    maps(doc).sources.set(
      source.sourceId,
      JSON.stringify({ sourceId: source.sourceId, title: source.title, excerpt })
    );
  }, BRAINSTORM_LOCAL_ORIGIN);
}

function parse<T>(raw: string | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** Snapshot of the shared board, independent of whose session id is local. */
export function readSharedBrainstorm(doc: Y.Doc): {
  meta: Record<string, unknown> | null;
  ideas: unknown[];
  activity: unknown[];
  sources: SharedBrainstormSource[];
} {
  const { meta, ideas, activity, sources } = maps(doc);
  const parsedMeta = parse<Record<string, unknown>>(meta.get('json'));
  return {
    meta: parsedMeta,
    ideas: [...ideas.values()].map((raw) => parse(raw)).filter(Boolean),
    activity: [...activity.values()].map((raw) => parse(raw)).filter(Boolean),
    sources: [...sources.values()].flatMap((raw) => {
      const row = parse<SharedBrainstormSource>(raw);
      return row?.sourceId && row.title ? [row] : [];
    }),
  };
}

export function observeBrainstormDoc(doc: Y.Doc, onRemote: () => void): () => void {
  const { meta, ideas, activity, sources } = maps(doc);
  const handler = (_event: unknown, transaction: Y.Transaction) => {
    if (transaction.origin === BRAINSTORM_LOCAL_ORIGIN) return;
    onRemote();
  };
  meta.observe(handler);
  ideas.observe(handler);
  activity.observe(handler);
  sources.observe(handler);
  return () => {
    meta.unobserve(handler);
    ideas.unobserve(handler);
    activity.unobserve(handler);
    sources.unobserve(handler);
  };
}
