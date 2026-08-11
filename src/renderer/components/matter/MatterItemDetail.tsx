import type { ReactNode } from 'react';
import { Check, Clock3, MessageSquare, Pin, PinOff, X, ExternalLink, Ban } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { MEETING_PREP_MARKER, type MatterItem } from '../../../shared/matter';
import { formatDueRelative, isDueUrgent } from '../../../shared/matter-time';

const SEVERITY_CLASS: Record<string, string> = {
  critical: 'text-red-400 border-red-400/30 bg-red-400/10',
  warning: 'text-amber-400 border-amber-400/30 bg-amber-400/10',
  healthy: 'text-emerald-400 border-emerald-400/30 bg-emerald-400/10',
  signal: 'text-accent border-accent/30 bg-accent/10',
};

interface MatterItemDetailProps {
  item: MatterItem;
  onClose: () => void;
  onDone: () => void;
  onDismiss: (mute?: boolean) => void;
  onSnooze: () => void;
  onPin: () => void;
  onOpen: () => void;
  onHandleChat: () => void;
}

export function MatterItemDetail({
  item,
  onClose,
  onDone,
  onDismiss,
  onSnooze,
  onPin,
  onOpen,
  onHandleChat,
}: MatterItemDetailProps) {
  const { t } = useTranslation();
  const sourceLabel = item.sourceRef.label || item.source;
  const hasSourceUrl = Boolean(item.sourceRef.url?.trim());
  const rawDetails = item.rawDetails?.trim() || '';
  const isPrepNote = rawDetails.startsWith(MEETING_PREP_MARKER);

  return (
    <div className="w-full max-w-xl rounded-2xl border border-border-muted bg-surface/90 shadow-lg overflow-hidden">
      <div className="flex items-start justify-between gap-3 px-4 py-3 border-b border-border-subtle">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-text-muted">
            {t('matter.detailTitle')}
          </p>
          <h2 className="mt-1 text-[15px] font-semibold text-text-primary leading-snug">
            {item.title}
          </h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="h-8 w-8 shrink-0 rounded-lg flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-surface-hover"
          title={t('common.close')}
          aria-label={t('common.close')}
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="px-4 py-3 space-y-3 max-h-[min(480px,50vh)] overflow-y-auto">
        <div className="flex flex-wrap gap-1.5">
          <MetaChip
            className={SEVERITY_CLASS[item.severity] || SEVERITY_CLASS.signal}
            label={item.severity}
          />
          <MetaChip label={item.orbit} />
          <MetaChip label={item.category} />
          {hasSourceUrl ? (
            <button
              type="button"
              onClick={onOpen}
              className="rounded-md border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent hover:bg-accent/20 inline-flex items-center gap-1"
              title={item.sourceRef.url || t('matter.action.openHint')}
            >
              {item.source}
              <ExternalLink className="w-2.5 h-2.5" />
            </button>
          ) : (
            <MetaChip label={item.source} />
          )}
          {item.pinned ? <MetaChip label={t('matter.action.pin')} /> : null}
          {item.dueAt != null ? (
            <span
              className={`rounded-md border px-1.5 py-0.5 text-[10px] font-semibold normal-case tracking-normal ${
                isDueUrgent(item.dueAt)
                  ? 'text-red-400 border-red-400/30 bg-red-400/10'
                  : 'text-text-secondary border-border-subtle bg-surface'
              }`}
            >
              {formatDueRelative(item.dueAt)}
            </span>
          ) : null}
        </div>

        <DetailBlock label={t('matter.detailSummary')}>
          {item.summary || t('matter.detailEmpty')}
        </DetailBlock>

        <DetailBlock label={t('matter.detailWhy')}>
          {item.whyItMatters || t('matter.detailEmpty')}
        </DetailBlock>

        <DetailBlock label={t('matter.detailSuggested')}>
          {item.suggestedAction || t('matter.detailNoAction')}
        </DetailBlock>

        <div className="rounded-xl border border-border-subtle bg-background/50 px-3 py-2.5 space-y-1.5">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-text-muted">
            {t('matter.detailSource')}
          </p>
          {hasSourceUrl ? (
            <button
              type="button"
              onClick={onOpen}
              className="inline-flex items-center gap-1.5 text-[13px] font-medium text-accent hover:underline text-left"
              title={item.sourceRef.url || undefined}
            >
              <ExternalLink className="w-3.5 h-3.5 shrink-0" />
              <span className="break-all">{sourceLabel}</span>
            </button>
          ) : (
            <p className="text-[12px] text-text-primary">{sourceLabel}</p>
          )}
          {item.sourceRef.url ? (
            <p className="text-[11px] text-text-muted break-all">{item.sourceRef.url}</p>
          ) : (
            <p className="text-[11px] text-text-muted">{t('matter.detailNoSourceUrl')}</p>
          )}
          {item.sourceRef.externalId ? (
            <p className="text-[11px] text-text-muted break-all">
              {t('matter.detailExternalId')}: {item.sourceRef.externalId}
            </p>
          ) : null}
          {item.sourceRef.connectorId ? (
            <p className="text-[11px] text-text-muted break-all">
              {t('matter.detailConnector')}: {item.sourceRef.connectorId}
            </p>
          ) : null}
        </div>

        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-text-muted mb-1">
            {isPrepNote ? t('matter.detailPrepNote') : t('matter.detailRaw')}
          </p>
          {rawDetails ? (
            <pre className="rounded-xl border border-border-subtle bg-background px-3 py-2.5 text-[11px] leading-relaxed text-text-secondary whitespace-pre-wrap break-words font-mono max-h-56 overflow-y-auto">
              {rawDetails}
            </pre>
          ) : (
            <p className="text-[12px] text-text-muted">{t('matter.detailRawEmpty')}</p>
          )}
        </div>

        <div className="grid grid-cols-2 gap-2 text-[11px] text-text-muted">
          <div>
            <span className="block uppercase tracking-wide text-[10px] mb-0.5">
              {t('matter.detailConfidence')}
            </span>
            <span className="text-text-primary">{Math.round(item.confidence * 100)}%</span>
          </div>
          <div>
            <span className="block uppercase tracking-wide text-[10px] mb-0.5">
              {t('matter.detailRank')}
            </span>
            <span className="text-text-primary">{Math.round(item.rankScore)}</span>
          </div>
          <div>
            <span className="block uppercase tracking-wide text-[10px] mb-0.5">
              {t('matter.detailSeen')}
            </span>
            <span className="text-text-primary">{formatWhen(item.lastSeenAt)}</span>
          </div>
          <div>
            <span className="block uppercase tracking-wide text-[10px] mb-0.5">
              {t('matter.detailFingerprint')}
            </span>
            <span className="text-text-primary truncate block" title={item.fingerprint}>
              {item.fingerprint}
            </span>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5 px-4 py-3 border-t border-border-subtle bg-background/40">
        <DetailAction
          icon={<Check className="w-3.5 h-3.5" />}
          label={t('matter.action.done')}
          onClick={onDone}
        />
        <DetailAction
          icon={<Clock3 className="w-3.5 h-3.5" />}
          label={t('matter.action.snooze')}
          onClick={onSnooze}
        />
        <DetailAction
          icon={item.pinned ? <PinOff className="w-3.5 h-3.5" /> : <Pin className="w-3.5 h-3.5" />}
          label={item.pinned ? t('matter.action.unpin') : t('matter.action.pin')}
          onClick={onPin}
        />
        <DetailAction
          icon={<MessageSquare className="w-3.5 h-3.5" />}
          label={t('matter.action.chat')}
          onClick={onHandleChat}
        />
        {hasSourceUrl ? (
          <DetailAction
            icon={<ExternalLink className="w-3.5 h-3.5" />}
            label={t('matter.action.open')}
            onClick={onOpen}
          />
        ) : null}
        <DetailAction
          icon={<X className="w-3.5 h-3.5" />}
          label={t('matter.action.dismiss')}
          onClick={() => onDismiss(false)}
        />
        <DetailAction
          icon={<Ban className="w-3.5 h-3.5" />}
          label={t('matter.action.mute')}
          onClick={() => onDismiss(true)}
          danger
        />
      </div>
    </div>
  );
}

function MetaChip({ label, className }: { label: string; className?: string }) {
  return (
    <span
      className={`rounded-md border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
        className || 'text-text-muted border-border-subtle bg-background/60'
      }`}
    >
      {label}
    </span>
  );
}

function DetailBlock({ label, children }: { label: string; children: string }) {
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-text-muted mb-1">
        {label}
      </p>
      <p className="text-[13px] text-text-primary leading-relaxed whitespace-pre-wrap">
        {children}
      </p>
    </div>
  );
}

function DetailAction({
  icon,
  label,
  onClick,
  danger,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[11px] font-medium transition-colors ${
        danger
          ? 'border-error/30 text-error hover:bg-error/10'
          : 'border-border-subtle text-text-secondary hover:text-text-primary hover:bg-surface-hover'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

function formatWhen(ts: number): string {
  try {
    return new Date(ts).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return '—';
  }
}
