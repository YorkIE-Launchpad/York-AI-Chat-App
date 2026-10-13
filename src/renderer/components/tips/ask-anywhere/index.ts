import { Sparkles } from 'lucide-react';
import { alwaysEligible } from '../eligibility';
import type { TipDefinition } from '../types';
import { AskAnywhereTip } from './AskAnywhereTip';

export const askAnywhereTip: TipDefinition = {
  id: 'ask-anywhere',
  storageKey: 'tip-ask-anywhere-seen-v1',
  category: 'anywhere',
  defaultSeen: true,
  icon: Sparkles,
  titleKey: 'tips.askAnywhere.title',
  summaryKey: 'tips.askAnywhere.summary',
  isEligible: alwaysEligible,
  View: AskAnywhereTip,
};
