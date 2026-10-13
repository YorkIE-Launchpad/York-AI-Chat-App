import type { ComponentType } from 'react';
import type { LucideIcon } from 'lucide-react';

export interface TipViewProps {
  onDismiss: () => void;
}

export interface TipDefinition {
  id: string;
  /** localStorage "seen" flag. Bump the version suffix to re-show the tip to everyone. */
  storageKey: string;
  icon: LucideIcon;
  /** i18n keys for the Settings → Tips list. */
  titleKey: string;
  summaryKey: string;
  /** Whether the tip applies on this machine (platform, feature enabled, …). */
  isEligible: () => Promise<boolean>;
  View: ComponentType<TipViewProps>;
}
