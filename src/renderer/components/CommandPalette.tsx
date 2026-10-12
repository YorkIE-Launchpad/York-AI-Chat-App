import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
  CircleDashed,
  FileDown,
  Ghost,
  Link2,
  Loader2,
  MessageSquare,
  Moon,
  Plug,
  Plus,
  Radar,
  Search,
  Settings,
  Sparkles,
  Workflow,
} from 'lucide-react';
import { useAppStore } from '../store';
import { useIPC } from '../hooks/useIPC';
import { useNavigation } from '../hooks/useNavigation';
import type { ChatSearchHit, ChatSearchScope } from '../../shared/chat-search';
import { chatSearchHitToDivisionFields } from '../../shared/chat-search';
import { activeDivisionFromSession, divisionLabel } from '../../shared/workspace-division';
import { getInitialSessionTitle } from '../../shared/session-title';

const isMac = typeof window !== 'undefined' && window.electronAPI?.platform === 'darwin';
export const MOD = isMac ? '⌘' : 'Ctrl+';
const SHIFT = isMac ? '⇧' : 'Shift+';

export const OPEN_PALETTE_EVENT = 'growthos:open-palette';
export const SIDEBAR_IMPORT_EVENT = 'growthos:import-chat';
export const SIDEBAR_JOIN_EVENT = 'growthos:join-shared-chat';

interface PaletteRow {
  id: string;
  section: 'ask' | 'jump' | 'chats' | 'actions';
  label: string;
  sublabel?: string;
  badge?: string;
  icon: ReactNode;
  hint?: string;
  keywords?: string;
  run: () => unknown;
}

function formatHitDate(timestamp: number): string {
  if (!timestamp) return '';
  try {
    return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const nav = useNavigation();
  const { startSession } = useIPC();
  const activeDivision = useAppStore((s) => s.activeDivision);
  const sessions = useAppStore((s) => s.sessions);
  const workingDir = useAppStore((s) => s.workingDir);
  const defaultWorkingDir = useAppStore((s) => s.defaultWorkingDir);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const theme = useAppStore((s) => s.settings.theme);
  const matterEnabled =
    useAppStore((s) => s.appConfig?.matterEnabled ?? s.appConfig?.matterRuntime?.enabled) !== false;

  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<ChatSearchHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [scope, setScope] = useState<ChatSearchScope>('workspace');
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setHits([]);
      setScope('workspace');
      setIndex(0);
      return;
    }
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  const trimmed = query.trim();

  useEffect(() => {
    if (!open || !trimmed || !window.electronAPI?.session?.searchChats) {
      setHits([]);
      setBusy(false);
      return;
    }
    let cancelled = false;
    setBusy(true);
    const timer = window.setTimeout(() => {
      void window.electronAPI.session
        .searchChats(trimmed, 12, { scope, activeDivision })
        .then((next) => {
          if (!cancelled) setHits(next);
        })
        .catch(() => {
          if (!cancelled) setHits([]);
        })
        .finally(() => {
          if (!cancelled) setBusy(false);
        });
    }, 160);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, trimmed, scope, activeDivision]);

  const rows = useMemo<PaletteRow[]>(() => {
    const q = trimmed.toLowerCase();
    const matches = (row: PaletteRow) =>
      !q || `${row.label} ${row.keywords ?? ''}`.toLowerCase().includes(q);

    const ask: PaletteRow[] = trimmed
      ? [
          {
            id: 'ask',
            section: 'ask',
            label: t('palette.askQuery', { query: trimmed }),
            sublabel: activeDivision
              ? t('palette.askIn', { workspace: divisionLabel(activeDivision) })
              : undefined,
            icon: <Sparkles className="h-4 w-4 text-accent-text" />,
            hint: '↵',
            run: async () => {
              await startSession(
                getInitialSessionTitle(trimmed),
                [{ type: 'text', text: trimmed }],
                workingDir || defaultWorkingDir || undefined
              );
            },
          },
        ]
      : [];

    const jump: PaletteRow[] = (
      [
        {
          id: 'today',
          section: 'jump' as const,
          label: t('nav.today'),
          icon: <Radar className="h-4 w-4" />,
          hint: `${MOD}1`,
          keywords: 'home matter radar briefing',
          run: nav.goToday,
        },
        {
          id: 'followups',
          section: 'jump' as const,
          label: t('nav.followUps'),
          icon: <CircleDashed className="h-4 w-4" />,
          hint: `${MOD}2`,
          keywords: 'loops commitments promises waiting',
          run: () => nav.openFollowUps(),
        },
        {
          id: 'automations',
          section: 'jump' as const,
          label: t('nav.automations'),
          icon: <Workflow className="h-4 w-4" />,
          hint: `${MOD}3`,
          keywords: 'workflows schedules scheduled tasks',
          run: () => nav.openAutomations(),
        },
        {
          id: 'settings',
          section: 'jump' as const,
          label: t('nav.settings'),
          icon: <Settings className="h-4 w-4" />,
          hint: `${MOD},`,
          keywords: 'preferences',
          run: () => nav.openSettings(),
        },
        {
          id: 'apps',
          section: 'jump' as const,
          label: t('palette.appsAndData'),
          icon: <Plug className="h-4 w-4" />,
          keywords: 'connectors mcp tools integrations slack gmail jira',
          run: () => nav.openSettings('connectors'),
        },
      ] as PaletteRow[]
    ).filter(matches);

    const recent: PaletteRow[] = trimmed
      ? hits.map((hit) => ({
          id: `hit:${hit.sessionId}:${hit.messageId ?? 'title'}`,
          section: 'chats' as const,
          label: hit.title,
          sublabel: hit.snippet && hit.snippet !== hit.title ? hit.snippet : undefined,
          badge: `${divisionLabel(activeDivisionFromSession(chatSearchHitToDivisionFields(hit)))} · ${formatHitDate(hit.timestamp)}`,
          icon: <MessageSquare className="h-4 w-4" />,
          run: () => nav.openChat(hit.sessionId),
        }))
      : [...sessions]
          .filter((s) => !s.incognito)
          .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
          .slice(0, 5)
          .map((s) => ({
            id: `recent:${s.id}`,
            section: 'chats' as const,
            label: s.title,
            badge: divisionLabel(activeDivisionFromSession(s)),
            icon: <MessageSquare className="h-4 w-4" />,
            run: () => nav.openChat(s.id),
          }));

    const actions: PaletteRow[] = (
      [
        {
          id: 'new',
          section: 'actions' as const,
          label: t('palette.newChat'),
          icon: <Plus className="h-4 w-4" />,
          hint: `${MOD}N`,
          run: () => nav.newChat(),
        },
        {
          id: 'new-private',
          section: 'actions' as const,
          label: t('palette.newPrivateChat'),
          icon: <Ghost className="h-4 w-4" />,
          hint: `${SHIFT}${MOD}N`,
          keywords: 'incognito',
          run: () => nav.newChat({ private: true }),
        },
        {
          id: 'import',
          section: 'actions' as const,
          label: t('sidebar.importChat'),
          icon: <FileDown className="h-4 w-4" />,
          run: () => window.dispatchEvent(new Event(SIDEBAR_IMPORT_EVENT)),
        },
        {
          id: 'join',
          section: 'actions' as const,
          label: t('sidebar.joinSharedChat'),
          icon: <Link2 className="h-4 w-4" />,
          run: () => window.dispatchEvent(new Event(SIDEBAR_JOIN_EVENT)),
        },
        ...(matterEnabled
          ? [
              {
                id: 'scan',
                section: 'actions' as const,
                label: t('palette.checkNow'),
                icon: <Radar className="h-4 w-4" />,
                keywords: 'scan matter refresh',
                run: () => {
                  nav.goToday();
                  void window.electronAPI?.matter?.scanNow();
                },
              },
            ]
          : []),
        {
          id: 'theme',
          section: 'actions' as const,
          label: t('palette.toggleTheme'),
          icon: <Moon className="h-4 w-4" />,
          keywords: 'dark light appearance',
          run: () =>
            updateSettings({
              theme: theme === 'dark' ? 'light' : theme === 'light' ? 'system' : 'dark',
            }),
        },
      ] as PaletteRow[]
    ).filter(matches);

    return [...ask, ...jump, ...recent, ...actions];
  }, [
    activeDivision,
    defaultWorkingDir,
    hits,
    matterEnabled,
    nav,
    sessions,
    startSession,
    t,
    theme,
    trimmed,
    updateSettings,
    workingDir,
  ]);

  useEffect(() => {
    setIndex((i) => Math.min(i, Math.max(rows.length - 1, 0)));
  }, [rows.length]);

  useEffect(() => {
    setIndex(0);
  }, [trimmed]);

  const choose = useCallback(
    (row: PaletteRow) => {
      onClose();
      void row.run();
    },
    [onClose]
  );

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setIndex((i) => Math.min(i + 1, rows.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter' && !e.isComposing) {
        const row = rows[index];
        if (row) {
          e.preventDefault();
          choose(row);
        }
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [choose, index, onClose, open, rows]);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-palette-index="${index}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  if (!open) return null;

  const sectionLabel: Record<PaletteRow['section'], string> = {
    ask: t('palette.section.ask'),
    jump: t('palette.section.jump'),
    chats: trimmed ? t('palette.section.chatResults') : t('palette.section.recent'),
    actions: t('palette.section.actions'),
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-start justify-center bg-black/35 p-4 pt-[12vh] animate-fade-in"
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('palette.title')}
        onMouseDown={(e) => e.stopPropagation()}
        className="flex max-h-[70vh] w-full max-w-[620px] flex-col overflow-hidden rounded-[14px] border border-border-subtle bg-surface-raised shadow-elevated animate-slide-up"
      >
        <div className="flex items-center gap-3 border-b border-border-subtle px-4 py-3">
          <Search className="h-4 w-4 shrink-0 text-text-muted" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('palette.placeholder')}
            className="min-w-0 flex-1 bg-transparent text-[15px] text-text-primary outline-none placeholder:text-text-muted"
            aria-label={t('palette.placeholder')}
          />
          {busy ? <Loader2 className="h-4 w-4 animate-spin text-text-muted" /> : null}
          {trimmed ? (
            <button
              type="button"
              onClick={() => setScope((s) => (s === 'workspace' ? 'all' : 'workspace'))}
              className={`rounded-md border px-2 py-0.5 text-[11px] font-medium transition-colors ${
                scope === 'all'
                  ? 'border-accent/40 bg-accent-muted text-accent-text'
                  : 'border-border-subtle text-text-muted hover:bg-surface-hover'
              }`}
              title={scope === 'all' ? t('palette.scopeAllHint') : t('palette.scopeHereHint')}
            >
              {scope === 'all' ? t('palette.scopeAll') : t('palette.scopeHere')}
            </button>
          ) : null}
          <span className="kbd">esc</span>
        </div>
        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {rows.length === 0 ? (
            <p className="px-3 py-8 text-center text-[13px] text-text-muted">
              {busy ? t('common.loading') : t('palette.empty')}
            </p>
          ) : (
            rows.map((row, i) => {
              const showHeader = i === 0 || rows[i - 1].section !== row.section;
              return (
                <div key={row.id}>
                  {showHeader ? (
                    <div className="px-2.5 pb-1 pt-2.5 text-[11px] font-semibold uppercase tracking-[0.05em] text-text-muted">
                      {sectionLabel[row.section]}
                    </div>
                  ) : null}
                  <button
                    type="button"
                    data-palette-index={i}
                    onMouseMove={() => setIndex(i)}
                    onClick={() => choose(row)}
                    className={`flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors ${
                      i === index ? 'bg-surface-hover' : ''
                    }`}
                  >
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center text-text-muted">
                      {row.icon}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13.5px] text-text-primary">
                        {row.label}
                      </span>
                      {row.sublabel ? (
                        <span className="block truncate text-[12px] text-text-muted">
                          {row.sublabel}
                        </span>
                      ) : null}
                    </span>
                    {row.badge ? (
                      <span className="shrink-0 text-[11px] text-text-muted">{row.badge}</span>
                    ) : null}
                    {row.hint ? <span className="kbd shrink-0">{row.hint}</span> : null}
                  </button>
                </div>
              );
            })
          )}
        </div>
        <div className="flex items-center gap-4 border-t border-border-subtle px-4 py-2 text-[11.5px] text-text-muted">
          <span className="inline-flex items-center gap-1">
            <span className="kbd">↑</span>
            <span className="kbd">↓</span>
            {t('palette.footer.move')}
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="kbd">↵</span>
            {t('palette.footer.open')}
          </span>
          <span className="ml-auto">
            {t('palette.footer.anywhere', { shortcut: `${SHIFT}${MOD}Space` })}
          </span>
        </div>
      </div>
    </div>,
    document.body
  );
}

/** ⌘K palette, ⌘N / ⇧⌘N new chat, ⌘1–3 pages. ⌘, comes from the app menu. */
export function useAppShortcuts(openPalette: () => void) {
  const nav = useNavigation();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === 'k' && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        openPalette();
      } else if (key === 'n') {
        e.preventDefault();
        nav.newChat({ private: e.shiftKey });
      } else if (!e.shiftKey && (key === '1' || key === '2' || key === '3')) {
        e.preventDefault();
        if (key === '1') nav.goToday();
        else if (key === '2') nav.openFollowUps();
        else nav.openAutomations();
      } else if (!e.shiftKey && key === ',' && !isMac) {
        e.preventDefault();
        nav.openSettings();
      }
    };
    const onOpen = () => openPalette();
    document.addEventListener('keydown', onKey, true);
    window.addEventListener(OPEN_PALETTE_EVENT, onOpen);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener(OPEN_PALETTE_EVENT, onOpen);
    };
  }, [nav, openPalette]);
}
