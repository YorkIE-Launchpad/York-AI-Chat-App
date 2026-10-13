import { ListChecks } from 'lucide-react';
import { alwaysEligible } from '../eligibility';
import type { TipDefinition } from '../types';
import { FollowUpsTip } from './FollowUpsTip';

export const followUpsTip: TipDefinition = {
  id: 'follow-ups',
  storageKey: 'tip-follow-ups-seen-v1',
  category: 'day',
  defaultSeen: true,
  icon: ListChecks,
  titleKey: 'tips.followUps.title',
  summaryKey: 'tips.followUps.summary',
  isEligible: alwaysEligible,
  View: FollowUpsTip,
};
