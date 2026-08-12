import { getInitialSessionTitle } from './session-title';

/** Sidebar / session title for a Matter-linked chat. */
export function buildMatterSessionTitle(itemTitle?: string | null): string {
  const label = itemTitle?.trim();
  return getInitialSessionTitle(label ? `Matter · ${label}` : 'Matter');
}

export interface MatterChatContextSummary {
  title: string;
  summary: string;
  whyItMatters: string;
  suggestedAction: string | null;
  sourceLabel?: string | null;
  url?: string | null;
}

export interface MatterChatDraft {
  itemIds: string[];
  composerPrefill: string;
  contextSummary: MatterChatContextSummary;
}
