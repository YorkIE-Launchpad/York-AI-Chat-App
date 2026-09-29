import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CalendarClock,
  Check,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Loader2,
  Radar,
  RotateCcw,
  Sparkles,
  Users,
  Video,
  X,
} from 'lucide-react';
import type { Loop } from '../../../shared/loops';
import { loopDueBucket } from '../../../shared/loops';
import { MessageMarkdown } from '../MessageMarkdown';
import { LoopDuePicker } from './LoopDuePicker';

interface LoopRowProps {
  loop: Loop;
  onClose: (id: string) => void;
  onDrop: (id: string) => void;
  onReopen: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onSetDue: (id: string, dueAt: number | null) => void;
  onOpenSource: (loop: Loop) => void;
  onResearch: (id: string) => void;
}

export function LoopRow({
  loop,
  onClose,
  onDrop,
  onReopen,
  onRename,
  onSetDue,
  onOpenSource,
  onResearch,
}: LoopRowProps) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(loop.title);
  const [editingDue, setEditingDue] = useState(false);
  const dueButtonRef = useRef<HTMLButtonElement>(null);
  const closeDuePicker = useCallback(() => setEditingDue(false), []);
  const [notesOpen, setNotesOpen] = useState(false);
  const researching = loop.researchStatus === 'running';
  const hasNote = Boolean(loop.researchNote?.trim());
  const researchedEmpty = loop.researchStatus === 'done' && !hasNote;

  useEffect(() => {
    if (hasNote && loop.researchedAt) setNotesOpen(true);
  }, [hasNote, loop.researchedAt]);

  const inputRef = useRef<HTMLInputElement>(null);
  const open = loop.status === 'open';
  const bucket = loopDueBucket(loop.dueAt);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  useEffect(() => {
    if (!editing) setDraft(loop.title);
  }, [loop.title, editing]);

  const commitRename = () => {
    setEditing(false);
    const next = draft.trim();
    if (next && next !== loop.title) onRename(loop.id, next);
    else setDraft(loop.title);
  };

  const dueLabel =
    loop.dueAt != null
      ? new Date(loop.dueAt).toLocaleDateString(undefined, {
          weekday: 'short',
          month: 'short',
          day: 'numeric',
        })
      : t('loops.noDue');

  const sourceIcon =
    loop.origin === 'meeting' ? (
      <Video className="w-3 h-3" />
    ) : loop.origin === 'matter' ? (
      <Radar className="w-3 h-3" />
    ) : null;
  const hasSource = Boolean(loop.sourceRef.matterItemId || loop.sourceRef.meetingId);

  return (
    <div className="group flex items-start gap-2.5 rounded-xl border border-border-subtle bg-background px-3 py-2 hover:border-border-muted">
      <button
        type="button"
        onClick={() => (open ? onClose(loop.id) : onReopen(loop.id))}
        className={`mt-0.5 h-4 w-4 shrink-0 rounded-full border flex items-center justify-center transition-colors ${
          open
            ? 'border-text-muted hover:border-accent hover:bg-accent/10'
            : 'border-accent bg-accent text-white'
        }`}
        title={open ? t('loops.close') : t('loops.reopen')}
        aria-label={open ? t('loops.close') : t('loops.reopen')}
      >
        {open ? null : <Check className="w-3 h-3" />}
      </button>

      <div className="min-w-0 flex-1">
        {editing ? (
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename();
              if (e.key === 'Escape') {
                setDraft(loop.title);
                setEditing(false);
              }
            }}
            className="w-full bg-transparent text-[13px] text-text-primary outline-none border-b border-accent/50"
          />
        ) : (
          <button
            type="button"
            onClick={() => open && setEditing(true)}
            className={`block w-full text-left text-[13px] leading-snug ${
              open ? 'text-text-primary' : 'text-text-muted line-through'
            }`}
          >
            {loop.title}
          </button>
        )}
        {loop.notes ? (
          <p className="mt-0.5 text-[11px] text-text-muted line-clamp-2">{loop.notes}</p>
        ) : null}

        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10px]">
          <button
            ref={dueButtonRef}
            type="button"
            disabled={!open}
            onClick={() => setEditingDue((v) => !v)}
            aria-haspopup="dialog"
            aria-expanded={editingDue}
            className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 border transition-colors ${
              editingDue
                ? 'border-accent/50 text-accent'
                : open && bucket === 'overdue' && loop.dueAt != null
                  ? 'border-red-500/40 text-red-500'
                  : open && bucket === 'today'
                    ? 'border-amber-500/40 text-amber-600'
                    : 'border-border-subtle text-text-muted'
            } ${open ? 'hover:border-accent/40' : ''}`}
          >
            <CalendarClock className="w-3 h-3" />
            {dueLabel}
          </button>
          {editingDue && dueButtonRef.current ? (
            <LoopDuePicker
              anchor={dueButtonRef.current}
              value={loop.dueAt}
              onDismiss={closeDuePicker}
              onSelect={(dueAt) => {
                setEditingDue(false);
                if (dueAt !== loop.dueAt) onSetDue(loop.id, dueAt);
              }}
            />
          ) : null}
          {loop.counterpart ? (
            <span className="inline-flex items-center gap-1 rounded-md border border-border-subtle px-1.5 py-0.5 text-text-muted">
              <Users className="w-3 h-3" />
              {loop.counterpart}
            </span>
          ) : null}
          {hasSource ? (
            <button
              type="button"
              onClick={() => onOpenSource(loop)}
              className="inline-flex items-center gap-1 rounded-md border border-border-subtle px-1.5 py-0.5 text-text-muted hover:text-accent hover:border-accent/40 max-w-[220px]"
              title={t('loops.openSource')}
            >
              {sourceIcon}
              <span className="truncate">
                {loop.sourceRef.label ||
                  (loop.origin === 'meeting' ? t('loops.originMeeting') : t('loops.originMatter'))}
              </span>
            </button>
          ) : null}
          {loop.autoCaptured ? (
            <span className="text-text-muted opacity-70">{t('loops.autoCaptured')}</span>
          ) : null}
          {researching ? (
            <span className="inline-flex items-center gap-1 text-accent">
              <Loader2 className="w-3 h-3 animate-spin" />
              {t('loops.researching')}
            </span>
          ) : open ? (
            <button
              type="button"
              onClick={() => onResearch(loop.id)}
              className="inline-flex items-center gap-1 rounded-md border border-accent/30 bg-accent/10 px-1.5 py-0.5 text-accent hover:bg-accent/20"
              title={t('loops.generateHint')}
            >
              <Sparkles className="w-3 h-3" />
              {hasNote || researchedEmpty ? t('loops.regenerate') : t('loops.generate')}
            </button>
          ) : null}
        </div>

        {loop.researchStatus === 'error' && !researching ? (
          <p className="mt-1.5 text-[11px] text-red-500">
            {t('loops.researchFailed')}
            {loop.researchError ? `: ${loop.researchError}` : ''}
          </p>
        ) : null}

        {researchedEmpty && !researching ? (
          <p className="mt-1.5 text-[11px] text-text-muted">{t('loops.researchEmpty')}</p>
        ) : null}

        {hasNote ? (
          <div className="mt-2">
            <button
              type="button"
              onClick={() => setNotesOpen((v) => !v)}
              className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-text-muted hover:text-text-secondary"
            >
              {notesOpen ? (
                <ChevronDown className="w-3 h-3" />
              ) : (
                <ChevronRight className="w-3 h-3" />
              )}
              {t('loops.notesLabel')}
              {loop.researchSources.length ? (
                <span className="opacity-70">
                  · {t('loops.sourceCount', { count: loop.researchSources.length })}
                </span>
              ) : null}
            </button>
            {notesOpen ? (
              <div className="mt-1.5 rounded-lg border border-border-subtle bg-surface/60 px-3 py-2">
                <div className="text-[12px] leading-relaxed">
                  <MessageMarkdown normalizedText={loop.researchNote || ''} tone="thinking" />
                </div>
                {loop.researchSources.length ? (
                  <ul className="mt-2 space-y-0.5 border-t border-border-subtle pt-2 text-[10px] text-text-muted">
                    {loop.researchSources.map((source) => (
                      <li key={source.id} className="flex items-center gap-1.5 min-w-0">
                        <span className="shrink-0 font-mono text-text-secondary">{source.id}</span>
                        {source.url ? (
                          <button
                            type="button"
                            onClick={() => void window.electronAPI?.openExternal?.(source.url!)}
                            className="inline-flex min-w-0 items-center gap-1 hover:text-accent"
                          >
                            <span className="truncate">{source.title}</span>
                            <ExternalLink className="w-2.5 h-2.5 shrink-0" />
                          </button>
                        ) : (
                          <span className="truncate">{source.title}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {open ? (
        <button
          type="button"
          onClick={() => onDrop(loop.id)}
          className="mt-0.5 rounded-md p-1 text-text-muted opacity-0 group-hover:opacity-100 hover:bg-surface-hover hover:text-text-primary transition-opacity"
          title={t('loops.drop')}
          aria-label={t('loops.drop')}
        >
          <X className="w-3.5 h-3.5" />
        </button>
      ) : (
        <button
          type="button"
          onClick={() => onReopen(loop.id)}
          className="mt-0.5 rounded-md p-1 text-text-muted opacity-0 group-hover:opacity-100 hover:bg-surface-hover hover:text-text-primary transition-opacity"
          title={t('loops.reopen')}
          aria-label={t('loops.reopen')}
        >
          <RotateCcw className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}
