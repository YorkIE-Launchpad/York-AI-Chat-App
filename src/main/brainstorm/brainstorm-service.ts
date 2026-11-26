/**
 * Brainstorm lifecycle: profile snapshot, linked chat session, board mutations.
 */
import type { Session } from '../../renderer/types';
import type { WelcomeProfile } from '../../shared/welcome-actions';
import { renderBrainstormBriefHtml } from '../../shared/brainstorm-brief-html';
import {
  emptyProfileSnapshot,
  isBrainstormPhase,
  isBrainstormTechnique,
  type BrainstormBrief,
  type BrainstormCreateInput,
  type BrainstormDetail,
  type BrainstormIdeaDraft,
  type BrainstormIdeaPatch,
  type BrainstormPhase,
  type BrainstormActor,
  type BrainstormProfileSnapshot,
  type BrainstormSignal,
  type BrainstormSummary,
} from '../../shared/brainstorm-types';
import { buildKickoffPrompt } from './brainstorm-prompt';
import {
  observeBrainstormDoc,
  publishBrainstorm,
  publishBrainstormSource,
  readSharedBrainstorm,
} from './brainstorm-collab';
import { BrainstormStore, normalizeSources } from './brainstorm-store';
import { v4 as uuidv4 } from 'uuid';
import type * as Y from 'yjs';

export interface BrainstormRuntime {
  resolveProfile: () => Promise<WelcomeProfile | null>;
  createIdleSession: (title: string) => Promise<Session>;
  continueSession: (sessionId: string, prompt: string) => Promise<void>;
  deleteSession: (sessionId: string) => Promise<void>;
  broadcastSessions: () => void;
  writeBriefFile: (detail: BrainstormDetail) => string;
  lockSessionModel?: (sessionId: string, model: string, provider: string) => boolean;
  currentActor?: () => BrainstormActor;
  shareSession?: (sessionId: string) => Promise<{ roomId: string }>;
  joinSession?: (roomId: string) => Promise<{ sessionId: string; roomId: string }>;
  getCollabDoc?: (sessionId: string) => Y.Doc | null;
  addKnowledgeFiles?: (
    sessionId: string,
    paths: string[]
  ) => Promise<Array<{ id: string; title: string; status: string }>>;
  readKnowledge?: (sessionId: string, sourceId: string) => string | null;
  ingestExcerpt?: (
    sessionId: string,
    source: { sourceId: string; title: string; excerpt: string }
  ) => Promise<void>;
}

export interface BrainstormCreated {
  detail: BrainstormDetail;
  session: Session;
}

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed || null;
}

/** A typed value replaces Hub data. A blank setup field keeps the resolved profile. */
function keepUnlessTyped(
  override: string | null | undefined,
  current: string | null
): string | null {
  return nonEmpty(override) ?? current;
}

function mergeProfile(
  base: WelcomeProfile | null,
  override: Partial<BrainstormProfileSnapshot> | undefined
): BrainstormProfileSnapshot {
  const snapshot = emptyProfileSnapshot();
  snapshot.name = base?.name || '';
  snapshot.email = base?.email || '';
  snapshot.title = base?.title ?? null;
  snapshot.functionName = base?.functionName ?? null;
  snapshot.squad = base?.squad ?? null;
  snapshot.department = base?.department ?? null;
  snapshot.roleNote = nonEmpty(base?.introduction);
  if (!override) return snapshot;
  const name = nonEmpty(override.name);
  const email = nonEmpty(override.email);
  if (name) snapshot.name = name;
  if (email) snapshot.email = email;
  snapshot.title = keepUnlessTyped(override.title, snapshot.title);
  snapshot.functionName = keepUnlessTyped(override.functionName, snapshot.functionName);
  snapshot.squad = keepUnlessTyped(override.squad, snapshot.squad);
  snapshot.department = keepUnlessTyped(override.department, snapshot.department);
  snapshot.roleNote = keepUnlessTyped(override.roleNote, snapshot.roleNote);
  return snapshot;
}

function normalizeSignals(raw: unknown): BrainstormSignal[] {
  if (!Array.isArray(raw)) return [];
  const signals: BrainstormSignal[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const rec = entry as Record<string, unknown>;
    const title = typeof rec.title === 'string' ? rec.title.trim() : '';
    if (!title) continue;
    signals.push({
      id: typeof rec.id === 'string' && rec.id.trim() ? rec.id.trim() : uuidv4(),
      title,
      summary: typeof rec.summary === 'string' ? rec.summary.trim() : '',
      url: typeof rec.url === 'string' ? rec.url.trim() : null,
      source: typeof rec.source === 'string' ? rec.source.trim() : null,
      kind: rec.kind === 'file' ? 'file' : rec.kind === 'tool' ? 'tool' : 'web',
      sourceId: typeof rec.sourceId === 'string' ? rec.sourceId : null,
      status:
        rec.status === 'indexing' || rec.status === 'ready' || rec.status === 'failed'
          ? rec.status
          : undefined,
    });
  }
  return signals.slice(0, 16);
}

function normalizeBrief(raw: unknown): BrainstormBrief | null {
  if (!raw || typeof raw !== 'object') return null;
  const rec = raw as Record<string, unknown>;
  const summary = typeof rec.summary === 'string' ? rec.summary.trim() : '';
  const rankedIdeaIds = Array.isArray(rec.rankedIdeaIds)
    ? rec.rankedIdeaIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    : [];
  const experiments = Array.isArray(rec.experiments)
    ? rec.experiments.flatMap((entry) => {
        if (!entry || typeof entry !== 'object') return [];
        const item = entry as Record<string, unknown>;
        const title = typeof item.title === 'string' ? item.title.trim() : '';
        if (!title) return [];
        return [
          {
            ideaId: typeof item.ideaId === 'string' ? item.ideaId : null,
            title,
            steps: typeof item.steps === 'string' ? item.steps.trim() : '',
          },
        ];
      })
    : [];
  const openQuestions = Array.isArray(rec.openQuestions)
    ? rec.openQuestions.filter((q): q is string => typeof q === 'string' && q.trim().length > 0)
    : [];
  if (!summary && rankedIdeaIds.length === 0 && experiments.length === 0) return null;
  return {
    summary,
    rankedIdeaIds: rankedIdeaIds.slice(0, 20),
    experiments: experiments.slice(0, 8),
    openQuestions: openQuestions.slice(0, 12).map((q) => q.trim()),
    sources: normalizeSources(rec.sources),
  };
}

export class BrainstormService {
  private readonly collabUnsub = new Map<string, () => void>();
  private readonly ingestedSources = new Set<string>();

  constructor(
    private readonly store: BrainstormStore,
    private readonly runtime: BrainstormRuntime,
    private readonly emit: (detail: BrainstormDetail) => void,
    private readonly emitDeleted: (id: string) => void
  ) {}

  private actAsUser(): void {
    const actor = this.runtime.currentActor?.() ?? { email: '', name: 'You' };
    this.store.setActor(actor);
  }

  private actAsFacilitator(): void {
    this.store.setActor({ email: '', name: 'Facilitator' });
  }

  list(): BrainstormSummary[] {
    return this.store.list();
  }

  get(id: string): BrainstormDetail | null {
    return this.store.get(id);
  }

  getBySessionId(sessionId: string): BrainstormDetail | null {
    return this.store.getBySessionId(sessionId);
  }

  async previewProfile(): Promise<BrainstormProfileSnapshot> {
    try {
      const profile = await this.runtime.resolveProfile();
      return mergeProfile(profile, undefined);
    } catch {
      return emptyProfileSnapshot();
    }
  }

  async create(input: BrainstormCreateInput): Promise<BrainstormCreated> {
    const topic = input.topic?.trim();
    if (!topic) throw new Error('A topic is required');
    const technique =
      input.technique && isBrainstormTechnique(input.technique) ? input.technique : 'auto';
    let resolved: WelcomeProfile | null = null;
    try {
      resolved = await this.runtime.resolveProfile();
    } catch {
      resolved = null;
    }
    const profile = mergeProfile(resolved, input.profile);
    const title = topic.length > 80 ? `${topic.slice(0, 77)}…` : topic;
    const session = await this.runtime.createIdleSession(title);
    let detail = this.store.create({
      sessionId: session.id,
      topic,
      goal: input.goal?.trim() || null,
      technique,
      profile,
    });
    const paths = (input.filePaths || []).map((path) => path.trim()).filter(Boolean);
    if (paths.length > 0) {
      detail = (await this.addFiles(detail.id, paths)) || detail;
    }
    this.emit(detail);
    await this.runtime.continueSession(session.id, buildKickoffPrompt(detail));
    this.runtime.broadcastSessions();
    return { detail, session };
  }

  setModel(id: string, model: string, provider: string): BrainstormDetail | null {
    const detail = this.store.get(id);
    if (!detail) return null;
    if (!this.runtime.lockSessionModel) throw new Error('Could not change the model');
    const locked = this.runtime.lockSessionModel(detail.sessionId, model, provider);
    if (!locked) throw new Error('Could not change the model');
    return detail;
  }

  private publish(detail: BrainstormDetail | null): BrainstormDetail | null {
    if (detail) {
      this.emit(detail);
      this.pushBoard(detail);
    }
    return detail;
  }

  private pushBoard(detail: BrainstormDetail): void {
    const doc = this.runtime.getCollabDoc?.(detail.sessionId);
    if (!doc || !detail.roomId) return;
    publishBrainstorm(doc, detail);
  }

  setPhase(id: string, phase: string): BrainstormDetail | null {
    if (!isBrainstormPhase(phase)) throw new Error(`Unknown phase: ${phase}`);
    this.actAsFacilitator();
    return this.publish(this.store.setPhase(id, phase));
  }

  setContext(id: string, input: { signals?: unknown; phase?: string }): BrainstormDetail | null {
    let detail: BrainstormDetail | null = this.store.get(id);
    if (!detail) return null;
    if (input.signals !== undefined) {
      const incoming = normalizeSignals(input.signals);
      const files = detail.signals.filter((signal) => signal.kind === 'file');
      const research = incoming.filter((signal) => signal.kind !== 'file');
      detail = this.store.setSignals(id, [...files, ...research]);
    }
    if (input.phase && isBrainstormPhase(input.phase)) {
      detail = this.store.setPhase(id, input.phase as BrainstormPhase);
    }
    return this.publish(detail);
  }

  addIdeas(
    id: string,
    drafts: BrainstormIdeaDraft[],
    author: 'agent' | 'user'
  ): BrainstormDetail | null {
    if (author === 'user') this.actAsUser();
    else this.actAsFacilitator();
    return this.publish(this.store.addIdeas(id, drafts, author));
  }

  updateIdea(
    ideaId: string,
    patch: BrainstormIdeaPatch,
    actor: 'agent' | 'user' = 'user'
  ): BrainstormDetail | null {
    if (actor === 'user') this.actAsUser();
    else this.actAsFacilitator();
    return this.publish(this.store.updateIdea(ideaId, patch));
  }

  addThought(id: string, ideaId: string | null, text: string): BrainstormDetail | null {
    this.actAsUser();
    return this.publish(this.store.addThought(id, ideaId, text));
  }

  cluster(
    id: string,
    groups: Array<{ name?: string; ideaIds?: string[] }>
  ): BrainstormDetail | null {
    const cleaned = groups.flatMap((group) => {
      const name = group.name?.trim() || '';
      const ideaIds = (group.ideaIds || []).filter(
        (ideaId) => typeof ideaId === 'string' && ideaId
      );
      if (!name || ideaIds.length === 0) return [];
      return [{ name, ideaIds }];
    });
    this.actAsFacilitator();
    return this.publish(this.store.cluster(id, cleaned));
  }

  saveBrief(id: string, raw: unknown): BrainstormDetail | null {
    const brief = normalizeBrief(raw);
    if (!brief) throw new Error('Brief needs a summary, ranked ideas, or experiments');
    this.actAsFacilitator();
    return this.publish(this.store.saveBrief(id, brief));
  }

  async addFiles(id: string, paths: string[]): Promise<BrainstormDetail | null> {
    const detail = this.store.get(id);
    if (!detail) return null;
    const clean = paths.map((path) => path.trim()).filter(Boolean);
    if (clean.length === 0) return detail;
    this.actAsUser();
    if (!this.runtime.addKnowledgeFiles) throw new Error('Files are not available');
    const indexed = await this.runtime.addKnowledgeFiles(detail.sessionId, clean);
    const signals = [...detail.signals];
    for (const file of indexed) {
      signals.push({
        id: uuidv4(),
        title: file.title,
        summary: '',
        url: null,
        source: file.title,
        kind: 'file',
        sourceId: file.id,
        status: file.status === 'error' ? 'failed' : file.status === 'ready' ? 'ready' : 'indexing',
      });
      this.store.recordActivity({
        brainstormId: id,
        kind: 'file_added',
        text: file.title,
      });
      const excerpt = this.runtime.readKnowledge?.(detail.sessionId, file.id) ?? null;
      const doc = this.runtime.getCollabDoc?.(detail.sessionId) ?? null;
      if (excerpt && doc) {
        publishBrainstormSource(doc, { sourceId: file.id, title: file.title, excerpt });
      }
    }
    const next = this.store.setSignals(id, signals);
    if (next && indexed.length > 0 && detail.phase !== 'frame') {
      await this.runtime.continueSession(
        detail.sessionId,
        `New source files were added: ${indexed.map((file) => file.title).join(', ')}. Read them with sources_read and fold anything useful into the board. Do not mention who uploaded them.`
      );
    }
    return this.publish(next);
  }

  async share(id: string): Promise<{ roomId: string; detail: BrainstormDetail }> {
    const detail = this.store.get(id);
    if (!detail) throw new Error('Brainstorm not found');
    if (!this.runtime.shareSession) throw new Error('Sharing is not ready');
    const shared = await this.runtime.shareSession(detail.sessionId);
    const next = this.store.setRoom(detail.id, shared.roomId, 'owner');
    if (!next) throw new Error('Brainstorm not found');
    this.bindCollab(next.sessionId);
    this.pushBoard(next);
    const doc = this.runtime.getCollabDoc?.(next.sessionId);
    if (doc) {
      for (const signal of next.signals) {
        if (signal.kind !== 'file' || !signal.sourceId) continue;
        const excerpt = this.runtime.readKnowledge?.(next.sessionId, signal.sourceId);
        if (excerpt) {
          publishBrainstormSource(doc, {
            sourceId: signal.sourceId,
            title: signal.title,
            excerpt,
          });
        }
      }
    }
    this.emit(next);
    return { roomId: shared.roomId, detail: next };
  }

  async join(roomOrInvite: string): Promise<BrainstormDetail> {
    if (!this.runtime.joinSession) throw new Error('Sharing is not ready');
    const joined = await this.runtime.joinSession(roomOrInvite);
    let detail = this.store.getBySessionId(joined.sessionId);
    if (!detail) {
      detail = this.store.create({
        sessionId: joined.sessionId,
        topic: 'Shared brainstorm',
        goal: null,
        technique: 'auto',
        profile: emptyProfileSnapshot(),
      });
      detail = this.store.setRoom(detail.id, joined.roomId, 'member') || detail;
      this.actAsUser();
      this.store.recordActivity({ brainstormId: detail.id, kind: 'joined', text: detail.topic });
    }
    this.bindCollab(joined.sessionId);
    const pulled = this.pullBoard(joined.sessionId) || this.store.get(detail.id);
    if (!pulled) throw new Error('Could not open the shared brainstorm');
    this.emit(pulled);
    this.runtime.broadcastSessions();
    return pulled;
  }

  private bindCollab(sessionId: string): void {
    if (this.collabUnsub.has(sessionId)) return;
    const doc = this.runtime.getCollabDoc?.(sessionId);
    if (!doc) return;
    const stop = observeBrainstormDoc(doc, () => {
      const next = this.pullBoard(sessionId);
      if (next) this.emit(next);
    });
    this.collabUnsub.set(sessionId, stop);
  }

  private pullBoard(sessionId: string): BrainstormDetail | null {
    const local = this.store.getBySessionId(sessionId);
    const doc = this.runtime.getCollabDoc?.(sessionId);
    if (!local || !doc) return local;
    const shared = readSharedBrainstorm(doc);
    const meta = shared.meta;
    if (
      meta &&
      typeof meta.topic === 'string' &&
      meta.topic.trim() &&
      local.topic === 'Shared brainstorm'
    ) {
      this.store.rename(local.id, meta.topic.trim());
    }
    const merged = this.store.applyRemote({
      ...local,
      topic: typeof meta?.topic === 'string' && meta.topic.trim() ? meta.topic.trim() : local.topic,
      goal: typeof meta?.goal === 'string' ? meta.goal : local.goal,
      phase:
        typeof meta?.phase === 'string' && isBrainstormPhase(meta.phase) ? meta.phase : local.phase,
      signals: Array.isArray(meta?.signals) ? normalizeSignals(meta.signals) : local.signals,
      ideas: shared.ideas as BrainstormDetail['ideas'],
      activity: shared.activity as BrainstormDetail['activity'],
    });
    for (const source of shared.sources) {
      const key = `${sessionId}:${source.sourceId}`;
      if (this.ingestedSources.has(key)) continue;
      const already = local.signals.some((signal) => signal.sourceId === source.sourceId);
      this.ingestedSources.add(key);
      if (already) continue;
      if (!this.runtime.ingestExcerpt) continue;
      void this.runtime
        .ingestExcerpt(sessionId, source)
        .then(() => {
          const current = this.store.getBySessionId(sessionId);
          if (!current) return;
          const signals = [
            ...current.signals,
            {
              id: source.sourceId,
              title: source.title,
              summary: '',
              kind: 'file' as const,
              sourceId: source.sourceId,
              status: 'ready' as const,
            },
          ];
          const next = this.store.setSignals(current.id, signals);
          if (next) this.emit(next);
        })
        .catch(() => {
          this.ingestedSources.delete(key);
        });
    }
    return merged;
  }

  async delete(id: string): Promise<boolean> {
    const existing = this.store.get(id);
    if (!existing) return false;
    this.store.remove(id);
    this.emitDeleted(id);
    await this.runtime.deleteSession(existing.sessionId);
    this.runtime.broadcastSessions();
    return true;
  }

  /** Session already gone. Drop the board without deleting the session again. */
  forgetSession(sessionId: string): void {
    const id = this.store.removeBySessionId(sessionId);
    if (id) this.emitDeleted(id);
  }

  exportBrief(id: string): { path: string; html: string } {
    const detail = this.store.get(id);
    if (!detail) throw new Error('Brainstorm not found');
    if (!detail.brief && detail.ideas.length === 0) {
      throw new Error('Nothing to export yet');
    }
    const path = this.runtime.writeBriefFile(detail);
    return { path, html: renderBrainstormBriefHtml(detail) };
  }
}
