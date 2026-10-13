import { TrendingUp } from 'lucide-react';
import { alwaysEligible } from '../eligibility';
import type { TipDefinition } from '../types';
import { OpportunitiesTip } from './OpportunitiesTip';

export const opportunitiesTip: TipDefinition = {
  id: 'opportunities',
  storageKey: 'tip-opportunities-seen-v1',
  category: 'day',
  defaultSeen: true,
  icon: TrendingUp,
  titleKey: 'tips.opportunities.title',
  summaryKey: 'tips.opportunities.summary',
  isEligible: alwaysEligible,
  View: OpportunitiesTip,
};
