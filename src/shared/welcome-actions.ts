/**
 * Shared types for dynamic welcome quick-action chips.
 */

export const WELCOME_ACTION_ICONS = [
  'FileText',
  'BarChart3',
  'FolderOpen',
  'Mail',
  'BookOpen',
  'FileSearch',
  'Users',
  'Briefcase',
  'Rocket',
  'Calendar',
  'ClipboardList',
  'Target',
  'Presentation',
  'Search',
] as const;

export type WelcomeActionIcon = (typeof WELCOME_ACTION_ICONS)[number];

export interface WelcomeQuickAction {
  id: string;
  label: string;
  prompt: string;
  icon: WelcomeActionIcon;
  /** MCP server id when the action benefits from a specific connector. */
  requiresConnectorId?: string | null;
  /** Display name for badge (filled by main when requiresConnectorId is set). */
  requiresConnectorName?: string | null;
}

export interface WelcomeProfile {
  email: string;
  name: string;
  title?: string | null;
  functionName?: string | null;
  squad?: string | null;
  department?: string | null;
}

export interface WelcomeConnectorSnapshot {
  id: string;
  name: string;
  enabled: boolean;
  status: 'connecting' | 'connected' | 'failed' | 'disabled';
  toolCount: number;
}

export type WelcomeActionsSource = 'cache' | 'generated' | 'fallback';

/** Default welcome tagline when generation fails or profile is unknown. */
export const DEFAULT_WELCOME_TAGLINE = "Deal flow, diligence, or portfolio — what's next?";

export interface WelcomeQuickActionsResponse {
  chips: WelcomeQuickAction[];
  /** Personalized one-line welcome subtitle. */
  tagline: string;
  source: WelcomeActionsSource;
  profileSummary?: string | null;
  connectorFingerprint: string;
}

export function isWelcomeActionIcon(value: unknown): value is WelcomeActionIcon {
  return typeof value === 'string' && (WELCOME_ACTION_ICONS as readonly string[]).includes(value);
}

/** Sorted enabled server ids — regenerate chips when this changes. */
export function buildConnectorFingerprint(
  connectors: Array<Pick<WelcomeConnectorSnapshot, 'id' | 'enabled'>>
): string {
  return connectors
    .filter((c) => c.enabled)
    .map((c) => c.id)
    .sort()
    .join('|');
}

export function formatWelcomeProfileSummary(profile: WelcomeProfile): string {
  const parts = [
    profile.name,
    profile.email,
    profile.title,
    profile.functionName,
    profile.squad,
    profile.department,
  ].filter((p): p is string => typeof p === 'string' && p.trim().length > 0);
  return parts.join(' · ');
}
