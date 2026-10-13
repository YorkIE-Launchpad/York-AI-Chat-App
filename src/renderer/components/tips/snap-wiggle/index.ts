import { MousePointer2 } from 'lucide-react';
import type { TipDefinition } from '../types';
import { SnapWiggleTip } from './SnapWiggleTip';

export const snapWiggleTip: TipDefinition = {
  id: 'snap-wiggle',
  storageKey: 'snap-wiggle-tip-seen-v2',
  icon: MousePointer2,
  titleKey: 'tips.snapWiggle.title',
  summaryKey: 'tips.snapWiggle.summary',
  isEligible: async () => {
    const snapApi = window.electronAPI?.snap;
    if (!snapApi) return false;
    const [shortcut, wiggle] = await Promise.all([snapApi.getShortcut(), snapApi.getWiggle()]);
    return shortcut.supported && wiggle.enabled;
  },
  View: SnapWiggleTip,
};
