import type { ReactNode } from 'react';
import { Ghost, Hourglass, Lock, Users, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

type Tone = 'neutral' | 'warning';

function Banner({
  icon,
  tone = 'neutral',
  children,
  onDismiss,
}: {
  icon?: ReactNode;
  tone?: Tone;
  children: ReactNode;
  onDismiss?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className={`flex shrink-0 items-center gap-2 border-b px-4 py-2 text-[12.5px] lg:px-6 ${
        tone === 'warning'
          ? 'border-warning/25 bg-warning/10 text-text-primary'
          : 'border-border-muted bg-surface/60 text-text-secondary'
      }`}
    >
      {icon ? <span className="shrink-0 text-text-muted">{icon}</span> : null}
      <div className="min-w-0 flex-1">{children}</div>
      {onDismiss ? (
        <button
          type="button"
          className="shrink-0 rounded p-0.5 text-text-muted hover:text-text-primary"
          onClick={onDismiss}
          title={t('loop.dismissNotice')}
          aria-label={t('loop.dismissNotice')}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </div>
  );
}

export interface ChatCollabBanner {
  waitingForPeer: boolean;
  /** Someone else holds the turn. */
  watchingName?: string | null;
  onTakeTurn: () => void;
  statusLine?: string | null;
}

interface ChatBannersProps {
  incognito: boolean;
  loopNotice: string | null;
  onDismissLoopNotice: () => void;
  queueLabel: string | null;
  sharedDocLockLabel: string | null;
  collab: ChatCollabBanner | null;
}

/** Notices that sit between the header and the messages. */
export function ChatBanners({
  incognito,
  loopNotice,
  onDismissLoopNotice,
  queueLabel,
  sharedDocLockLabel,
  collab,
}: ChatBannersProps) {
  const { t } = useTranslation();
  return (
    <>
      {incognito ? (
        <Banner icon={<Ghost className="h-3.5 w-3.5" />}>{t('chat.incognitoBanner')}</Banner>
      ) : null}
      {loopNotice ? <Banner onDismiss={onDismissLoopNotice}>{loopNotice}</Banner> : null}
      {queueLabel ? (
        <Banner icon={<Hourglass className="h-3.5 w-3.5" />}>{queueLabel}</Banner>
      ) : null}
      {sharedDocLockLabel ? (
        <Banner tone="warning" icon={<Lock className="h-3.5 w-3.5" />}>
          {sharedDocLockLabel}
        </Banner>
      ) : null}
      {collab ? (
        <Banner icon={<Users className="h-3.5 w-3.5" />}>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {collab.waitingForPeer ? <span>{t('chat.collabWaitingPeer')}</span> : null}
            {collab.watchingName ? (
              <>
                <span>{t('chat.collabWatching', { name: collab.watchingName })}</span>
                <button
                  type="button"
                  onClick={collab.onTakeTurn}
                  className="rounded-md bg-accent/15 px-2.5 py-1 text-xs font-medium text-accent-text hover:bg-accent/25"
                >
                  {t('chat.collabTakeTurn')}
                </button>
              </>
            ) : null}
            {collab.statusLine ? (
              <span className="text-xs text-text-muted">{collab.statusLine}</span>
            ) : null}
          </div>
        </Banner>
      ) : null}
    </>
  );
}
