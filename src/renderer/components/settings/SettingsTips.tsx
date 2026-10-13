import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Play, Search } from 'lucide-react';
import { TIPS, TIP_CATEGORIES, isTipSeen, markTipSeen, type TipDefinition } from '../tips';

/** Settings → Tips: every tip grouped by category, openable on demand regardless of its seen flag. */
export function SettingsTips() {
  const { t } = useTranslation();
  const [openTip, setOpenTip] = useState<TipDefinition | null>(null);
  const [seen, setSeen] = useState(
    () =>
      new Set(TIPS.filter((tip) => isTipSeen(tip.storageKey, tip.defaultSeen)).map((tip) => tip.id))
  );
  const [unavailable, setUnavailable] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (tip: TipDefinition) => {
    if (terms.length === 0) return true;
    const haystack = [t(tip.titleKey), t(tip.summaryKey), t(`tips.categories.${tip.category}`)]
      .join(' ')
      .toLowerCase();
    return terms.every((term) => haystack.includes(term));
  };
  const visibleTips = TIPS.filter(matches);

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
    <div className="space-y-6">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('tips.searchPlaceholder')}
          aria-label={t('tips.searchPlaceholder')}
          className="w-full rounded-lg border border-border bg-surface py-2 pl-9 pr-3 text-sm text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
        />
      </div>
      {visibleTips.length === 0 && (
        <p className="py-6 text-center text-sm text-text-muted">
          {t('tips.searchEmpty', { query: query.trim() })}
        </p>
      )}
      {TIP_CATEGORIES.map((category) => {
        const tips = visibleTips.filter((tip) => tip.category === category);
        if (tips.length === 0) return null;
        return (
          <section key={category} className="space-y-2">
            <h4 className="text-[11px] font-bold uppercase tracking-[0.05em] text-text-muted">
              {t(`tips.categories.${category}`)}
            </h4>
            {tips.map((tip) => (
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
                  <span className="mt-0.5 block text-xs text-text-secondary">
                    {t(tip.summaryKey)}
                  </span>
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
          </section>
        );
      })}
      {openTip && <openTip.View onDismiss={closeTip} />}
    </div>
  );
}
