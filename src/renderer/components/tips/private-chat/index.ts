import { EyeOff } from 'lucide-react';
import { alwaysEligible } from '../eligibility';
import type { TipDefinition } from '../types';
import { PrivateChatTip } from './PrivateChatTip';

export const privateChatTip: TipDefinition = {
  id: 'private-chat',
  storageKey: 'tip-private-chat-seen-v1',
  category: 'chat',
  defaultSeen: true,
  icon: EyeOff,
  titleKey: 'tips.privateChat.title',
  summaryKey: 'tips.privateChat.summary',
  isEligible: alwaysEligible,
  View: PrivateChatTip,
};
