import { ImageIcon } from 'lucide-react';
import { alwaysEligible } from '../eligibility';
import type { TipDefinition } from '../types';
import { ImageModeTip } from './ImageModeTip';

export const imageModeTip: TipDefinition = {
  id: 'image-mode',
  storageKey: 'tip-image-mode-seen-v1',
  category: 'chat',
  defaultSeen: true,
  icon: ImageIcon,
  titleKey: 'tips.imageMode.title',
  summaryKey: 'tips.imageMode.summary',
  isEligible: alwaysEligible,
  View: ImageModeTip,
};
