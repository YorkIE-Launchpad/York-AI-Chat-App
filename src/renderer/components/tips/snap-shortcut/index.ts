import { Keyboard } from 'lucide-react';
import { isSnapSupported } from '../eligibility';
import type { TipDefinition } from '../types';
import { SnapShortcutTip } from './SnapShortcutTip';

export const snapShortcutTip: TipDefinition = {
  id: 'snap-shortcut',
  storageKey: 'tip-snap-shortcut-seen-v1',
  category: 'anywhere',
  defaultSeen: true,
  icon: Keyboard,
  titleKey: 'tips.snapShortcut.title',
  summaryKey: 'tips.snapShortcut.summary',
  isEligible: isSnapSupported,
  View: SnapShortcutTip,
};
