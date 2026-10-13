import { Slash } from 'lucide-react';
import { alwaysEligible } from '../eligibility';
import type { TipDefinition } from '../types';
import { SlashSkillsTip } from './SlashSkillsTip';

export const slashSkillsTip: TipDefinition = {
  id: 'slash-skills',
  storageKey: 'tip-slash-skills-seen-v1',
  category: 'chat',
  defaultSeen: true,
  icon: Slash,
  titleKey: 'tips.slashSkills.title',
  summaryKey: 'tips.slashSkills.summary',
  isEligible: alwaysEligible,
  View: SlashSkillsTip,
};
