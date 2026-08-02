import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import {
  Check,
  Clock3,
  MessageSquare,
  Pin,
  PinOff,
  X,
  ExternalLink,
  Ban,
  MoreHorizontal,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { MatterItem } from '../../../shared/matter';

const SEVERITY_DOT: Record<string, string> = {
  critical: 'bg-red-500',
  warning: 'bg-amber-500',
  healthy: 'bg-emerald-500',
  signal: 'bg-accent',
};

function relativeTime(ts: number): string {
  const delta = Date.now() - ts;
  const mins = Math.floor(delta / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

interface MatterSignalCardProps {
  item: MatterItem;
  selected: boolean;
  onSelect: () => void;
  onDone: () => void;
  onDismiss: (mute?: boolean) => void;
  onSnooze: () => void;
  onPin: () => void;
  onOpen: () => void;
  onHandleChat: () => void;
}

export function MatterSignalCard({
  item,
  selected,
  onSelect,
  onDone,
  onDismiss,
  onSnooze,
  onPin,
  onOpen,
  onHandleChat,
}: MatterSignalCardProps) {
  const { t } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);

  const run = (action: () => void) => {
    setMenuOpen(false);
    action();
  };

  return (
    <article
      className={`rounded-xl border px-3 py-2.5 transition-colors cursor-pointer ${
        selected
          ? 'border-accent/50 bg-accent-muted/15'
          : 'border-border-muted bg-background/50 hover:bg-surface-hover/50'
      }`}
      onClick={onSelect}
    >
      <div className="flex items-start gap-2.5">
        <span
          className={`mt-1.5 h-2 w-2 rounded-full shrink-0 ${SEVERITY_DOT[item.severity] || SEVERITY_DOT.signal}`}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <h3 className="min-w-0 flex-1 text-[13px] font-semibold text-text-primary leading-snug">
              {item.title}
            </h3>
            {item.pinned ? <Pin className="w-3 h-3 text-accent shrink-0 mt-1" /> : null}
            <div ref={menuRef} className="relative shrink-0" onClick={(e) => e.stopPropagation()}>
              <button
                type="button"
                aria-label={t('matter.action.menu')}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                aria-controls={menuId}
                title={t('matter.action.menu')}
                onClick={() => setMenuOpen((open) => !open)}
                className="h-7 w-7 rounded-lg flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-surface-hover transition-colors"
              >
                <MoreHorizontal className="w-4 h-4" />
              </button>
              {menuOpen ? (
                <div
                  id={menuId}
                  role="menu"
                  className="absolute right-0 top-8 z-30 w-52 rounded-xl border border-border-muted bg-surface shadow-lg py-1"
                >
                  <MenuItem
                    icon={<Check className="w-3.5 h-3.5" />}
                    label={t('matter.action.done')}
                    hint={t('matter.action.doneHint')}
                    onClick={() => run(onDone)}
                  />
                  <MenuItem
                    icon={<Clock3 className="w-3.5 h-3.5" />}
                    label={t('matter.action.snooze')}
                    hint={t('matter.action.snoozeHint')}
                    onClick={() => run(onSnooze)}
                  />
                  <MenuItem
                    icon={
                      item.pinned ? (
                        <PinOff className="w-3.5 h-3.5" />
                      ) : (
                        <Pin className="w-3.5 h-3.5" />
                      )
                    }
                    label={item.pinned ? t('matter.action.unpin') : t('matter.action.pin')}
                    hint={item.pinned ? t('matter.action.unpinHint') : t('matter.action.pinHint')}
                    onClick={() => run(onPin)}
                  />
                  <MenuItem
                    icon={<MessageSquare className="w-3.5 h-3.5" />}
                    label={t('matter.action.chat')}
                    hint={t('matter.action.chatHint')}
                    onClick={() => run(onHandleChat)}
                  />
                  {item.sourceRef.url ? (
                    <MenuItem
                      icon={<ExternalLink className="w-3.5 h-3.5" />}
                      label={t('matter.action.open')}
                      hint={t('matter.action.openHint')}
                      onClick={() => run(onOpen)}
                    />
                  ) : null}
                  <div className="my-1 border-t border-border-subtle" />
                  <MenuItem
                    icon={<X className="w-3.5 h-3.5" />}
                    label={t('matter.action.dismiss')}
                    hint={t('matter.action.dismissHint')}
                    onClick={() => run(() => onDismiss(false))}
                  />
                  <MenuItem
                    icon={<Ban className="w-3.5 h-3.5" />}
                    label={t('matter.action.mute')}
                    hint={t('matter.action.muteHint')}
                    onClick={() => run(() => onDismiss(true))}
                    danger
                  />
                </div>
              ) : null}
            </div>
          </div>
          <p className="mt-1 text-[11px] text-text-secondary line-clamp-2">{item.whyItMatters}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10px] uppercase tracking-wide">
            <span className="rounded-md bg-surface px-1.5 py-0.5 text-text-muted border border-border-subtle">
              {item.severity}
            </span>
            <span className="rounded-md bg-surface px-1.5 py-0.5 text-text-muted border border-border-subtle">
              {item.category}
            </span>
            <span className="rounded-md bg-surface px-1.5 py-0.5 text-text-muted border border-border-subtle">
              {item.source}
            </span>
            <span className="text-text-muted normal-case tracking-normal">
              {relativeTime(item.lastSeenAt)}
            </span>
          </div>
        </div>
      </div>
    </article>
  );
}

function MenuItem({
  icon,
  label,
  hint,
  onClick,
  danger,
}: {
  icon: ReactNode;
  label: string;
  hint: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      title={hint}
      onClick={onClick}
      className={`w-full flex items-start gap-2.5 px-3 py-2 text-left transition-colors hover:bg-surface-hover ${
        danger ? 'text-error' : 'text-text-primary'
      }`}
    >
      <span className={`mt-0.5 shrink-0 ${danger ? 'text-error' : 'text-text-muted'}`}>{icon}</span>
      <span className="min-w-0">
        <span className="block text-[12px] font-medium leading-tight">{label}</span>
        <span className="block text-[10px] text-text-muted leading-snug mt-0.5">{hint}</span>
      </span>
    </button>
  );
}
