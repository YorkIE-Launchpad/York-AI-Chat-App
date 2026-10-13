import { useEffect, useState } from 'react';
import { TIPS } from './registry';
import { isTipSeen, markTipSeen } from './tip-storage';

interface TipsHostProps {
  /** Hold tips back while another first-launch surface (e.g. What's New) is open. */
  suppressed?: boolean;
}

/** Shows unseen, eligible tips one at a time on launch. */
export function TipsHost({ suppressed = false }: TipsHostProps) {
  const [index, setIndex] = useState(0);
  const [ready, setReady] = useState(false);
  const tip = TIPS[index];

  useEffect(() => {
    if (!tip) return;
    if (isTipSeen(tip.storageKey, tip.defaultSeen)) {
      setIndex((i) => i + 1);
      return;
    }
    let cancelled = false;
    void tip
      .isEligible()
      .catch(() => false)
      .then((eligible) => {
        if (cancelled) return;
        if (eligible) setReady(true);
        else setIndex((i) => i + 1);
      });
    return () => {
      cancelled = true;
    };
  }, [tip]);

  if (!tip || !ready || suppressed) return null;

  const dismiss = () => {
    markTipSeen(tip.storageKey);
    setReady(false);
    setIndex((i) => i + 1);
  };

  return <tip.View onDismiss={dismiss} />;
}
