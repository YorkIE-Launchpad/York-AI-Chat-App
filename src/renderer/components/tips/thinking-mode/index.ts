import { Brain } from 'lucide-react';
import { alwaysEligible } from '../eligibility';
import type { TipDefinition } from '../types';
import { ThinkingModeTip } from './ThinkingModeTip';

export const thinkingModeTip: TipDefinition = {
  id: 'thinking-mode',
  storageKey: 'tip-thinking-mode-seen-v1',
  category: 'chat',
  defaultSeen: true,
  icon: Brain,
  titleKey: 'tips.thinkingMode.title',
  summaryKey: 'tips.thinkingMode.summary',
  isEligible: alwaysEligible,
  View: ThinkingModeTip,
};
