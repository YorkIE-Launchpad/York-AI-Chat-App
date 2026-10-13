import { Radar } from 'lucide-react';
import { alwaysEligible } from '../eligibility';
import type { TipDefinition } from '../types';
import { AskMatterTip } from './AskMatterTip';

export const askMatterTip: TipDefinition = {
  id: 'ask-matter',
  storageKey: 'tip-ask-matter-seen-v1',
  category: 'day',
  defaultSeen: true,
  icon: Radar,
  titleKey: 'tips.askMatter.title',
  summaryKey: 'tips.askMatter.summary',
  isEligible: alwaysEligible,
  View: AskMatterTip,
};
