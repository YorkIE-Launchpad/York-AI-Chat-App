import { Workflow } from 'lucide-react';
import { alwaysEligible } from '../eligibility';
import type { TipDefinition } from '../types';
import { AutomationsTip } from './AutomationsTip';

export const automationsTip: TipDefinition = {
  id: 'automations',
  storageKey: 'tip-automations-seen-v1',
  category: 'meetingsAutomation',
  defaultSeen: true,
  icon: Workflow,
  titleKey: 'tips.automations.title',
  summaryKey: 'tips.automations.summary',
  isEligible: alwaysEligible,
  View: AutomationsTip,
};
