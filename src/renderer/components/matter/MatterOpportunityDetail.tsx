import { useState, type ReactNode } from 'react';
import { Clock3, ExternalLink, Loader2, MessageSquare, Send, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  OPPORTUNITY_TARGET_LABELS,
  type MatterOpportunity,
  type MatterSnapshot,
  type OpportunityReportPreview,
} from '../../../shared/matter';
import { OPPORTUNITY_KIND_CLASS, OpportunityKindIcon } from './MatterOpportunityList';

interface MatterOpportunityDetailProps {
  opportunity: MatterOpportunity;
  onClose: () => void;
  onDismiss: () => void;
  onSnooze: () => void;
  onOpen: () => void;
  onChat: () => void;
  onReported: (snapshot: MatterSnapshot) => void;
}

export function MatterOpportunityDetail({
  opportunity: opp,
  onClose,
  onDismiss,
  onSnooze,
  onOpen,
  onChat,
  onReported,
}: MatterOpportunityDetailProps) {
  const { t } = useTranslation();
  const [preview, setPreview] = useState<OpportunityReportPreview | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const hasSourceUrl = Boolean(opp.sourceRef.url?.trim());

  const openReport = async () => {
    if (!window.electronAPI?.matter) return;
    setLoadingPreview(true);
    try {
      setPreview(await window.electronAPI.matter.previewOpportunityReport(opp.id));
    } catch (error) {
      console.error('[Matter] Opportunity preview failed:', error);
    } finally {
      setLoadingPreview(false);
    }
  };

  return (
    <div className="w-full max-w-xl rounded-2xl border border-border-muted bg-surface/90 shadow-lg overflow-hidden">
      <div className="flex items-start justify-between gap-3 px-4 py-3 border-b border-border-subtle">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-text-muted">
            {t('matter.opportunities.detailTitle')}
          </p>
          <h2 className="mt-1 text-[15px] font-semibold text-text-primary leading-snug">
            {opp.title}
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
          <span
            className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${OPPORTUNITY_KIND_CLASS[opp.kind]}`}
          >
            <OpportunityKindIcon kind={opp.kind} className="w-2.5 h-2.5" />
            {t(`matter.opportunities.kind.${opp.kind}`)}
          </span>
          <Chip label={OPPORTUNITY_TARGET_LABELS[opp.target]} />
          {opp.clientName ? <Chip label={opp.clientName} /> : null}
          <Chip label={`${opp.source} · ${Math.round(opp.confidence * 100)}%`} />
        </div>

        {opp.summary ? (
          <Block label={t('matter.opportunities.summary')}>{opp.summary}</Block>
        ) : null}

        {opp.evidence ? (
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-text-muted mb-1">
              {t('matter.opportunities.evidence')}
            </p>
            <blockquote className="rounded-xl border-l-2 border-accent/50 bg-background/50 px-3 py-2 text-[12px] italic text-text-secondary whitespace-pre-wrap">
              {opp.evidence}
            </blockquote>
          </div>
        ) : null}

        {opp.suggestedPitch ? (
          <Block label={t('matter.opportunities.pitch')}>{opp.suggestedPitch}</Block>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-1.5 px-4 py-3 border-t border-border-subtle bg-background/40">
        <Action
          icon={
            loadingPreview ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Send className="w-3.5 h-3.5" />
            )
          }
          label={t('matter.opportunities.report')}
          title={t('matter.opportunities.reportHint')}
          onClick={() => void openReport()}
          disabled={loadingPreview}
          primary
        />
        <Action
          icon={<MessageSquare className="w-3.5 h-3.5" />}
          label={t('matter.opportunities.chat')}
          onClick={onChat}
        />
        {hasSourceUrl ? (
          <Action
            icon={<ExternalLink className="w-3.5 h-3.5" />}
            label={t('matter.opportunities.open')}
            onClick={onOpen}
          />
        ) : null}
        <Action
          icon={<Clock3 className="w-3.5 h-3.5" />}
          label={t('matter.opportunities.snooze')}
          onClick={onSnooze}
        />
        <Action
          icon={<X className="w-3.5 h-3.5" />}
          label={t('matter.opportunities.dismiss')}
          onClick={onDismiss}
          danger
        />
      </div>

      {preview ? (
        <ReportModal
          preview={preview}
          onCancel={() => setPreview(null)}
          onSent={(snapshot) => {
            setPreview(null);
            onReported(snapshot);
          }}
        />
      ) : null}
    </div>
  );
}

function ReportModal({
  preview,
  onCancel,
  onSent,
}: {
  preview: OpportunityReportPreview;
  onCancel: () => void;
  onSent: (snapshot: MatterSnapshot) => void;
}) {
  const { t } = useTranslation();
  const [channel, setChannel] = useState(preview.channel || '');
  const [text, setText] = useState(preview.text);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    if (!window.electronAPI?.matter) return;
    setSending(true);
    setError(null);
    try {
      const snapshot = await window.electronAPI.matter.reportOpportunity({
        opportunityId: preview.opportunityId,
        channel: channel.trim(),
        text: text.trim(),
      });
      onSent(snapshot);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(`${t('matter.opportunities.sendFailed')}: ${message}`);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
      <div className="w-full max-w-lg rounded-2xl border border-border-muted bg-surface shadow-xl">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle">
          <h3 className="text-[14px] font-semibold text-text-primary">
            {t('matter.opportunities.previewTitle')}
          </h3>
          <button
            type="button"
            onClick={onCancel}
            className="h-8 w-8 rounded-lg flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-surface-hover"
            aria-label={t('common.close')}
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="px-4 py-3 space-y-3">
          <label className="block">
            <span className="block text-[10px] font-semibold uppercase tracking-[0.14em] text-text-muted mb-1">
              {t('matter.opportunities.previewChannel')}
            </span>
            <input
              value={channel}
              onChange={(e) => setChannel(e.target.value)}
              placeholder={t('matter.opportunities.previewChannelPlaceholder')}
              className="w-full h-9 rounded-lg border border-border-subtle bg-background px-3 text-[13px] text-text-primary outline-none focus:border-accent/60"
            />
            {!preview.channel ? (
              <span className="mt-1 block text-[11px] text-amber-400">
                {t('matter.opportunities.previewChannelMissing')}
              </span>
            ) : null}
          </label>
          <label className="block">
            <span className="block text-[10px] font-semibold uppercase tracking-[0.14em] text-text-muted mb-1">
              {t('matter.opportunities.previewMessage')}
            </span>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={10}
              className="w-full rounded-lg border border-border-subtle bg-background px-3 py-2 text-[12px] font-mono leading-relaxed text-text-primary outline-none focus:border-accent/60 resize-y"
            />
          </label>
          {error ? <p className="text-[12px] text-error">{error}</p> : null}
        </div>
        <div className="flex justify-end gap-2 px-4 py-3 border-t border-border-subtle">
          <Action label={t('matter.opportunities.cancel')} onClick={onCancel} />
          <Action
            icon={
              sending ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Send className="w-3.5 h-3.5" />
              )
            }
            label={sending ? t('matter.opportunities.sending') : t('matter.opportunities.send')}
            onClick={() => void send()}
            disabled={sending || !channel.trim() || !text.trim()}
            primary
          />
        </div>
      </div>
    </div>
  );
}

function Chip({ label }: { label: string }) {
  return (
    <span className="rounded-md border border-border-subtle bg-background/60 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-text-muted">
      {label}
    </span>
  );
}

function Block({ label, children }: { label: string; children: string }) {
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

function Action({
  icon,
  label,
  title,
  onClick,
  danger,
  primary,
  disabled,
}: {
  icon?: ReactNode;
  label: string;
  title?: string;
  onClick: () => void;
  danger?: boolean;
  primary?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[11px] font-medium transition-colors disabled:opacity-60 disabled:pointer-events-none ${
        danger
          ? 'border-error/30 text-error hover:bg-error/10'
          : primary
            ? 'border-accent/40 bg-accent/15 text-accent hover:bg-accent/25'
            : 'border-border-subtle text-text-secondary hover:text-text-primary hover:bg-surface-hover'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}
