import { Search } from 'lucide-react';
import { alwaysEligible } from '../eligibility';
import type { TipDefinition } from '../types';
import { CommandPaletteTip } from './CommandPaletteTip';

export const commandPaletteTip: TipDefinition = {
  id: 'command-palette',
  storageKey: 'tip-command-palette-seen-v1',
  category: 'navigate',
  defaultSeen: true,
  icon: Search,
  titleKey: 'tips.commandPalette.title',
  summaryKey: 'tips.commandPalette.summary',
  isEligible: alwaysEligible,
  View: CommandPaletteTip,
};
