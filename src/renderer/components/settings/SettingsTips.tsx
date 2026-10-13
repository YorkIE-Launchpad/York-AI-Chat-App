import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Play } from 'lucide-react';
import { TIPS, isTipSeen, markTipSeen, type TipDefinition } from '../tips';

/** Settings → Tips: every tip, openable on demand regardless of its seen flag. */
export function SettingsTips() {
  const { t } = useTranslation();
  const [openTip, setOpenTip] = useState<TipDefinition | null>(null);
  const [seen, setSeen] = useState(
    () => new Set(TIPS.filter((tip) => isTipSeen(tip.storageKey)).map((tip) => tip.id))
  );
  const [unavailable, setUnavailable] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      TIPS.map((tip) =>
        tip
          .isEligible()
          .catch(() => false)
          .then((eligible) => (eligible ? null : tip.id))
      )
    ).then((ids) => {
      if (!cancelled) setUnavailable(new Set(ids.filter((id): id is string => id !== null)));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const closeTip = () => {
    if (!openTip) return;
    markTipSeen(openTip.storageKey);
    setSeen((prev) => new Set(prev).add(openTip.id));
    setOpenTip(null);
  };

  return (
    <div className="space-y-2">
      {TIPS.map((tip) => (
        <button
          key={tip.id}
          type="button"
          onClick={() => setOpenTip(tip)}
          className="group flex w-full items-center gap-3 rounded-xl border border-border bg-surface px-4 py-3 text-left transition-colors hover:border-accent/50"
        >
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-muted">
            <tip.icon className="h-4 w-4 text-accent" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2 text-sm font-medium text-text-primary">
              {t(tip.titleKey)}
              {!seen.has(tip.id) && (
                <span className="rounded-full bg-accent px-1.5 py-px text-[10px] font-semibold text-white">
                  {t('tips.new')}
                </span>
              )}
            </span>
            <span className="mt-0.5 block text-xs text-text-secondary">{t(tip.summaryKey)}</span>
            {unavailable.has(tip.id) && (
              <span className="mt-0.5 block text-[11px] text-text-muted">
                {t('tips.unavailable')}
              </span>
            )}
          </span>
          <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-text-secondary group-hover:text-accent">
            <Play className="h-3 w-3" />
            {t('tips.show')}
          </span>
        </button>
      ))}
      {openTip && <openTip.View onDismiss={closeTip} />}
    </div>
  );
}
