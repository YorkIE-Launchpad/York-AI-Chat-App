import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { RefreshCw, Settings, X, Radio, Activity, Gauge, Plug, Eraser } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { MatterItem, MatterLensId, MatterSnapshot } from '../../../shared/matter';
import { DEFAULT_MATTER_RUNTIME } from '../../../shared/matter';
import { useAppStore } from '../../store';
import { useIPC } from '../../hooks/useIPC';
import { MatterRadar } from './MatterRadar';
import { MatterSignalCard } from './MatterSignalCard';
import { MatterLenses } from './MatterLenses';
import { MatterAskBar } from './MatterAskBar';
import { MatterItemDetail } from './MatterItemDetail';

const EMPTY_SNAPSHOT: MatterSnapshot = {
  items: [],
  lenses: [],
  focusScore: 100,
  criticalCount: 0,
  warningCount: 0,
  healthyCount: 0,
  pulse: 'Matter is warming up.',
  lastScan: null,
  scanning: false,
  inScanWindow: true,
  connectorHealth: [],
  connectedCount: 0,
  muteRules: [],
  morningBrief: null,
  settings: DEFAULT_MATTER_RUNTIME,
  profileSummary: null,
};

interface MatterPageProps {
  onClose: () => void;
}

export function MatterPage({ onClose }: MatterPageProps) {
  const { t } = useTranslation();
  const { startSession } = useIPC();
  const workingDir = useAppStore((s) => s.workingDir);
  const setSettingsTab = useAppStore((s) => s.setSettingsTab);
  const setShowSettings = useAppStore((s) => s.setShowSettings);
  const setMatterBadgeCount = useAppStore((s) => s.setMatterBadgeCount);

  const [snapshot, setSnapshot] = useState<MatterSnapshot>(EMPTY_SNAPSHOT);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeLens, setActiveLens] = useState<MatterLensId | null>(null);
  const [clearingNow, setClearingNow] = useState(false);
  const [busy, setBusy] = useState(false);

  const applySnapshot = useCallback(
    (next: MatterSnapshot) => {
      setSnapshot(next);
      setMatterBadgeCount(next.settings.enabled ? next.criticalCount : 0);
    },
    [setMatterBadgeCount]
  );

  const matterEnabled = snapshot.settings.enabled !== false;

  const refresh = useCallback(async () => {
    if (!window.electronAPI?.matter) return;
    const next = await window.electronAPI.matter.getSnapshot();
    applySnapshot(next);
  }, [applySnapshot]);

  useEffect(() => {
    void refresh();
    if (!window.electronAPI?.matter) return;
    return window.electronAPI.matter.onUpdated(applySnapshot);
  }, [refresh, applySnapshot]);

  const filteredItems = useMemo(() => {
    if (!activeLens) return snapshot.items;
    const lens = snapshot.lenses.find((l) => l.id === activeLens);
    if (!lens) return snapshot.items;
    const ids = new Set(lens.itemIds);
    return snapshot.items.filter((i) => ids.has(i.id));
  }, [snapshot.items, snapshot.lenses, activeLens]);

  const highlightedIds = useMemo(() => new Set(filteredItems.map((i) => i.id)), [filteredItems]);

  const selectedItem = useMemo(
    () => snapshot.items.find((item) => item.id === selectedId) ?? null,
    [snapshot.items, selectedId]
  );

  useEffect(() => {
    if (selectedId && !selectedItem) {
      setSelectedId(null);
    }
  }, [selectedId, selectedItem]);

  const runAction = async (
    item: MatterItem,
    action: 'done' | 'dismiss' | 'snooze' | 'pin' | 'unpin' | 'open',
    mute?: boolean
  ) => {
    if (!window.electronAPI?.matter) return;
    const next = await window.electronAPI.matter.applyAction({
      itemId: item.id,
      action: action === 'pin' && item.pinned ? 'unpin' : action === 'unpin' ? 'unpin' : action,
      snoozeUntil: action === 'snooze' ? Date.now() + 60 * 60 * 1000 : undefined,
      mute: mute
        ? {
            kind: 'fingerprint',
            key: item.fingerprint,
            label: item.title,
          }
        : null,
    });
    applySnapshot(next);
    if (action === 'done' || action === 'dismiss' || action === 'snooze') {
      setSelectedId((current) => (current === item.id ? null : current));
    }
    if (action === 'open') {
      const url =
        item.sourceRef.url?.trim() ||
        item.rawDetails?.match(/https?:\/\/[^\s"'<>)\\]]+/i)?.[0]?.replace(/[.,;:]+$/, '');
      if (url) {
        await window.electronAPI.openExternal(url);
      }
    }
  };

  const handleChat = async (prompt: string, itemIds?: string[]) => {
    if (!window.electronAPI?.matter) return;
    setBusy(true);
    try {
      const built = await window.electronAPI.matter.buildChatPrompt(prompt, itemIds);
      await startSession('Matter', built.prompt, workingDir || undefined);
    } finally {
      setBusy(false);
    }
  };

  const scanNow = async () => {
    if (!window.electronAPI?.matter || !matterEnabled) return;
    setBusy(true);
    try {
      const next = await window.electronAPI.matter.scanNow();
      applySnapshot(next);
    } finally {
      setBusy(false);
    }
  };

  const clearNowOrbit = async () => {
    const nowItems = snapshot.items.filter((i) => i.orbit === 'now');
    if (nowItems.length === 0) return;
    setClearingNow(true);
    try {
      for (const item of nowItems) {
        await runAction(item, 'snooze');
      }
    } finally {
      setClearingNow(false);
    }
  };

  const openSettings = () => {
    setSettingsTab('matter');
    setShowSettings(true);
  };

  const lastScanLabel = snapshot.lastScan?.finishedAt
    ? `${Math.max(0, Math.round((Date.now() - snapshot.lastScan.finishedAt) / 60000))}m ago`
    : 'never';

  return (
    <div className="h-full min-h-0 flex flex-col bg-background overflow-hidden">
      <header className="shrink-0 border-b border-border-muted px-4 py-3 flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="text-base font-semibold text-text-primary tracking-tight">
              {t('matter.title')}
            </h1>
            <span className="text-[11px] text-text-muted truncate">
              {snapshot.profileSummary || t('matter.subtitle')}
            </span>
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <StatusPill
              icon={<Activity className="w-3 h-3" />}
              label={snapshot.inScanWindow ? t('matter.statusActive') : t('matter.statusQuiet')}
            />
            <StatusPill
              icon={<Radio className="w-3 h-3" />}
              label={
                snapshot.scanning
                  ? t('matter.scanning')
                  : t('matter.lastScan', { when: lastScanLabel })
              }
            />
            <StatusPill
              icon={<Gauge className="w-3 h-3" />}
              label={t('matter.focusScore', { score: snapshot.focusScore })}
            />
            <StatusPill
              icon={<Plug className="w-3 h-3" />}
              label={t('matter.connectors', { count: snapshot.connectedCount })}
            />
          </div>
        </div>
        <button
          type="button"
          onClick={() => void scanNow()}
          disabled={!matterEnabled || busy || snapshot.scanning}
          className="h-9 px-3 rounded-xl border border-border-muted text-sm text-text-secondary hover:bg-surface-hover flex items-center gap-1.5 disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${snapshot.scanning || busy ? 'animate-spin' : ''}`} />
          {t('matter.scanNow')}
        </button>
        <button
          type="button"
          onClick={() => void clearNowOrbit()}
          disabled={clearingNow || !snapshot.items.some((i) => i.orbit === 'now')}
          className="h-9 px-3 rounded-xl border border-border-muted text-sm text-text-secondary hover:bg-surface-hover flex items-center gap-1.5 disabled:opacity-50"
          title={t('matter.clearNow')}
        >
          <Eraser className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          onClick={openSettings}
          className="h-9 w-9 rounded-xl border border-border-muted flex items-center justify-center text-text-secondary hover:bg-surface-hover"
          title={t('matter.settings')}
        >
          <Settings className="w-4 h-4" />
        </button>
        <button
          type="button"
          onClick={onClose}
          className="h-9 w-9 rounded-xl border border-border-muted flex items-center justify-center text-text-secondary hover:bg-surface-hover"
          title={t('common.close')}
        >
          <X className="w-4 h-4" />
        </button>
      </header>

      {!matterEnabled ? (
        <div className="shrink-0 mx-4 mt-3 rounded-xl border border-border-muted bg-surface/80 px-3 py-2 text-[12px] text-text-secondary">
          {t('matter.disabledBanner')}{' '}
          <button
            type="button"
            onClick={openSettings}
            className="text-accent underline underline-offset-2"
          >
            {t('matter.settings')}
          </button>
        </div>
      ) : null}

      {snapshot.morningBrief && snapshot.items.length > 0 ? (
        <div className="shrink-0 mx-4 mt-3 rounded-xl border border-accent/20 bg-accent-muted/10 px-3 py-2 text-[12px] text-text-secondary">
          <span className="font-semibold text-accent mr-2">{t('matter.morningBrief')}</span>
          {snapshot.morningBrief}
        </div>
      ) : null}

      <div className="flex-1 min-h-0 grid grid-cols-1 xl:grid-cols-[280px_minmax(0,1fr)_280px] gap-0">
        <section className="min-h-0 border-r border-border-muted flex flex-col px-3 py-3">
          <div className="flex items-center justify-between px-1 mb-3">
            <h2 className="text-[11px] font-semibold tracking-[0.18em] text-text-muted uppercase">
              {t('matter.signals')}
            </h2>
            <span className="text-[10px] rounded-full border border-border-subtle px-2 py-0.5 text-text-muted">
              {filteredItems.length}
            </span>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto space-y-2 pr-1">
            {filteredItems.length === 0 ? (
              <EmptySignals
                connectedCount={snapshot.connectedCount}
                onConnectors={() => {
                  setSettingsTab('connectors');
                  setShowSettings(true);
                }}
              />
            ) : (
              filteredItems.map((item) => (
                <MatterSignalCard
                  key={item.id}
                  item={item}
                  selected={selectedId === item.id}
                  onSelect={() => setSelectedId(item.id)}
                  onDone={() => void runAction(item, 'done')}
                  onDismiss={(mute) => void runAction(item, 'dismiss', mute)}
                  onSnooze={() => void runAction(item, 'snooze')}
                  onPin={() => void runAction(item, item.pinned ? 'unpin' : 'pin')}
                  onOpen={() => void runAction(item, 'open')}
                  onHandleChat={() =>
                    void handleChat(`Help me resolve this Matter item: ${item.title}`, [item.id])
                  }
                />
              ))
            )}
          </div>
        </section>

        <section className="min-h-0 flex flex-col items-center px-4 py-4 relative overflow-y-auto">
          <div
            className={`w-full flex flex-col items-center ${selectedItem ? 'shrink-0' : 'flex-1 justify-center'}`}
          >
            <div className={selectedItem ? 'w-full max-w-[280px]' : 'w-full max-w-[420px]'}>
              <MatterRadar
                items={snapshot.items}
                selectedId={selectedId}
                highlightedIds={activeLens ? highlightedIds : new Set()}
                pulse={snapshot.pulse}
                onSelect={setSelectedId}
              />
            </div>
            <div className="mt-3 flex items-center gap-6 text-[11px] font-semibold tracking-wide">
              <span className="text-red-400">{snapshot.criticalCount} CRITICAL</span>
              <span className="text-amber-400">{snapshot.warningCount} WARNING</span>
              <span className="text-emerald-400">{snapshot.healthyCount} HEALTHY</span>
            </div>
          </div>

          {selectedItem ? (
            <div className="mt-4 w-full flex justify-center pb-2">
              <MatterItemDetail
                item={selectedItem}
                onClose={() => setSelectedId(null)}
                onDone={() => void runAction(selectedItem, 'done')}
                onDismiss={(mute) => void runAction(selectedItem, 'dismiss', mute)}
                onSnooze={() => void runAction(selectedItem, 'snooze')}
                onPin={() => void runAction(selectedItem, selectedItem.pinned ? 'unpin' : 'pin')}
                onOpen={() => void runAction(selectedItem, 'open')}
                onHandleChat={() =>
                  void handleChat(`Help me resolve this Matter item: ${selectedItem.title}`, [
                    selectedItem.id,
                  ])
                }
              />
            </div>
          ) : null}
        </section>

        <section className="min-h-0 border-l border-border-muted px-3 py-3">
          <MatterLenses lenses={snapshot.lenses} activeLens={activeLens} onSelect={setActiveLens} />
        </section>
      </div>

      <MatterAskBar
        disabled={busy}
        onAsk={(prompt) =>
          void handleChat(
            prompt,
            selectedId ? [selectedId] : snapshot.items.slice(0, 5).map((i) => i.id)
          )
        }
      />
    </div>
  );
}

function StatusPill({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border-subtle bg-surface/60 px-2.5 py-1 text-[11px] text-text-secondary">
      {icon}
      {label}
    </span>
  );
}

function EmptySignals({
  connectedCount,
  onConnectors,
}: {
  connectedCount: number;
  onConnectors: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="rounded-xl border border-dashed border-border-muted px-3 py-6 text-center">
      <p className="text-sm text-text-primary font-medium">{t('matter.emptyTitle')}</p>
      <p className="mt-1 text-[12px] text-text-muted">
        {connectedCount === 0 ? t('matter.emptyNoConnectors') : t('matter.emptyQuiet')}
      </p>
      {connectedCount === 0 ? (
        <button
          type="button"
          onClick={onConnectors}
          className="mt-3 text-[12px] font-medium text-accent hover:underline"
        >
          {t('matter.wireConnectors')}
        </button>
      ) : null}
    </div>
  );
}
