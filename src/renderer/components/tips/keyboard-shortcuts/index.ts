import { Command } from 'lucide-react';
import { alwaysEligible } from '../eligibility';
import type { TipDefinition } from '../types';
import { KeyboardShortcutsTip } from './KeyboardShortcutsTip';

export const keyboardShortcutsTip: TipDefinition = {
  id: 'keyboard-shortcuts',
  storageKey: 'tip-keyboard-shortcuts-seen-v1',
  category: 'navigate',
  defaultSeen: true,
  icon: Command,
  titleKey: 'tips.keyboardShortcuts.title',
  summaryKey: 'tips.keyboardShortcuts.summary',
  isEligible: alwaysEligible,
  View: KeyboardShortcutsTip,
};
