import { AudioLines } from 'lucide-react';
import { alwaysEligible } from '../eligibility';
import type { TipDefinition } from '../types';
import { MeetingsTip } from './MeetingsTip';

export const meetingsTip: TipDefinition = {
  id: 'meetings',
  storageKey: 'tip-meetings-seen-v1',
  category: 'meetingsAutomation',
  defaultSeen: true,
  icon: AudioLines,
  titleKey: 'tips.meetings.title',
  summaryKey: 'tips.meetings.summary',
  isEligible: alwaysEligible,
  View: MeetingsTip,
};
