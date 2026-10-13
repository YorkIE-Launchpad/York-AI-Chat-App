import { BrainCircuit } from 'lucide-react';
import { alwaysEligible } from '../eligibility';
import type { TipDefinition } from '../types';
import { MemoryTip } from './MemoryTip';

export const memoryTip: TipDefinition = {
  id: 'memory',
  storageKey: 'tip-memory-seen-v1',
  category: 'meetingsAutomation',
  defaultSeen: true,
  icon: BrainCircuit,
  titleKey: 'tips.memory.title',
  summaryKey: 'tips.memory.summary',
  isEligible: alwaysEligible,
  View: MemoryTip,
};
