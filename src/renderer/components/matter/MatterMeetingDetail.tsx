import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ExternalLink, Loader2, Maximize2, Minimize2, Sparkles, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { MEETING_PREP_MARKER, type MatterMeeting } from '../../../shared/matter';
import { calendarOrbitSeverity, formatDueRelative, formatMeetingWhen, isDueUrgent } from '../../../shared/matter-time';
import { MessageMarkdown } from '../MessageMarkdown';

interface MatterMeetingDetailProps {
  meeting: MatterMeeting;
  onClose: () => void;
  onOpen: () => void;
  onPrep: () => void;
  prepLoading?: boolean;
  /** Open prep note fullscreen once when meeting is selected from sidebar “See note”. */
  autoPrepFullscreen?: boolean;
  onAutoPrepFullscreenConsumed?: () => void;
}

function meetingWhenLine(meeting: MatterMeeting): string {
  return formatMeetingWhen(meeting.startMs, meeting.endMs, meeting.when || meeting.summary);
}

export function MatterMeetingDetail({
  meeting,
  onClose,
  onOpen,
  onPrep,
  prepLoading = false,
  autoPrepFullscreen = false,
  onAutoPrepFullscreenConsumed,
}: MatterMeetingDetailProps) {
  const { t } = useTranslation();
  const [prepFullscreen, setPrepFullscreen] = useState(false);
  const rawDetails = meeting.rawDetails?.trim() || '';
  const isPrepNote = rawDetails.startsWith(MEETING_PREP_MARKER);
  const { orbit } = calendarOrbitSeverity(meeting.startMs);
  const hasLink = Boolean(meeting.htmlLink?.trim());
  const meetingTitle = meeting.title || t('matter.meetingUntitled');
  const whenLine = meetingWhenLine(meeting);
  const attendeeTail =
    (meeting.summary || '').match(/\bw\/\s+.+$/i)?.[0] ||
    (/·\s*w\//i.test(meeting.summary || '')
      ? (meeting.summary || '').split(/·/).slice(1).join('·').trim()
      : '');
  const summaryLine = [whenLine, attendeeTail && !whenLine.includes(attendeeTail) ? attendeeTail : '']
    .filter(Boolean)
    .join(' · ');

  useEffect(() => {
    if (!isPrepNote) setPrepFullscreen(false);
  }, [isPrepNote, meeting.id]);

  useEffect(() => {
    if (!autoPrepFullscreen) return;
    if (isPrepNote && rawDetails) {
      setPrepFullscreen(true);
    }
    onAutoPrepFullscreenConsumed?.();
  }, [autoPrepFullscreen, isPrepNote, rawDetails, meeting.id, onAutoPrepFullscreenConsumed]);

  useEffect(() => {
    if (!prepFullscreen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setPrepFullscreen(false);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [prepFullscreen]);

  return (
    <>
      <div className="w-full max-w-xl rounded-2xl border border-border-muted bg-surface/90 shadow-lg overflow-hidden">
        <div className="flex items-start justify-between gap-3 px-4 py-3 border-b border-border-subtle">
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-text-muted">
              {t('matter.meetingDetailTitle')}
            </p>
            <h2 className="mt-1 text-[15px] font-semibold text-text-primary leading-snug">
              {meetingTitle}
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
            <MetaChip label={orbit} />
            <MetaChip label={t('matter.source.calendar')} />
            {meeting.startMs != null ? (
              <span
                className={`rounded-md border px-1.5 py-0.5 text-[10px] font-semibold normal-case tracking-normal ${
                  isDueUrgent(meeting.startMs)
                    ? 'text-red-400 border-red-400/30 bg-red-400/10'
                    : 'text-text-secondary border-border-subtle bg-surface'
                }`}
              >
                {formatDueRelative(meeting.startMs)}
              </span>
            ) : null}
          </div>

          <DetailBlock label={t('matter.detailSummary')}>
            {summaryLine || t('matter.detailEmpty')}
          </DetailBlock>

          {meeting.suggestedAction ? (
            <DetailBlock label={t('matter.detailSuggested')}>{meeting.suggestedAction}</DetailBlock>
          ) : null}

          <div>
            <div className="mb-1 flex items-center justify-between gap-2">
              <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-text-muted">
                {isPrepNote ? t('matter.detailPrepNote') : t('matter.detailRaw')}
              </p>
              {isPrepNote && rawDetails ? (
                <button
                  type="button"
                  onClick={() => setPrepFullscreen(true)}
                  className="inline-flex h-7 items-center gap-1 rounded-md border border-border-subtle px-2 text-[10px] font-semibold text-text-secondary hover:text-text-primary hover:bg-surface-hover"
                  title={t('matter.prepFullscreen')}
                  aria-label={t('matter.prepFullscreen')}
                >
                  <Maximize2 className="w-3 h-3" />
                  {t('matter.prepFullscreen')}
                </button>
              ) : null}
            </div>
            {rawDetails ? (
              isPrepNote ? (
                <div className="rounded-xl border border-border-subtle bg-background px-3 py-2.5 max-h-72 overflow-y-auto text-[12px] leading-relaxed text-text-secondary">
                  <MessageMarkdown normalizedText={rawDetails} />
                </div>
              ) : (
                <pre className="rounded-xl border border-border-subtle bg-background px-3 py-2.5 text-[11px] leading-relaxed text-text-secondary whitespace-pre-wrap break-words font-mono max-h-56 overflow-y-auto">
                  {rawDetails}
                </pre>
              )
            ) : (
              <p className="text-[12px] text-text-muted">{t('matter.meetingNoPrepYet')}</p>
            )}
          </div>
        </div>

        <div className="flex flex-wrap gap-1.5 px-4 py-3 border-t border-border-subtle bg-background/40">
          <DetailAction
            icon={
              prepLoading ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Sparkles className="w-3.5 h-3.5" />
              )
            }
            label={
              prepLoading
                ? t('matter.action.prepping')
                : isPrepNote
                  ? t('matter.action.reprep')
                  : t('matter.action.prep')
            }
            onClick={onPrep}
            disabled={prepLoading}
            primary
          />
          {hasLink ? (
            <DetailAction
              icon={<ExternalLink className="w-3.5 h-3.5" />}
              label={t('matter.action.open')}
              onClick={onOpen}
            />
          ) : null}
        </div>
      </div>

      {prepFullscreen && isPrepNote && rawDetails
        ? createPortal(
            <div
              className="titlebar-no-drag fixed inset-x-0 top-10 bottom-0 z-[100] flex flex-col bg-background animate-fade-in"
              role="dialog"
              aria-modal="true"
              aria-labelledby="matter-prep-fullscreen-title"
            >
              <header className="shrink-0 flex items-center gap-3 border-b border-border-muted px-4 py-3 sm:px-6">
                <div className="min-w-0 flex-1">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-text-muted">
                    {t('matter.detailPrepNote')}
                  </p>
                  <h2
                    id="matter-prep-fullscreen-title"
                    className="mt-1 text-base font-semibold text-text-primary leading-snug"
                  >
                    {meetingTitle}
                  </h2>
                  {summaryLine ? (
                    <p className="mt-1 text-[12px] text-text-secondary line-clamp-2">
                      {summaryLine}
                    </p>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center justify-end gap-1.5 shrink-0 relative z-10">
                  <DetailAction
                    icon={
                      prepLoading ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Sparkles className="w-3.5 h-3.5" />
                      )
                    }
                    label={
                      prepLoading
                        ? t('matter.action.prepping')
                        : t('matter.action.reprep')
                    }
                    onClick={onPrep}
                    disabled={prepLoading}
                    primary
                  />
                  {hasLink ? (
                    <DetailAction
                      icon={<ExternalLink className="w-3.5 h-3.5" />}
                      label={t('matter.action.open')}
                      onClick={onOpen}
                    />
                  ) : null}
                  <button
                    type="button"
                    onClick={() => setPrepFullscreen(false)}
                    className="titlebar-no-drag inline-flex h-9 items-center gap-1.5 rounded-lg border border-border-subtle px-3 text-[11px] font-medium text-text-secondary hover:text-text-primary hover:bg-surface-hover"
                    title={t('matter.prepExitFullscreen')}
                    aria-label={t('matter.prepExitFullscreen')}
                  >
                    <Minimize2 className="w-3.5 h-3.5" />
                    {t('matter.prepExitFullscreen')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setPrepFullscreen(false)}
                    className="titlebar-no-drag h-9 w-9 rounded-lg flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-surface-hover"
                    title={t('common.close')}
                    aria-label={t('common.close')}
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </header>
              <div className="flex-1 min-h-0 overflow-y-auto px-4 py-5 sm:px-8 sm:py-6">
                <div className="mx-auto max-w-3xl text-[14px] leading-relaxed text-text-primary">
                  <MessageMarkdown normalizedText={rawDetails} />
                </div>
              </div>
            </div>,
            document.body
          )
        : null}
    </>
  );
}

function MetaChip({ label }: { label: string }) {
  return (
    <span className="rounded-md border border-border-subtle bg-background/60 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-text-muted">
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
      <p className="text-[13px] text-text-primary leading-relaxed whitespace-pre-wrap">{children}</p>
    </div>
  );
}

function DetailAction({
  icon,
  label,
  onClick,
  primary,
  disabled,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  primary?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`titlebar-no-drag inline-flex h-9 items-center gap-1.5 rounded-lg border px-3 text-[11px] font-medium transition-colors disabled:opacity-60 disabled:pointer-events-none ${
        primary
          ? 'border-accent/40 bg-accent/15 text-accent hover:bg-accent/25'
          : 'border-border-subtle text-text-secondary hover:text-text-primary hover:bg-surface-hover'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}
