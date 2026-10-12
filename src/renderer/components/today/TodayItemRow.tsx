import { forwardRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  BellOff,
  Check,
  CircleDashed,
  ExternalLink,
  MoreHorizontal,
  PanelRightOpen,
  Pin,
  X,
} from 'lucide-react';
import type { MatterItem } from '../../../shared/matter';
import { Menu, type MenuEntry } from '../ui/Menu';
import {
  SOURCE_TILE,
  dueLabel,
  primaryActionLabel,
  severityTagClass,
  sourceName,
} from './today-format';

interface TodayItemRowProps {
  item: MatterItem;
  highlighted: boolean;
  tracked: boolean;
  onHover: (id: string | null) => void;
  onOpenDetail: () => void;
  onHandleChat: () => void;
  onSnooze: () => void;
  onDone: () => void;
  onDismiss: (mute: boolean) => void;
  onPin: () => void;
  onOpenSource: () => void;
  onAddToFollowUps?: () => void;
}

export const TodayItemRow = forwardRef<HTMLDivElement, TodayItemRowProps>(function TodayItemRow(
  {
    item,
    highlighted,
    tracked,
    onHover,
    onOpenDetail,
    onHandleChat,
    onSnooze,
    onDone,
    onDismiss,
    onPin,
    onOpenSource,
    onAddToFollowUps,
  },
  ref
) {
  const { t } = useTranslation();
  const tile = SOURCE_TILE[item.source] ?? SOURCE_TILE.hub;
  const due = dueLabel(t, item.dueAt);
  const tag =
    due ??
    (item.severity === 'critical'
      ? t('today.tag.urgent')
      : item.severity === 'warning'
        ? t('today.tag.attention')
        : null);
  const sourceLine = [sourceName(t, item.source), item.sourceRef.label].filter(Boolean).join(' · ');
  const isWatching = item.orbit === 'watching';
  const hasSource = Boolean(item.sourceRef.url || item.rawDetails?.match(/https?:\/\//));

  const menu: MenuEntry[] = [
    {
      id: 'details',
      label: t('today.action.details'),
      icon: <PanelRightOpen className="h-3.5 w-3.5" />,
      onSelect: onOpenDetail,
    },
    {
      id: 'done',
      label: t('today.action.done'),
      icon: <Check className="h-3.5 w-3.5" />,
      onSelect: onDone,
    },
    ...(onAddToFollowUps
      ? [
          {
            id: 'followup',
            label: tracked ? t('today.action.inFollowUps') : t('today.action.addToFollowUps'),
            icon: <CircleDashed className="h-3.5 w-3.5" />,
            disabled: tracked,
            onSelect: onAddToFollowUps,
          },
        ]
      : []),
    {
      id: 'pin',
      label: item.pinned ? t('today.action.unpin') : t('today.action.pin'),
      icon: <Pin className="h-3.5 w-3.5" />,
      onSelect: onPin,
    },
    ...(hasSource
      ? [
          {
            id: 'open',
            label: t('today.action.openIn', { source: sourceName(t, item.source) }),
            icon: <ExternalLink className="h-3.5 w-3.5" />,
            onSelect: onOpenSource,
          },
        ]
      : []),
    'separator',
    {
      id: 'dismiss',
      label: t('today.action.dismiss'),
      icon: <X className="h-3.5 w-3.5" />,
      onSelect: () => onDismiss(false),
    },
    {
      id: 'mute',
      label: t('today.action.dismissMute'),
      icon: <BellOff className="h-3.5 w-3.5" />,
      onSelect: () => onDismiss(true),
    },
  ];

  return (
    <div
      ref={ref}
      data-item-id={item.id}
      onMouseEnter={() => onHover(item.id)}
      onMouseLeave={() => onHover(null)}
      onClick={onOpenDetail}
      className={`group relative -mx-3 grid cursor-pointer grid-cols-[28px_minmax(0,1fr)_auto] items-start gap-3 rounded-[10px] p-3 transition-colors hover:bg-surface ${
        highlighted ? 'bg-surface shadow-[inset_3px_0_0_var(--color-accent)]' : ''
      }`}
    >
      <div
        className={`flex h-7 w-7 items-center justify-center rounded-[7px] text-[11px] font-extrabold ${tile.className}`}
        aria-hidden
      >
        {tile.abbr}
      </div>
      <div className="min-w-0">
        <h4 className="mb-[3px] mt-px flex items-center gap-1.5 text-[14px] font-semibold text-text-primary">
          {item.pinned ? <Pin className="h-3 w-3 shrink-0 fill-current text-accent-text" /> : null}
          <span className="truncate">{item.title}</span>
        </h4>
        <p className="line-clamp-2 text-[13px] leading-[1.5] text-text-secondary">
          {item.whyItMatters || item.summary}
        </p>
        <div className="mt-1.5 flex flex-wrap items-center gap-2.5 text-[12px] text-text-muted">
          {tag ? (
            <span
              className={`rounded-[5px] px-[7px] py-0.5 text-[11px] font-semibold ${severityTagClass(item.severity)}`}
            >
              {tag}
            </span>
          ) : null}
          <span className="truncate">{sourceLine}</span>
          {tracked ? (
            <span className="inline-flex items-center gap-1 text-accent-text">
              <CircleDashed className="h-3 w-3" />
              {t('today.inFollowUps')}
            </span>
          ) : null}
        </div>
      </div>
      <div
        className="flex items-center gap-1.5 opacity-60 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
        onClick={(e) => e.stopPropagation()}
      >
        {isWatching ? (
          <button type="button" onClick={() => onDismiss(false)} className="btn btn-sm btn-ghost">
            {t('today.action.dismiss')}
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={onHandleChat}
              className={`btn btn-sm ${item.orbit === 'now' ? 'btn-primary' : 'btn-secondary'}`}
            >
              {primaryActionLabel(t, item)}
            </button>
            <button type="button" onClick={onSnooze} className="btn btn-sm btn-ghost">
              {t('today.action.later')}
            </button>
          </>
        )}
        <Menu
          items={menu}
          trigger={({ open, toggle }) => (
            <button
              type="button"
              onClick={toggle}
              aria-label={t('today.action.more')}
              aria-expanded={open}
              className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted hover:bg-surface-hover hover:text-text-primary"
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
          )}
        />
      </div>
    </div>
  );
});
