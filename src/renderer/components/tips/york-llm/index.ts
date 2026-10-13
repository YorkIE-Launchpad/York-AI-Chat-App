import { BadgeDollarSign } from 'lucide-react';
import { alwaysEligible } from '../eligibility';
import type { TipDefinition } from '../types';
import { YorkLlmTip } from './YorkLlmTip';

export const yorkLlmTip: TipDefinition = {
  id: 'york-llm',
  storageKey: 'tip-york-llm-seen-v1',
  category: 'chat',
  defaultSeen: true,
  icon: BadgeDollarSign,
  titleKey: 'tips.yorkLlm.title',
  summaryKey: 'tips.yorkLlm.summary',
  isEligible: alwaysEligible,
  View: YorkLlmTip,
};
