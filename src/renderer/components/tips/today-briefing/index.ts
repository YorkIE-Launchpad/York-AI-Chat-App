import { CalendarCheck } from 'lucide-react';
import { alwaysEligible } from '../eligibility';
import type { TipDefinition } from '../types';
import { TodayBriefingTip } from './TodayBriefingTip';

export const todayBriefingTip: TipDefinition = {
  id: 'today-briefing',
  storageKey: 'tip-today-briefing-seen-v1',
  category: 'day',
  defaultSeen: true,
  icon: CalendarCheck,
  titleKey: 'tips.todayBriefing.title',
  summaryKey: 'tips.todayBriefing.summary',
  isEligible: alwaysEligible,
  View: TodayBriefingTip,
};
