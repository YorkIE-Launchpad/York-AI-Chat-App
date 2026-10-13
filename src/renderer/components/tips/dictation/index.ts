import { Mic } from 'lucide-react';
import { alwaysEligible } from '../eligibility';
import type { TipDefinition } from '../types';
import { DictationTip } from './DictationTip';

export const dictationTip: TipDefinition = {
  id: 'dictation',
  storageKey: 'tip-dictation-seen-v1',
  category: 'chat',
  defaultSeen: true,
  icon: Mic,
  titleKey: 'tips.dictation.title',
  summaryKey: 'tips.dictation.summary',
  isEligible: alwaysEligible,
  View: DictationTip,
};
