import type { ComponentType } from 'react';
import type { LucideIcon } from 'lucide-react';

export interface TipViewProps {
  onDismiss: () => void;
}

/** Settings → Tips section a tip is listed under (label: `tips.categories.<id>`). */
export type TipCategory = 'anywhere' | 'navigate' | 'chat' | 'day' | 'meetingsAutomation';

export const TIP_CATEGORIES: TipCategory[] = [
  'anywhere',
  'navigate',
  'chat',
  'day',
  'meetingsAutomation',
];

export interface TipDefinition {
  id: string;
  /** localStorage "seen" flag. Bump the version suffix to re-show the tip to everyone. */
  storageKey: string;
  category: TipCategory;
  /** Treat the tip as already seen until it is opened, so it never pops up on launch. */
  defaultSeen?: boolean;
  icon: LucideIcon;
  /** i18n keys for the Settings → Tips list. */
  titleKey: string;
  summaryKey: string;
  /** Whether the tip applies on this machine (platform, feature enabled, …). */
  isEligible: () => Promise<boolean>;
  View: ComponentType<TipViewProps>;
}
