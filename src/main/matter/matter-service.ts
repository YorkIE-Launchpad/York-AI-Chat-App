import type { BrowserWindow } from 'electron';
import type { DatabaseInstance } from '../db/database';
import type { MCPManager } from '../mcp/mcp-manager';
import type { MeetingService } from '../meetings/meeting-service';
import { configStore } from '../config/config-store';
import { resolveWelcomeProfile } from '../welcome/resolve-welcome-profile';
import { formatWelcomeProfileSummary } from '../../shared/welcome-actions';
import {
  DEFAULT_MATTER_RUNTIME,
  type MatterItem,
  type MatterItemActionInput,
  type MatterLens,
  type MatterRuntimeConfig,
  type MatterSnapshot,
} from '../../shared/matter';
// DEFAULT_MATTER_RUNTIME kept for getRuntime fallback
import { log, logError, logWarn } from '../utils/logger';
import { createMatterStore, type MatterStore } from './matter-store';
import { collectMatterSignals, getEnabledMatterServerIds } from './matter-collector';
import { rankMatterSignals } from './matter-ranker';
import { MatterScheduler } from './matter-scheduler';
import { notifyMatterBrief } from './matter-notifications';

const STARTUP_CONNECTOR_WAIT_MS = 120_000;
const STARTUP_CONNECTOR_POLL_MS = 750;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeFocusScore(items: MatterItem[], clearedToday: number): number {
  const critical = items.filter((i) => i.severity === 'critical').length;
  const warning = items.filter((i) => i.severity === 'warning').length;
  const base = 100 - critical * 18 - warning * 8;
  const bonus = Math.min(15, clearedToday * 3);
  return Math.max(0, Math.min(100, Math.round(base + bonus)));
}

function buildLenses(items: MatterItem[], rankedLenses: MatterSnapshot['lenses']): MatterLens[] {
  const labels: Record<MatterLens['id'], string> = {
    delivery: 'Delivery',
    people: 'People',
    clients: 'Clients',
    comms: 'Comms',
    time: 'Time',
    team: 'Team Heat',
  };
  const categoryMap: Record<MatterLens['id'], string[]> = {
    delivery: ['delivery'],
    people: ['people'],
    clients: ['client'],
    comms: ['comms'],
    time: ['time'],
    team: ['people', 'admin'],
  };

  return (['delivery', 'people', 'clients', 'comms', 'time', 'team'] as const).map((id) => {
    const cats = categoryMap[id];
    const matched = items.filter((i) => cats.includes(i.category));
    const ranked = rankedLenses.find((l) => l.id === id);
    const status =
      ranked?.status ||
      (matched.some((m) => m.severity === 'critical')
        ? 'ACTIVE'
        : matched.length
          ? 'MONITORING'
          : 'CLEAR');
    return {
      id,
      label: labels[id],
      status,
      summary:
        ranked?.summary ||
        (matched[0]?.summary ??
          (matched.length ? `${matched.length} items in this lens.` : 'Clear for now.')),
      itemIds: matched.map((m) => m.id),
      count: matched.length,
    };
  });
}

export class MatterService {
  private readonly store: MatterStore;
  private readonly scheduler: MatterScheduler;
  private scanning = false;
  private lastPulse = 'Matter is warming up.';
  private lastBrief: string | null = null;
  private lastLenses: MatterSnapshot['lenses'] = [];
  private lastProfileSummary: string | null = null;
  private morningBriefSentDay: string | null = null;
  private eodSentDay: string | null = null;
  private getMainWindow: (() => BrowserWindow | null) | null = null;

  constructor(
    db: DatabaseInstance,
    private mcpManager: MCPManager | null,
    private meetingService: MeetingService | null
  ) {
    this.store = createMatterStore(db);
    this.scheduler = new MatterScheduler({
      getRuntime: () => this.getRuntime(),
      onTick: (reason) => {
        void this.runScan({ reason, notify: reason !== 'interval' });
      },
      onMorningBrief: () => this.maybeMorningBrief(),
      onEndOfDay: () => this.maybeEndOfDay(),
    });
  }

  setMcpManager(manager: MCPManager | null): void {
    this.mcpManager = manager;
  }

  setMeetingService(service: MeetingService | null): void {
    this.meetingService = service;
  }

  setMainWindowGetter(getter: () => BrowserWindow | null): void {
    this.getMainWindow = getter;
  }

  start(): void {
    this.scheduler.start();
    void this.runStartupScan();
  }

  stop(): void {
    this.scheduler.stop();
  }

  /** First scan after boot: wait for enabled Matter connectors to finish connecting. */
  private async runStartupScan(): Promise<void> {
    const runtime = this.getRuntime();
    if (!runtime.enabled || !this.scheduler.isInScanWindow()) return;
    await this.waitForEnabledConnectors();
    await this.runScan({ reason: 'startup', notify: false });
  }

  private async waitForEnabledConnectors(): Promise<void> {
    const runtime = this.getRuntime();
    const needed = getEnabledMatterServerIds(runtime.sources);
    if (needed.length === 0) return;

    const started = Date.now();
    /** After bootstrap, allow a short grace for connectors that have not started connecting yet. */
    const lateStartGraceMs = 20_000;
    let bootstrapReadyAt: number | null = null;
    log(
      `[Matter] Waiting for enabled connectors before startup scan (${needed.join(', ') || 'none'})…`
    );

    while (Date.now() - started < STARTUP_CONNECTOR_WAIT_MS) {
      const mcp = this.mcpManager;
      if (!mcp) {
        await delay(STARTUP_CONNECTOR_POLL_MS);
        continue;
      }

      const { bootstrapComplete } = mcp.getToolsReadyState();
      if (!bootstrapComplete) {
        await delay(STARTUP_CONNECTOR_POLL_MS);
        continue;
      }
      if (bootstrapReadyAt == null) bootstrapReadyAt = Date.now();

      const statuses = mcp.getServerStatus();
      const byId = new Map(statuses.map((s) => [s.id, s]));
      const pending = needed.filter((id) => {
        const status = byId.get(id);
        if (!status || status.status === 'disabled') return false;
        if (status.connected) return false;
        if (status.status === 'connecting') return true;
        // Not connected yet — wait through grace in case connect starts late
        return Date.now() - (bootstrapReadyAt ?? started) < lateStartGraceMs;
      });

      if (pending.length === 0) {
        const connected = needed.filter((id) => byId.get(id)?.connected).length;
        log(
          `[Matter] Startup connectors settled in ${Date.now() - started}ms (connected ${connected}/${needed.length})`
        );
        return;
      }

      await delay(STARTUP_CONNECTOR_POLL_MS);
    }

    logWarn(
      `[Matter] Timed out after ${STARTUP_CONNECTOR_WAIT_MS}ms waiting for connectors; scanning with current set`
    );
  }

  getRuntime(): MatterRuntimeConfig {
    const config = configStore.getAll();
    return config.matterRuntime || DEFAULT_MATTER_RUNTIME;
  }

  updateRuntime(partial: Partial<MatterRuntimeConfig>): MatterRuntimeConfig {
    const current = this.getRuntime();
    const next: MatterRuntimeConfig = {
      ...current,
      ...partial,
      sources: {
        ...current.sources,
        ...(partial.sources || {}),
      },
    };
    configStore.update({ matterRuntime: next, matterEnabled: next.enabled });
    this.scheduler.reschedule();
    if (!next.enabled) {
      this.lastPulse = 'Matter is disabled.';
      this.lastBrief = null;
    }
    this.pushSnapshot();
    return next;
  }

  getSnapshot(): MatterSnapshot {
    const runtime = this.getRuntime();
    const now = Date.now();
    const items = this.store.listVisibleItems(now).slice(0, runtime.maxActiveItems);
    // Keep pinned in now orbit
    const normalized = items.map((item) =>
      item.pinned && item.orbit !== 'now' ? { ...item, orbit: 'now' as const } : item
    );
    const criticalCount = normalized.filter((i) => i.severity === 'critical').length;
    const warningCount = normalized.filter((i) => i.severity === 'warning').length;
    const healthyCount = normalized.filter((i) => i.severity === 'healthy').length;
    const clearedToday = this.store.countClearedToday(now);
    const connectorHealth = (this.mcpManager?.getServerStatus() || []).map((s) => ({
      id: s.id,
      name: s.name,
      connected: s.connected,
      enabled: s.status !== 'disabled',
    }));
    const connectedCount = connectorHealth.filter((c) => c.connected).length;

    return {
      items: normalized,
      lenses: buildLenses(normalized, this.lastLenses),
      focusScore: computeFocusScore(normalized, clearedToday),
      criticalCount,
      warningCount,
      healthyCount,
      pulse: this.lastPulse,
      lastScan: this.store.getLatestScan(),
      scanning: this.scanning,
      inScanWindow: this.scheduler.isInScanWindow(),
      connectorHealth,
      connectedCount,
      muteRules: this.store.listMuteRules(),
      morningBrief: this.lastBrief,
      settings: runtime,
      profileSummary: this.lastProfileSummary,
    };
  }

  async runScan(options?: {
    reason?: string;
    notify?: boolean;
    force?: boolean;
  }): Promise<MatterSnapshot> {
    if (this.scanning) {
      return this.getSnapshot();
    }
    const runtime = this.getRuntime();
    // Disabled always wins — even manual Scan now / force.
    if (!runtime.enabled) {
      return this.getSnapshot();
    }
    if (!options?.force && !this.scheduler.isInScanWindow()) {
      const scan = this.store.startScan();
      this.store.finishScan(scan.id, {
        status: 'skipped',
        error: 'Outside scan window',
        sourcesChecked: [],
        sourcesSkipped: Object.keys(runtime.sources),
      });
      return this.getSnapshot();
    }

    this.scanning = true;
    this.pushSnapshot();
    const scan = this.store.startScan();
    try {
      const config = configStore.getAll();
      const profile = await resolveWelcomeProfile({ mcpManager: this.mcpManager });
      this.lastProfileSummary = profile ? formatWelcomeProfileSummary(profile) : null;

      const collected = await collectMatterSignals({
        mcpManager: this.mcpManager,
        meetingService: this.meetingService,
        profile,
        sources: runtime.sources,
      });

      const muteRules = this.store.listMuteRules();
      const mutedKeys = new Set(muteRules.map((r) => r.key));
      const filteredSignals = collected.signals.filter((signal) => {
        const keys = [
          signal.fingerprint,
          ...(signal.muteKeys || []),
          `source:${signal.source}`,
          signal.categoryHint ? `category:${signal.categoryHint}` : null,
        ].filter((k): k is string => !!k);
        if (keys.some((k) => mutedKeys.has(k))) return false;
        const existing = this.store.getByFingerprint(signal.fingerprint);
        if (existing?.status === 'dismissed') {
          // allow resurface only if raw excerpt meaningfully changed
          const prevSummary = existing.summary || '';
          if (signal.summary && signal.summary === prevSummary) return false;
        }
        return true;
      });

      const ranked = await rankMatterSignals({
        config,
        profile,
        signals: filteredSignals,
        maxItems: runtime.maxActiveItems,
        sensitivity: runtime.sensitivity,
      });

      // Hard boosts for pinned
      const pinned = this.store.listActiveItems().filter((i) => i.pinned);
      for (const item of ranked.items) {
        if (pinned.some((p) => p.fingerprint === item.fingerprint)) {
          item.orbit = 'now';
          item.rankScore = Math.max(item.rankScore, 95);
        }
      }

      this.store.upsertRankedItems(ranked.items);
      this.store.expireAbsentItems(ranked.items.map((i) => i.fingerprint));
      this.lastPulse = ranked.pulse;
      this.lastBrief = ranked.brief;
      this.lastLenses = ranked.lenses.map((l) => ({
        id: l.id,
        label:
          l.id === 'delivery'
            ? 'Delivery'
            : l.id === 'people'
              ? 'People'
              : l.id === 'clients'
                ? 'Clients'
                : l.id === 'comms'
                  ? 'Comms'
                  : l.id === 'time'
                    ? 'Time'
                    : 'Team Heat',
        status: l.status,
        summary: l.summary,
        itemIds: [],
        count: 0,
      }));

      const snapshot = this.getSnapshot();
      this.store.finishScan(scan.id, {
        status: 'success',
        sourcesChecked: collected.sourcesChecked,
        sourcesSkipped: collected.sourcesSkipped,
        itemCount: snapshot.items.length,
        criticalCount: snapshot.criticalCount,
        warningCount: snapshot.warningCount,
        brief: ranked.brief,
        error: null,
      });

      if (options?.notify && snapshot.criticalCount > 0 && this.scheduler.isInScanWindow()) {
        notifyMatterBrief({
          title: 'Matter — needs you',
          body: snapshot.pulse,
          criticalCount: snapshot.criticalCount,
        });
      }

      log(
        `[Matter] Scan complete (${options?.reason || 'manual'}): ${snapshot.items.length} items, score=${snapshot.focusScore}`
      );
      return this.getSnapshot();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logError('[Matter] Scan failed:', error);
      this.store.finishScan(scan.id, {
        status: 'error',
        error: message,
        itemCount: 0,
        criticalCount: 0,
        warningCount: 0,
      });
      this.lastPulse = 'Scan hit turbulence — try Scan now again.';
      return this.getSnapshot();
    } finally {
      this.scanning = false;
      this.pushSnapshot();
    }
  }

  applyItemAction(input: MatterItemActionInput): MatterSnapshot {
    const item = this.store.getItem(input.itemId);
    if (!item) return this.getSnapshot();
    const now = Date.now();

    if (input.action === 'done') {
      this.store.updateItem(item.id, {
        status: 'done',
        resolvedAt: now,
        pinned: false,
      });
      this.store.recordAction({
        itemId: item.id,
        fingerprint: item.fingerprint,
        action: 'done',
      });
    } else if (input.action === 'dismiss') {
      this.store.updateItem(item.id, {
        status: 'dismissed',
        resolvedAt: now,
        pinned: false,
      });
      this.store.recordAction({
        itemId: item.id,
        fingerprint: item.fingerprint,
        action: 'dismiss',
      });
      if (input.mute) {
        this.store.recordAction({
          itemId: item.id,
          fingerprint: item.fingerprint,
          action: 'mute',
          muteKey: input.mute.key,
          meta: { kind: input.mute.kind, label: input.mute.label },
        });
      }
    } else if (input.action === 'snooze') {
      const until = input.snoozeUntil ?? now + 60 * 60 * 1000;
      this.store.updateItem(item.id, {
        status: 'snoozed',
        snoozeUntil: until,
        pinned: false,
      });
      this.store.recordAction({
        itemId: item.id,
        fingerprint: item.fingerprint,
        action: 'snooze',
        meta: { snoozeUntil: until },
      });
    } else if (input.action === 'pin') {
      this.store.updateItem(item.id, { pinned: true, orbit: 'now', status: 'active' });
      this.store.recordAction({
        itemId: item.id,
        fingerprint: item.fingerprint,
        action: 'pin',
      });
    } else if (input.action === 'unpin') {
      this.store.updateItem(item.id, { pinned: false });
      this.store.recordAction({
        itemId: item.id,
        fingerprint: item.fingerprint,
        action: 'unpin',
      });
    } else if (input.action === 'open') {
      this.store.recordAction({
        itemId: item.id,
        fingerprint: item.fingerprint,
        action: 'open',
      });
    }

    this.pushSnapshot();
    return this.getSnapshot();
  }

  /**
   * Snooze every item currently in the Now orbit (including pinned) in one pass.
   * Unpins so items do not immediately snap back into Now after refresh.
   */
  clearNowOrbit(snoozeMs = 60 * 60 * 1000): MatterSnapshot {
    const snapshot = this.getSnapshot();
    const nowItems = snapshot.items.filter((i) => i.orbit === 'now');
    if (nowItems.length === 0) {
      return snapshot;
    }
    const until = Date.now() + Math.max(60_000, snoozeMs);
    for (const item of nowItems) {
      this.store.updateItem(item.id, {
        status: 'snoozed',
        snoozeUntil: until,
        pinned: false,
      });
      this.store.recordAction({
        itemId: item.id,
        fingerprint: item.fingerprint,
        action: 'snooze',
        meta: { snoozeUntil: until, clearNow: true },
      });
    }
    this.pushSnapshot();
    return this.getSnapshot();
  }

  clearMute(key: string): MatterSnapshot {
    this.store.recordAction({
      action: 'unmute',
      muteKey: key,
      meta: { cleared: true },
    });
    // Soft-clear: record unmute; collector checks only mute actions without later unmute.
    // For simplicity, also store a mute override by re-listing — filter mutes without unmute after.
    this.pushSnapshot();
    return this.getSnapshot();
  }

  buildChatPrompt(prompt: string, itemIds?: string[]): string {
    const snapshot = this.getSnapshot();
    const selected =
      itemIds && itemIds.length
        ? snapshot.items.filter((i) => itemIds.includes(i.id))
        : snapshot.items
            .filter((i) => i.severity === 'critical' || i.severity === 'warning')
            .slice(0, 5);
    const context =
      selected.length === 0
        ? 'No Matter items selected.'
        : selected
            .map(
              (i, idx) =>
                `${idx + 1}. [${i.severity}/${i.source}] ${i.title}\n   Why: ${i.whyItMatters}\n   Suggested: ${i.suggestedAction || 'n/a'}\n   Ref: ${JSON.stringify(i.sourceRef)}\n   Raw: ${(i.rawDetails || '').slice(0, 800)}`
            )
            .join('\n');

    return [
      prompt.trim(),
      '',
      '---',
      'Matter context (use york-os / connected tools to resolve; do not invent sources):',
      `Pulse: ${snapshot.pulse}`,
      `Focus score: ${snapshot.focusScore}`,
      `Profile: ${snapshot.profileSummary || 'unknown'}`,
      context,
    ].join('\n');
  }

  private maybeMorningBrief(): void {
    const runtime = this.getRuntime();
    if (!runtime.morningBriefEnabled || !runtime.enabled) return;
    const day = new Date().toISOString().slice(0, 10);
    if (this.morningBriefSentDay === day) return;
    this.morningBriefSentDay = day;
    void this.runScan({ reason: 'morning', notify: false }).then((snapshot) => {
      notifyMatterBrief({
        title: 'Matter — morning brief',
        body: snapshot.morningBrief || snapshot.pulse,
      });
    });
  }

  private maybeEndOfDay(): void {
    const runtime = this.getRuntime();
    if (!runtime.endOfDayWrapEnabled || !runtime.enabled) return;
    const day = new Date().toISOString().slice(0, 10);
    if (this.eodSentDay === day) return;
    this.eodSentDay = day;
    const snapshot = this.getSnapshot();
    notifyMatterBrief({
      title: 'Matter — end of day',
      body: `${snapshot.criticalCount} critical · ${snapshot.warningCount} warning still open. Focus score ${snapshot.focusScore}.`,
    });
  }

  private pushSnapshot(): void {
    try {
      const win = this.getMainWindow?.();
      if (win && !win.isDestroyed()) {
        win.webContents.send('matter:updated', this.getSnapshot());
      }
    } catch (error) {
      logWarn('[Matter] Failed to push snapshot:', error);
    }
  }
}
