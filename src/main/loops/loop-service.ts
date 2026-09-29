/**
 * Loops service — persistent commitments captured from meetings and Matter, plus manual entry.
 */
import type { BrowserWindow } from 'electron';
import type { DatabaseInstance } from '../db/database';
import type { MCPManager } from '../mcp/mcp-manager';
import type { MeetingService } from '../meetings/meeting-service';
import type { MeetingSession } from '../meetings/meeting-types';
import type { ChatSearchHit } from '../../shared/chat-search';
import type { MatterItem } from '../../shared/matter';
import {
  DEFAULT_LOOPS_RUNTIME,
  isLoopDue,
  normalizeLoopsRuntimeConfig,
  type Loop,
  type LoopCreateInput,
  type LoopUpdateInput,
  type LoopsRuntimeConfig,
  type LoopsSnapshot,
} from '../../shared/loops';
import type { WelcomeProfile } from '../../shared/welcome-actions';
import { configStore } from '../config/config-store';
import { log, logError, logWarn } from '../utils/logger';
import { LoopStore } from './loop-store';
import {
  extractMeetingLoops,
  matterItemToLoop,
  selectMatterLoopCandidates,
} from './loop-extractor';
import { researchLoop } from './loop-research';

export class LoopService {
  private readonly store: LoopStore;
  private getMainWindow: (() => BrowserWindow | null) | null = null;
  private resolveProfile: () => Promise<WelcomeProfile | null> = async () => null;
  private getMatterItem: (id: string) => MatterItem | null = () => null;
  private onMatterItemDone: ((matterItemId: string) => void) | null = null;
  private getMcpManager: () => MCPManager | null = () => null;
  private getMeetingService: () => MeetingService | null = () => null;
  private searchChats: ((query: string, limit: number) => ChatSearchHit[]) | null = null;
  private readonly researching = new Set<string>();

  constructor(db: DatabaseInstance) {
    this.store = new LoopStore(db);
    this.store.resetStaleResearch();
  }

  setResearchSources(sources: {
    getMcpManager: () => MCPManager | null;
    getMeetingService: () => MeetingService | null;
    searchChats?: (query: string, limit: number) => ChatSearchHit[];
  }): void {
    this.getMcpManager = sources.getMcpManager;
    this.getMeetingService = sources.getMeetingService;
    this.searchChats = sources.searchChats ?? null;
  }

  setMainWindowGetter(getter: () => BrowserWindow | null): void {
    this.getMainWindow = getter;
  }

  setProfileResolver(resolver: () => Promise<WelcomeProfile | null>): void {
    this.resolveProfile = resolver;
  }

  setMatterBridge(bridge: {
    getItem: (id: string) => MatterItem | null;
    markDone: (matterItemId: string) => void;
  }): void {
    this.getMatterItem = bridge.getItem;
    this.onMatterItemDone = bridge.markDone;
  }

  getRuntime(): LoopsRuntimeConfig {
    return normalizeLoopsRuntimeConfig(configStore.getAll().loopsRuntime || DEFAULT_LOOPS_RUNTIME);
  }

  updateRuntime(partial: Partial<LoopsRuntimeConfig>): LoopsRuntimeConfig {
    const next = normalizeLoopsRuntimeConfig({ ...this.getRuntime(), ...partial });
    configStore.update({ loopsRuntime: next });
    this.pushSnapshot();
    return next;
  }

  getSnapshot(): LoopsSnapshot {
    const loops = this.store.list();
    const now = Date.now();
    return {
      loops,
      dueCount: loops.filter((loop) => isLoopDue(loop, now)).length,
      settings: this.getRuntime(),
    };
  }

  create(input: LoopCreateInput): LoopsSnapshot {
    const title = input.title?.trim();
    if (!title) throw new Error('title is required');
    const { loop } = this.store.upsertByFingerprint({
      fingerprint: `manual:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`,
      title,
      notes: input.notes ?? null,
      origin: 'manual',
      owner: input.owner,
      counterpart: input.counterpart ?? null,
      dueAt: input.dueAt ?? null,
      priority: input.priority,
      autoCaptured: false,
    });
    const snapshot = input.research === false ? null : this.startResearch(loop.id);
    return snapshot ?? this.changed();
  }

  update(id: string, updates: LoopUpdateInput): LoopsSnapshot {
    const before = this.store.get(id);
    if (!before) return this.getSnapshot();
    const after = this.store.update(id, updates);
    if (after && before.status === 'open' && after.status === 'done') {
      this.syncMatterDone(after);
    }
    return this.changed();
  }

  close(id: string): LoopsSnapshot {
    return this.update(id, { status: 'done' });
  }

  drop(id: string): LoopsSnapshot {
    return this.update(id, { status: 'dropped' });
  }

  /** Explicit promotion from a Matter signal — reopens a previously closed loop. */
  promoteFromMatter(matterItemId: string): LoopsSnapshot {
    const item = this.getMatterItem(matterItemId);
    if (!item) throw new Error('Matter item not found');
    const { loop } = this.store.upsertByFingerprint(matterItemToLoop(item, false));
    if (loop.status !== 'open') this.store.update(loop.id, { status: 'open' });
    const snapshot = this.startResearch(loop.id);
    return snapshot ?? this.changed();
  }

  /**
   * Sweep every available source for this loop and store a cited note. Returns the
   * snapshot with status `running`; completion is pushed via `loops:changed`.
   */
  research(id: string): LoopsSnapshot {
    if (!this.store.get(id)) throw new Error('Loop not found');
    return this.startResearch(id) ?? this.getSnapshot();
  }

  private startResearch(id: string): LoopsSnapshot | null {
    if (this.researching.has(id)) return null;
    const loop = this.store.setResearch(id, { status: 'running' });
    if (!loop) return null;
    this.researching.add(id);
    void this.runResearch(loop).finally(() => this.researching.delete(id));
    return this.changed();
  }

  private async runResearch(loop: Loop): Promise<void> {
    try {
      const matterItem = loop.sourceRef.matterItemId
        ? this.getMatterItem(loop.sourceRef.matterItemId)
        : null;
      const result = await researchLoop(loop, {
        mcp: this.getMcpManager(),
        meetingService: this.getMeetingService(),
        matterItem,
        searchChats: this.searchChats,
      });
      this.store.setResearch(loop.id, {
        status: 'done',
        note: result.note || null,
        sources: result.sources,
      });
      const current = this.store.get(loop.id);
      if (result.dueAt != null && current?.status === 'open' && current.dueAt == null) {
        this.store.update(loop.id, { dueAt: result.dueAt });
        log(`[Loops] Deadline found for ${loop.id}: ${new Date(result.dueAt).toISOString()}`);
      }
      log(`[Loops] Research done for ${loop.id} (${result.sources.length} sources)`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logError('[Loops] Research failed:', error);
      this.store.setResearch(loop.id, { status: 'error', error: message });
    }
    this.changed();
  }

  async captureFromMeeting(meeting: MeetingSession): Promise<void> {
    if (!this.getRuntime().captureFromMeetings) return;
    try {
      const profile = await this.resolveProfile().catch(() => null);
      const candidates = await extractMeetingLoops(meeting, profile);
      let created = 0;
      for (const candidate of candidates) {
        if (this.store.upsertByFingerprint(candidate).created) created += 1;
      }
      if (created > 0) {
        log(`[Loops] Captured ${created} loop(s) from meeting ${meeting.id}`);
        this.changed();
      }
    } catch (error) {
      logError('[Loops] Meeting capture failed:', error);
    }
  }

  captureFromMatter(items: MatterItem[]): void {
    const runtime = this.getRuntime();
    if (!runtime.captureFromMatter && !runtime.captureFromMeetings) return;
    try {
      const candidates = selectMatterLoopCandidates(items, runtime).filter((item) =>
        item.source === 'meeting' ? runtime.captureFromMeetings : runtime.captureFromMatter
      );
      let created = 0;
      for (const item of candidates) {
        if (this.store.upsertByFingerprint(matterItemToLoop(item, true)).created) created += 1;
      }
      if (created > 0) {
        log(`[Loops] Captured ${created} loop(s) from Matter scan`);
        this.changed();
      }
    } catch (error) {
      logError('[Loops] Matter capture failed:', error);
    }
  }

  private syncMatterDone(loop: Loop): void {
    const matterItemId = loop.sourceRef.matterItemId;
    if (!matterItemId || !this.onMatterItemDone) return;
    try {
      this.onMatterItemDone(matterItemId);
    } catch (error) {
      logWarn('[Loops] Failed to mark Matter item done:', error);
    }
  }

  private changed(): LoopsSnapshot {
    const snapshot = this.getSnapshot();
    this.pushSnapshot(snapshot);
    return snapshot;
  }

  private pushSnapshot(snapshot = this.getSnapshot()): void {
    const win = this.getMainWindow?.();
    if (win && !win.isDestroyed()) {
      win.webContents.send('loops:changed', snapshot);
    }
  }
}
